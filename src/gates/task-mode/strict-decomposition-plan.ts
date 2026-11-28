import * as fs from 'node:fs';
import * as path from 'node:path';

import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import { parseTaskQueueEntriesFromContent } from '../../core/task-queue-read';
import { readReviewTaskCard } from '../review-context/review-context-task-card';
import { isPathRealpathInsideRoot, normalizePath, stringSha256 } from '../shared/helpers';

export type StrictDecompositionPlanSourceKind = 'task-notes' | 'task-card';
export type StrictDecompositionPlanSourceStatus = 'read' | 'missing' | 'unreadable';

export interface StrictDecompositionPlanSource {
    kind: StrictDecompositionPlanSourceKind;
    path: string | null;
    status: StrictDecompositionPlanSourceStatus;
    sha256: string | null;
}

/** What the approved task card and the TASK.md notes plan for this row, read before a non-split decision. */
export interface StrictDecompositionTaskPlan {
    sources: StrictDecompositionPlanSource[];
    sub_card_plan: boolean;
    planned_child_task_ids: string[];
    task_is_planned_sub_card: boolean;
    file_cap: number | null;
    /** The card or notes say the cap may not be exceeded; a recorded plan revision cannot lift it. */
    file_cap_hard: boolean;
    /** The smallest hard cap; it still applies when a revision lifts a smaller soft cap. Absent in older artifacts. */
    hard_file_cap?: number | null;
    evidence: string[];
}

interface PlanText {
    source: StrictDecompositionPlanSource;
    text: string;
}

interface DetectedFileCap {
    cap: number;
    hard: boolean;
    evidence: string;
}

const MAX_CARD_BYTES = 256 * 1024;
// TASK.md holds every row and real queues exceed the card bound; it gets its own, larger bound.
const MAX_TASK_QUEUE_BYTES = 4 * 1024 * 1024;
const MAX_PLAIN_CARD_REFERENCES = 4;
const MAX_EVIDENCE_ENTRIES = 8;
const NUMBER_WORDS: Readonly<Record<string, number>> = Object.freeze({
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12
});
const COUNT_PATTERN = '(\\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
const LIMIT_WORDS = '(?:a\\s+maximum\\s+of|maximum(?:\\s+of)?|max\\.?|at\\s+most|up\\s+to|no\\s+more\\s+than|cap(?:ped)?\\s+(?:at|of))';
// A count of files is a task cap only when the clause states the task's own scope.
const CHANGE_VERB_CAP_PATTERN = new RegExp(
    `\\b(?:change|changes|changing|touch|touches|modify|modifies|edit|edits)\\s+${LIMIT_WORDS}\\s+${COUNT_PATTERN}\\s+(?:changed\\s+|source\\s+)?files?\\b`, 'giu');
const SCOPED_LIMIT_CAP_PATTERN = new RegExp(`\\b${LIMIT_WORDS}\\s+${COUNT_PATTERN}\\s+(?:changed\\s+|source\\s+)?files?\\b`, 'giu');
const NAMED_CAP_PATTERN = new RegExp(`\\b${COUNT_PATTERN}[-\\s](?:changed[-\\s])?file\\s+(?:cap|limit|budget|maximum)\\b`, 'giu');
const SCOPE_ANCHOR_PATTERN = /^\s*(?:[-*>]|\d+[.)])?\s*(?:\*\*)?\s*(?:scope|file\s+cap|cap|size)\b|\bsub-?cards?\b|\bthis\s+(?:task|row|change)\b|\bper\s+(?:task|sub-?card)\b/iu;
const OTHER_UNIT_SUFFIX_PATTERN = /^\s+per\s+(?!task\b|sub-?card\b)\w+/iu;
const HARD_CAP_PATTERN = /\bhard\s+(?:cap|limit|maximum)\b|\bmust\s+not\s+exceed\b|\bnever\s+(?:more\s+than|exceed)\b|\bstrict(?:ly)?\s+(?:cap|limit|maximum)\b|\bnon-?negotiable\b/iu;
const SUB_CARD_PLAN_PATTERN = /\bsub-?cards?\b|\bone\s+task\s+each\b/iu;
const PLAIN_CARD_REFERENCE_PATTERN = /\bCard:\s*`?([^\s`|;,()]+\.md)\b/giu;
const TASK_ID_TOKEN_PATTERN = /(^|[^A-Za-z0-9-])(T-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)(?=$|[^A-Za-z0-9-])/gu;
const SUB_CARD_LABEL_PATTERN = /^\s*(?:[-*>]|\d+[.)])?\s*(?:\*\*)?\s*T-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*[^:\n]{0,60}:/u;
// What may precede a change verb so that the task itself is its subject: nothing (an instruction), a scope or
// sub-card label, or the task, row, change or work. "The fixture changes at most two files" is not about the task.
const TASK_SUBJECT_PREFIX_PATTERN = /^\s*(?:[-*>]|\d+[.)])?\s*(?:\*\*)?\s*(?:(?:scope|file\s+cap|cap|size)\b[^.:]{0,40}[:,-]\s*|T-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*[^:\n]{0,60}:\s*)?(?:(?:this|the|each|every)\s+(?:task|row|change|work|sub-?card)\s+|it\s+|we\s+)?(?:(?:must|should|shall|will|may|can)\s+(?:only\s+)?)?$/iu;

