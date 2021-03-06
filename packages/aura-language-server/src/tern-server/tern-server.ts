import fs from 'fs';
import * as tern from '../tern/lib/tern';
import path from 'path';
import * as util from 'util';
import * as infer from '../tern/lib/infer';
import LineColumnFinder from 'line-column';
import { findPreviousWord, findPreviousLeftParan, countPreviousCommas } from './string-util';
import { readFileSync, readdirSync, statSync } from 'fs';
import URI from 'vscode-uri';

import { memoize } from '@salesforce/lightning-lsp-common/lib/utils';
import {
    TextDocumentPositionParams,
    CompletionList,
    CompletionItem,
    Hover,
    Location,
    TextDocumentChangeEvent,
    CompletionParams,
    Position,
    Range,
    ReferenceParams,
    SignatureHelp,
    SignatureInformation,
    Definition,
} from 'vscode-languageserver';

// tslint:disable-next-line:no-namespace
interface ITernServer extends tern.Server {
    files: ITernFile[];
    cx: any;
    normalizeFilename(file: string): string;
    /**
     * Register a file with the server. Note that files can also be included in requests. When using this
     * to automatically load a dependency, specify the name of the file (as Tern knows it) as the third
     * argument. That way, the file is counted towards the dependency budget of the root of its dependency graph.
     */
    addFile(name: string, text?: string, parent?: string): void;
    /** Unregister a file. */
    delFile(name: string): void;
    /** Forces all files to be fetched an analyzed, and then calls the callback function. */
    flush(callback: () => void): void;
    /**
     * Perform a request. `doc` is a (parsed) JSON document as described in the protocol documentation.
     * The `callback` function will be called when the request completes. If an `error` occurred,
     * it will be passed as a first argument. Otherwise, the `response` (parsed) JSON object will be passed as second argument.
     *
     * When the server hasn’t been configured to be asynchronous, the callback will be called before request returns.
     */
    request(doc: any, callback: any): void;
}
interface ITernFile {
    name: string;
    text: string;
}

let theRootPath: string;
let ternServer: ITernServer;
let asyncTernRequest;
let asyncFlush;

const defaultLibs = ['browser', 'ecmascript'];
const defaultPlugins = { modules: {}, aura: {}, doc_comment: {} };

const defaultConfig = {
    ecmaVersion: 6,
    stripCRs: false,
    disableLoadingLocal: true,
    verbose: true,
    debug: true,
    async: true,
    dependencyBudget: 20000,
};

function readJSON(fileName) {
    const file = fs.readFileSync(fileName, 'utf-8');
    try {
        return JSON.parse(file);
    } catch (e) {
        console.warn('Bad JSON in ' + fileName + ': ' + e.message);
    }
}

function findDefs(libs) {
    const ternlibpath = require.resolve('../tern/lib/tern');
    const ternbasedir = path.join(ternlibpath, '..', '..');

    const defs = [];
    const src = libs.slice();
    for (let file of src) {
        console.log(`Loading support library: ${file}`);
        if (!/\.json$/.test(file)) {
            file = file + '.json';
        }
        const def = path.join(ternbasedir, 'defs', file);
        if (fs.existsSync(def)) {
            defs.push(readJSON(def));
        } else {
            console.log(`Not found: ${file}`);
        }
    }
    return defs;
}

async function loadPlugins(plugins, rootPath) {
    const options = {};
    for (const plugin of Object.keys(plugins)) {
        const val = plugins[plugin];
        if (!val) {
            continue;
        }

        if (!(await loadLocal(plugin, rootPath))) {
            if (!(await loadBuiltIn(plugin, rootPath))) {
                process.stderr.write('Failed to find plugin ' + plugin + '.\n');
            }
        }

        options[path.basename(plugin)] = true;
    }

    return options;
}

async function loadLocal(plugin, rootPath) {
    let found;
    try {
        // local resolution only here
        found = require.resolve('./tern-' + plugin);
    } catch (e) {
        return false;
    }

    const mod = await import(found);
    if (mod.hasOwnProperty('initialize')) {
        mod.initialize(rootPath);
    }
    return true;
}

async function loadBuiltIn(plugin: string, rootPath: string) {
    const ternlibpath = require.resolve('../tern/lib/tern');
    const ternbasedir = path.join(ternlibpath, '..', '..');

    const def = path.join(ternbasedir, 'plugin', plugin);

    let found: string;
    try {
        // local resolution only here
        found = require.resolve(def);
    } catch (e) {
        process.stderr.write('Failed to find plugin ' + plugin + '.\n');
        return false;
    }

    const mod = await import(found);
    if (mod.hasOwnProperty('initialize')) {
        mod.initialize(rootPath);
    }
    return true;
}

