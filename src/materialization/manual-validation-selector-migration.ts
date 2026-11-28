import { getTaskModeRuleSectionMigrations } from './rule-contracts';
import { getRuleContractSnippetAlternatives } from './rule-contract-snippets';
import { readMarkedRuleSections } from './rule-sections';

export const SELECTOR_HEADING = '### Manual Validation Evidence Selector';
export const SELECTOR_INSERTION_HEADING = '## Project Commands (Required)';
const PRECEDING_HEADING = '### Manual Validation Logs';
const SELECTOR_ID = 'manual-validation-evidence-selector';

type SelectorPlan =
    | { status: 'not-needed' }
    | { status: 'insert'; content: string }
    | { status: 'blocked'; reason: string };

interface Heading { text: string; index: number; level: number }

function markdownHeadings(content: string): Heading[] {
    const headings: Heading[] = [];
    let fence: string | null = null;
    let comment = false;
    for (const match of content.matchAll(/[^\r\n]*(?:\r\n|\n|$)/gu)) {
        let line = match[0].replace(/\r?\n$/u, '');
        if (comment) {
            const end = line.indexOf('-->');
            if (end < 0) continue;
            comment = false;
            line = line.slice(end + 3);
        }
        if (!fence) {
            const start = line.indexOf('<!--');
            if (start >= 0) {
                const end = line.indexOf('-->', start + 4);
                if (end < 0) comment = true;
                line = line.slice(0, start);
            }
        }
        const delimiter: string | undefined = (fence ? /^ {0,3}(`{3,}|~{3,})[ \t]*$/u : /^ {0,3}(`{3,}|~{3,})/u).exec(line)?.[1];
        if (delimiter) {
            if (!fence) fence = delimiter;
            else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = null;
            continue;
        }
        if (fence) continue;
        const heading = /^(#{1,6})[ \t]+(.+?)[ \t]*$/u.exec(line);
        if (heading) headings.push({ text: `${heading[1]} ${heading[2]}`, index: match.index, level: heading[1].length });
    }
    return headings;
}

/** Plans a byte-preserving insertion; a blocked plan never rewrites the live file. */
export function planManualValidationSelector(live: string | Buffer, template: string): SelectorPlan {
    if (!template.includes(SELECTOR_HEADING)) return { status: 'not-needed' };
    const content = Buffer.isBuffer(live) ? live.toString('utf8') : live;
    const markedSections = readMarkedRuleSections(content);
    // Managed sections are refreshed from the template, even when their old contract is incomplete.
    if (markedSections?.some(section => section.id === SELECTOR_ID)) return { status: 'not-needed' };
    const headings = markdownHeadings(content);
    const selectors = headings.filter(heading => heading.text === SELECTOR_HEADING);
    if (selectors.length > 1) return { status: 'blocked', reason: 'duplicate selector headings' };
    if (selectors.length === 1) {
        const selector = selectors[0];
        const firstLiteral = /^### Manual Validation Evidence Selector[ \t]*\r?$/mu.exec(content);
        if (!firstLiteral || firstLiteral.index !== selector.index) {
            return { status: 'blocked', reason: 'a misleading selector heading appears before the managed section' };
        }
        const afterHeading = selector.index + firstLiteral[0].length;
        const next = /^#{1,3}\s+/mu.exec(content.slice(afterHeading));
        const end = next ? afterHeading + next.index : content.length;
        const section = content.slice(selector.index, end);
        const contract = getTaskModeRuleSectionMigrations().find(migration => migration.heading === SELECTOR_HEADING);
        if (contract && contract.requiredSnippets.every(snippet =>
            getRuleContractSnippetAlternatives(snippet).some(candidate => section.includes(candidate)))) {
            return { status: 'not-needed' };
        }
        return { status: 'blocked', reason: 'the existing selector is incomplete' };
    }
    if (Buffer.isBuffer(live) && !Buffer.from(content, 'utf8').equals(live)) {
        return { status: 'blocked', reason: 'the file contains invalid UTF-8' };
    }
    const anchors = headings.filter(heading => heading.text === SELECTOR_INSERTION_HEADING);
    const preceding = headings.filter(heading => heading.text === PRECEDING_HEADING);
    if (anchors.length !== 1 || preceding.length !== 1 || preceding[0].index >= anchors[0].index) {
        // The normal marked-section refresh can restore missing sections without a legacy anchor.
        if (markedSections?.length) return { status: 'not-needed' };
        return { status: 'blocked', reason: 'the insertion point is missing or ambiguous' };
    }
    // VERIFY scans literal headings, including fenced text. Do not insert after a misleading earlier heading.
    if (/^### Manual Validation Evidence Selector[ \t]*\r?$/mu.test(content.slice(0, anchors[0].index))) {
        return { status: 'blocked', reason: 'a selector heading appears before the insertion point inside other text' };
    }
    const templateSections = readMarkedRuleSections(template);
    const managed = templateSections?.find(section => section.id === SELECTOR_ID);
    const contract = getTaskModeRuleSectionMigrations().find(migration => migration.heading === SELECTOR_HEADING);
    if (!managed || !managed.body.includes(SELECTOR_HEADING) || !contract || !contract.requiredSnippets.every(snippet =>
        getRuleContractSnippetAlternatives(snippet).some(candidate => managed.body.includes(candidate)))) {
        return { status: 'blocked', reason: 'the managed selector section is unavailable in the update template' };
    }
    if (markedSections === null) return { status: 'blocked', reason: 'malformed or duplicate ownership markers' };
    const anchor = anchors[0].index;
    const containingSection = markedSections.find(section => section.index <= anchor && anchor < section.index + section.raw.length);
    const insertion = containingSection?.index ?? anchor;
    return { status: 'insert', content: content.slice(0, insertion) + managed.raw + content.slice(insertion) };
}