function parseCount(value: string): number | null {
    const normalized = value.toLowerCase();
    const parsed = /^\d+$/u.test(normalized) ? Number(normalized) : NUMBER_WORDS[normalized];
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Lines and sentences; a semicolon stays inside its clause so a sub-card label keeps its own cap. */
function splitClauses(text: string): string[] {
    return text.split(/\r?\n|(?<=[.!?])\s+(?=[A-Z0-9*])/u).map((clause) => clause.trim()).filter(Boolean);
}

function collectClauseCaps(clause: string): DetectedFileCap[] {
    const hard = HARD_CAP_PATTERN.test(clause);
    const anchored = SCOPE_ANCHOR_PATTERN.test(clause) || SUB_CARD_LABEL_PATTERN.test(clause);
    const caps: DetectedFileCap[] = [];
    const add = (match: RegExpMatchArray) => {
        const after = clause.slice((match.index ?? 0) + match[0].length);
        const cap = parseCount(match[1]);
        if (cap === null || OTHER_UNIT_SUFFIX_PATTERN.test(after)) return;
        caps.push({ cap, hard, evidence: match[0].trim() });
    };
    for (const match of clause.matchAll(CHANGE_VERB_CAP_PATTERN)) {
        if (TASK_SUBJECT_PREFIX_PATTERN.test(clause.slice(0, match.index ?? 0))) add(match);
    }
    for (const match of clause.matchAll(NAMED_CAP_PATTERN)) add(match);
    if (anchored && caps.length === 0) for (const match of clause.matchAll(SCOPED_LIMIT_CAP_PATTERN)) add(match);
    return caps;
}

function collectFileCaps(text: string): DetectedFileCap[] {
    return splitClauses(text).flatMap(collectClauseCaps);
}

function collectTaskIdTokens(text: string): string[] {
    return [...text.matchAll(TASK_ID_TOKEN_PATTERN)].map((match) => match[2]);
}

/** Sub-cards are numbered children: `<task>-<n>`. Artifact names such as `<task>-proposal` are not planned rows. */
function isPlannedChildTaskId(taskId: string, candidate: string): boolean {
    const prefix = `${taskId}-`;
    return candidate.length > prefix.length
        && candidate.toLowerCase().startsWith(prefix.toLowerCase())
        && /^\d+$/u.test(candidate.slice(prefix.length));
}

function isSafeRelativeMarkdownPath(relative: string): boolean {
    const parts = relative.split(/[\\/]/u);
    return /\.md$/iu.test(relative)
        && !path.isAbsolute(relative)
        && !path.win32.isAbsolute(relative)
        && !relative.includes(':')
        && !parts.includes('..')
        && !parts.includes('.git');
}

/**
 * Reads one repository file only when its real path stays inside the repository and its size is bounded.
 * Containment is checked before any size or content read, so a link to an external file is never followed.
 */
export function readContainedBoundedText(repoRoot: string, relative: string, maxBytes: number): { status: StrictDecompositionPlanSourceStatus; text: string } {
    const file = path.resolve(repoRoot, relative);
    try {
        fs.lstatSync(file);
    } catch {
        return { status: 'missing', text: '' };
    }
    try {
        if (!isPathRealpathInsideRoot(file, repoRoot)) return { status: 'unreadable', text: '' };
        // A FIFO or device must never be opened: the real target is checked to be a regular file first.
        const target = fs.realpathSync(file);
        if (!fs.lstatSync(target).isFile()) return { status: 'unreadable', text: '' };
        const descriptor = fs.openSync(target, 'r');
        try {
            const stat = fs.fstatSync(descriptor);
            if (!stat.isFile() || stat.size > maxBytes) return { status: 'unreadable', text: '' };
            const buffer = Buffer.alloc(stat.size);
            const read = fs.readSync(descriptor, buffer, 0, stat.size, 0);
            return { status: 'read', text: buffer.subarray(0, read).toString('utf8') };
        } finally {
            fs.closeSync(descriptor);
        }
    } catch {
        return { status: 'unreadable', text: '' };
    }
}

function readPlainCardReference(repoRoot: string, relative: string): PlanText {
    const normalized = relative.replace(/\\/gu, '/');
    if (!isSafeRelativeMarkdownPath(normalized)) {
        return { source: { kind: 'task-card', path: normalized, status: 'unreadable', sha256: null }, text: '' };
    }
    const read = readContainedBoundedText(repoRoot, normalized, MAX_CARD_BYTES);
    return {
        source: { kind: 'task-card', path: normalized, status: read.status, sha256: read.status === 'read' ? stringSha256(read.text) : null },
        text: read.text
    };
}

function readLinkedTaskCard(repoRoot: string, taskId: string): PlanText | null {
    try {
        const card = readReviewTaskCard(repoRoot, taskId);
        return card
            ? { source: { kind: 'task-card', path: card.path, status: 'read', sha256: card.sha256 }, text: card.section }
            : null;
    } catch {
        return { source: { kind: 'task-card', path: null, status: 'unreadable', sha256: null }, text: '' };
    }
}

function collectPlanTexts(repoRoot: string, taskId: string, notes: string, readLinkedCard: boolean): PlanText[] {
    const texts: PlanText[] = [];
    if (notes.trim()) {
        texts.push({ source: { kind: 'task-notes', path: TASK_QUEUE_FILENAME, status: 'read', sha256: stringSha256(notes) }, text: notes });
    }
    const linked = readLinkedCard ? readLinkedTaskCard(repoRoot, taskId) : null;
    if (linked) texts.push(linked);
    const references = [...new Set([...notes.matchAll(PLAIN_CARD_REFERENCE_PATTERN)].map((match) => match[1]))]
        .slice(0, MAX_PLAIN_CARD_REFERENCES);
    for (const reference of references) {
        if (linked?.source.path && normalizePath(linked.source.path) === normalizePath(reference)) continue;
        texts.push(readPlainCardReference(repoRoot, reference));
    }
    return texts;
}

export function detectStrictDecompositionTaskPlan(
    repoRoot: string,
    taskId: string,
    notes: string,
    options: { readLinkedCard?: boolean } = {}
): StrictDecompositionTaskPlan {
    const texts = collectPlanTexts(repoRoot, taskId, notes, options.readLinkedCard !== false);
    const evidence: string[] = [];
    const caps: DetectedFileCap[] = [];
    let subCardPlan = false;
    const plannedChildren = new Set<string>();
    let namedInCard = false;
    for (const { source, text } of texts) {
        if (!text) continue;
        const subCardMatch = SUB_CARD_PLAN_PATTERN.exec(text);
        if (subCardMatch) {
            subCardPlan = true;
            evidence.push(subCardMatch[0]);
        }
        caps.push(...collectFileCaps(text));
        for (const token of collectTaskIdTokens(text)) {
            if (isPlannedChildTaskId(taskId, token)) plannedChildren.add(token);
            if (source.kind === 'task-card' && token.toLowerCase() === taskId.toLowerCase()) namedInCard = true;
        }
    }
    evidence.push(...caps.map((entry) => entry.evidence));
    const plannedChildTaskIds = subCardPlan ? [...plannedChildren].sort() : [];
    const fileCap = caps.length > 0 ? Math.min(...caps.map((entry) => entry.cap)) : null;
    const hardCaps = caps.filter((entry) => entry.hard).map((entry) => entry.cap);
    return {
        sources: texts.map((entry) => entry.source),
        sub_card_plan: subCardPlan,
        planned_child_task_ids: plannedChildTaskIds,
        // A card that names this row while planning no children of it describes this row as one of its sub-cards.
        task_is_planned_sub_card: subCardPlan && plannedChildTaskIds.length === 0 && namedInCard,
        file_cap: fileCap,
        file_cap_hard: caps.some((entry) => entry.cap === fileCap && entry.hard),
        hard_file_cap: hardCaps.length > 0 ? Math.min(...hardCaps) : null,
        evidence: [...new Set(evidence)].slice(0, MAX_EVIDENCE_ENTRIES)
    };
}

/**
 * Plan signals from the TASK.md notes alone, without reading any file, so next-step can ask for the decision
 * before implementation. The decision gate still reads the referenced cards.
 */
export function collectStrictDecompositionNotesPlanSignals(notes: string | null | undefined): string[] {
    const text = String(notes || '');
    if (!text.trim()) return [];
    const signals: string[] = [];
    if (SUB_CARD_PLAN_PATTERN.test(text)) signals.push('task_plan:sub-cards');
    const caps = collectFileCaps(text);
    if (caps.length > 0) signals.push(`task_plan:file-cap=${Math.min(...caps.map((entry) => entry.cap))}`);
    return signals;
}

/** TASK.md through the same containment as cards, with the queue's own size bound. */
export function readContainedTaskQueueText(repoRoot: string): { status: StrictDecompositionPlanSourceStatus; text: string } {
    return readContainedBoundedText(repoRoot, TASK_QUEUE_FILENAME, MAX_TASK_QUEUE_BYTES);
}

export function describeUnreadableTaskQueue(): string {
    return `${TASK_QUEUE_FILENAME} must be a regular file inside the repository and at most ${MAX_TASK_QUEUE_BYTES} bytes.`;
}

/** Reads the plan from a contained, bounded TASK.md; a queue that fails either bound refuses the decision. */
export function readStrictDecompositionTaskPlan(repoRoot: string, taskId: string): StrictDecompositionTaskPlan {
    const queue = readContainedTaskQueueText(repoRoot);
    if (queue.status === 'unreadable') {
        throw new Error(`${describeUnreadableTaskQueue()} A decomposition decision reads its task plan from it; restore it, then rerun this command.`);
    }
    const entry = queue.status === 'read' ? parseTaskQueueEntriesFromContent(queue.text).get(taskId) ?? null : null;
    return detectStrictDecompositionTaskPlan(repoRoot, taskId, String(entry?.notes || ''), { readLinkedCard: queue.status === 'read' });
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function normalizePlanSource(value: unknown): StrictDecompositionPlanSource {
    const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    const kind = record?.kind;
    const status = record?.status;
    if (!record || (kind !== 'task-notes' && kind !== 'task-card')
        || (status !== 'read' && status !== 'missing' && status !== 'unreadable')
        || (record.path !== null && typeof record.path !== 'string')
        || (record.sha256 !== null && typeof record.sha256 !== 'string')) {
        throw new Error('TaskPlan source entries must record kind, path, status and sha256.');
    }
    return { kind, path: record.path as string | null, status, sha256: record.sha256 as string | null };
}

/** Shape validation for a stored plan; detection itself runs only when the decision is recorded. */
export function normalizeStrictDecompositionTaskPlan(value: unknown): StrictDecompositionTaskPlan | null {
    if (value === null || value === undefined) return null;
    const record = typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    const fileCap = record?.file_cap;
    const hardFileCap = record?.hard_file_cap ?? null;
    if (!record || !Array.isArray(record.sources) || typeof record.sub_card_plan !== 'boolean'
        || !isStringArray(record.planned_child_task_ids) || typeof record.task_is_planned_sub_card !== 'boolean'
        || !isStringArray(record.evidence) || typeof record.file_cap_hard !== 'boolean'
        || (fileCap !== null && !(typeof fileCap === 'number' && Number.isSafeInteger(fileCap) && fileCap > 0))
        || (hardFileCap !== null && !(typeof hardFileCap === 'number' && Number.isSafeInteger(hardFileCap)
            && typeof fileCap === 'number' && hardFileCap >= fileCap))) {
        throw new Error('TaskPlan is malformed.');
    }
    return {
        sources: record.sources.map(normalizePlanSource),
        sub_card_plan: record.sub_card_plan,
        planned_child_task_ids: [...record.planned_child_task_ids],
        task_is_planned_sub_card: record.task_is_planned_sub_card,
        file_cap: fileCap as number | null,
        file_cap_hard: record.file_cap_hard,
        ...('hard_file_cap' in record ? { hard_file_cap: hardFileCap as number | null } : {}),
        evidence: [...record.evidence]
    };
}