export async function startServer(rootPath: string, wsroot: string) {
    const defs = findDefs(defaultLibs);
    const plugins = await loadPlugins(defaultPlugins, rootPath);
    const config: tern.ConstructorOptions = {
        ...defaultConfig,
        defs,
        plugins,
        // @ts-ignore 2345
        projectDir: rootPath,
        getFile(filename: string, callback: (error: Error | undefined, content?: string) => void): void {
            // note: this isn't invoked
            fs.readFile(path.resolve(rootPath, filename), 'utf8', callback);
        },
    };
    theRootPath = wsroot;
    ternServer = new tern.Server(config) as ITernServer;
    asyncTernRequest = util.promisify(ternServer.request.bind(ternServer));
    asyncFlush = util.promisify(ternServer.flush.bind(ternServer));

    init();

    return ternServer;
}

function lsp2ternPos({ line, character }: { line: number; character: number }): tern.Position {
    return { line, ch: character };
}

function tern2lspPos({ line, ch }: { line: number; ch: number }): Position {
    return { line, character: ch };
}

function tern2lspLocation({ file, start, end }: { file: string; start: tern.Position; end: tern.Position }): Location {
    return {
        uri: fileToUri(file),
        range: tern2lspRange({ start, end }),
    };
}

function tern2lspRange({ start, end }: { start: tern.Position; end: tern.Position }): Range {
    return {
        start: tern2lspPos(start),
        end: tern2lspPos(end),
    };
}

function uriToFile(uri: string): string {
    return URI.parse(uri).fsPath;
}

function fileToUri(file: string): string {
    if (path.isAbsolute(file)) {
        return URI.file(file).toString();
    } else {
        return URI.file(path.join(theRootPath, file)).toString();
    }
}

async function ternRequest(event: TextDocumentPositionParams, type: string, options: any = {}) {
    return await asyncTernRequest({
        query: {
            type,
            file: uriToFile(event.textDocument.uri),
            end: lsp2ternPos(event.position),
            lineCharPositions: true,
            ...options,
        },
    });
}

function* walkSync(dir: string) {
    const files = readdirSync(dir);

    for (const file of files) {
        const pathToFile = path.join(dir, file);
        const isDirectory = statSync(pathToFile).isDirectory();
        if (isDirectory) {
            yield* walkSync(pathToFile);
        } else {
            yield pathToFile;
        }
    }
}
async function ternInit() {
    await asyncTernRequest({
        query: {
            type: 'ideInit',
            unloadDefs: true,
            // shouldFilter: true,
        },
    });
    const resources = path.join(__dirname, '..', '..', 'resources', 'aura');
    const found = [...walkSync(resources)];
    let [lastFile, lastText] = [undefined, undefined];
    for (const file of found) {
        if (file.endsWith('.js')) {
            const data = readFileSync(file, 'utf-8');
            // HACK HACK HACK - glue it all together baby!
            if (file.endsWith('AuraInstance.js')) {
                lastFile = file;
                lastText = data.concat(`\nwindow['$A'] = new AuraInstance();\n`);
            } else {
                ternServer.addFile(file, data);
            }
        }
    }
    ternServer.addFile(lastFile, lastText);
}

const init = memoize(ternInit);

export const addFile = (event: TextDocumentChangeEvent) => {
    const { document } = event;
    ternServer.addFile(uriToFile(document.uri), document.getText());
};

export const delFile = (close: TextDocumentChangeEvent) => {
    const { document } = close;
    ternServer.delFile(uriToFile(document.uri));
};

export const onCompletion = async (completionParams: CompletionParams): Promise<CompletionList> => {
    try {
        await init();
        await asyncFlush();

        const { completions } = await ternRequest(completionParams, 'completions', {
            types: true,
            docs: true,
            depths: true,
            guess: true,
            origins: true,
            urls: true,
            expandWordForward: true,
            caseInsensitive: true,
        });
        const items: CompletionItem[] = completions.map(completion => {
            let kind = 18;
            if (completion.type && completion.type.startsWith('fn')) {
                kind = 3;
            }
            return {
                documentation: completion.doc,
                detail: completion.type,
                label: completion.name,
                kind,
            };
        });
        return {
            isIncomplete: true,
            items,
        };
    } catch (e) {
        if (e.message && e.message.startsWith('No type found')) {
            return;
        }
        return {
            isIncomplete: true,
            items: [],
        };
    }
};

