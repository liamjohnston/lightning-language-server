import AuraIndexer from '../aura-indexer/indexer';
import {
    TagInfo,
    AttributeInfo,
    IHTMLTagProvider,
    ICompletionParticipant,
    HtmlContentContext,
    HtmlAttributeValueContext,
} from '@salesforce/lightning-lsp-common';
import { Decorator } from '@salesforce/lightning-lsp-common/lib/indexer/attributeInfo';

let indexer: AuraIndexer;

function getAuraTags(): Map<string, TagInfo> {
    if (indexer) {
        return indexer.getAuraTags();
    }
    return new Map();
}
function getAuraByTag(tag: string): TagInfo {
    if (indexer) {
        return indexer.getAuraByTag(tag);
    }
    return undefined;
}

export function setIndexer(idx: AuraIndexer) {
    indexer = idx;
}

export function getAuraCompletionParticipant(): ICompletionParticipant {
    return {
        onHtmlAttributeValue: (context: HtmlAttributeValueContext): void => {
            return;
        },
        onHtmlContent: (context: HtmlContentContext): void => {
            return;
        },
    };
}

export function getAuraTagProvider(): IHTMLTagProvider {
    function addTags(collector: (tag: string, label: string, info: TagInfo) => void) {
        for (const [tag, tagInfo] of getAuraTags()) {
            collector(tag, tagInfo.getHover(), tagInfo);
        }
    }

    function addAttributes(tag: string, collector: (attribute: string, info: AttributeInfo, type?: string) => void) {
        const cTag = getAuraByTag(tag);
        if (cTag) {
            for (const info of cTag.attributes) {
                collector(info.name, info, info.type);
            }
        }
    }

    function addExpressions(templateTag: string, collector: (attribute: string, info: AttributeInfo, type: string) => void) {
        const cTag = getAuraByTag(templateTag);
        if (cTag) {
            cTag.attributes.forEach(attribute => {
                collector(attribute.name, null, null);
            });
            // cTag.methods.forEach(metadata => {
            //     collector(metadata.name, null, null);
            // });
        }
    }

    return {
        getId: () => 'aura',
        isApplicable: languageId => languageId === 'html',
        collectTags: (collector: (tag: string, label: string, info: TagInfo) => void) => {
            addTags(collector);
        },
        collectAttributes: (tag: string, collector: (attribute: string, info: AttributeInfo, type?: string) => void) => {
            if (tag) {
                addAttributes(tag, collector);
            }
        },
        collectValues: (/*tag: string, attribute: string, collector: (value: string) => void*/) => {
            // TODO provide suggestions by consulting shapeService
        },

        // TODO move this to ICompletionParticipant
        collectExpressionValues: (templateTag: string, collector: (value: string) => void): void => {
            addExpressions(templateTag, collector);
        },
        getTagInfo: (tag: string) => getAuraByTag(tag),
        getGlobalAttributes: () => [],
    };
}