export const onHover = async (textDocumentPosition: TextDocumentPositionParams): Promise<Hover> => {
    try {
        await init();
        await asyncFlush();
        const info = await ternRequest(textDocumentPosition, 'type');

        const out = [];
        out.push(`${info.exprName || info.name}: ${info.type}`);
        if (info.doc) {
            out.push(info.doc);
        }
        if (info.url) {
            out.push(info.url);
        }

        return { contents: out };
    } catch (e) {
        if (e.message && e.message.startsWith('No type found')) {
            return;
        }
    }
};

export const onTypeDefinition = async (textDocumentPosition: TextDocumentPositionParams): Promise<Definition> => {
    const info = await ternRequest(textDocumentPosition, 'type');
    if (info && info.origin) {
        const contents = fs.readFileSync(info.origin, 'utf-8');
        const endCol = new LineColumnFinder(contents, { origin: 0 }).fromIndex(contents.length - 1);
        return {
            uri: fileToUri(info.origin),
            range: {
                start: {
                    line: 0,
                    character: 0,
                },
                end: {
                    line: endCol.line,
                    character: endCol.col,
                },
            },
        };
    }
};

export const onDefinition = async (textDocumentPosition: TextDocumentPositionParams): Promise<Location> => {
    try {
        await init();
        await asyncFlush();
        const { file, start, end, origin } = await ternRequest(textDocumentPosition, 'definition', { preferFunction: false, doc: false });
        if (file) {
            const responseURI = fileToUri(file);
            // check to see if the request position is inside the response object
            const requestURI = textDocumentPosition.textDocument.uri;
            if (
                responseURI === requestURI &&
                start.line === textDocumentPosition.position.line &&
                textDocumentPosition.position.character >= start.ch &&
                textDocumentPosition.position.character <= end.ch
            ) {
                return onTypeDefinition(textDocumentPosition) as any;
            }
            if (file === 'Aura') {
                return;
            } else if (file.indexOf('/resources/aura/') >= 0) {
                const slice = file.slice(file.indexOf('/resources/aura/'));
                const real = path.join(__dirname, '..', '..', slice);
                return {
                    uri: URI.file(real).toString(),
                    range: tern2lspRange({ start, end }),
                };
            }
            return tern2lspLocation({ file, start, end });
        }
    } catch (e) {
        if (e.message && e.message.startsWith('No type found')) {
            return;
        }
    }
};

export const onReferences = async (reference: ReferenceParams): Promise<Location[]> => {
    await init();
    await asyncFlush();
    const { refs } = await ternRequest(reference, 'refs');
    if (refs && refs.length > 0) {
        return refs.map(ref => tern2lspLocation(ref));
    }
};

export const onSignatureHelp = async (signatureParams: TextDocumentPositionParams): Promise<SignatureHelp> => {
    const {
        position,
        textDocument: { uri },
    } = signatureParams;
    try {
        await init();
        await asyncFlush();
        const sp = signatureParams;
        const files = ternServer.files;
        const fileName = ternServer.normalizeFilename(uriToFile(uri));
        const file = files.find(f => f.name === fileName);

        const contents = file.text;

        const offset = new LineColumnFinder(contents, { origin: 0 }).toIndex(position.line, position.character);

        const left = findPreviousLeftParan(contents, offset - 1);
        const word = findPreviousWord(contents, left);

        const info = await asyncTernRequest({
            query: {
                type: 'type',
                file: file.name,
                end: word.start,
                docs: true,
            },
        });

        const commas = countPreviousCommas(contents, offset - 1);
        const cx = ternServer.cx;
        let parsed;
        infer.withContext(cx, () => {
            // @ts-ignore
            const parser = new infer.def.TypeParser(info.type);
            parsed = parser.parseType(true);
        });

        const params = parsed.args.map((arg, index) => {
            const type = arg.getType();
            return {
                label: parsed.argNames[index],
                documentation: type.toString() + '\n' + (type.doc || ''),
            };
        });

        const sig: SignatureInformation = {
            label: parsed.argNames[commas] || 'unknown param',
            documentation: `${info.exprName || info.name}: ${info.doc}`,
            parameters: params,
        };
        const sigs: SignatureHelp = {
            signatures: [sig],
            activeSignature: 0,
            activeParameter: commas,
        };
        return sigs;
    } catch (e) {
        // ignore
    }
};
