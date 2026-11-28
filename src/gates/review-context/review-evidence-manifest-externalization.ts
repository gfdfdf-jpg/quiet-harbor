import * as path from 'node:path';
import { stringSha256 } from '../../gate-runtime/hash';
import { normalizePath } from '../shared/helpers';

/**
 * A reviewer reads the evidence manifest with ordinary file-read tools. A long string value (for example retained
 * adapter report bytes as content_base64) makes the manifest too large for those tools and, as one JSON line, cannot
 * be paged. Such values are written once to content-addressed sidecar files; the manifest keeps a reference with the
 * sha256 of the sidecar bytes and of the original value. The review context JSON still holds every original value.
 */
export interface ExternalizedManifestValueReference {
    externalized_manifest_value: true;
    content_path: string;
    content_sha256: string;
    content_encoding: 'utf8' | 'utf8_decoded_from_base64' | 'json';
    content_char_count: number;
    original_value_sha256: string;
    original_char_count: number;
}

export interface ExternalizedManifestValueFile {
    path: string;
    text: string;
}

export interface ExternalizedManifestValues {
    value: unknown;
    files: ExternalizedManifestValueFile[];
    fieldPaths: string[];
}

export const EXTERNALIZED_MANIFEST_VALUE_MIN_CHARS = 4096;
/** Smaller strings follow only while the externalizable evidence is still above its inline budget. */
const EXTERNALIZED_MANIFEST_VALUE_THRESHOLDS = [EXTERNALIZED_MANIFEST_VALUE_MIN_CHARS, 1024, 256] as const;
/** Inline budget for the externalizable evidence values; the rest of the manifest is small and fixed. */
export const MAX_INLINE_MANIFEST_EVIDENCE_CHARS = 24 * 1024;
/** A subtree smaller than this is never moved to a sidecar of its own. */
const EXTERNALIZED_MANIFEST_SUBTREE_MIN_CHARS = 1024;

export const EXTERNALIZED_MANIFEST_VALUES_INSTRUCTION =
    'Each listed field held a long value that is stored in the file at content_path instead of inline, so this manifest '
    + 'stays readable. The delegated reviewer is authorized to open that file and read it in parts. content_sha256 is the '
    + 'sha256 of the file bytes; files lists every such file with its sha256, and the gate verifies them before launch. '
    + 'content_encoding utf8_decoded_from_base64 means the file holds the decoded UTF-8 text of the canonical base64 value '
    + '(quote that decoded text); utf8 means the file holds the string itself; json means the file holds the indented '
    + 'JSON of the original object or array. original_value_sha256 is the sha256 of the original string or compact JSON, '
    + 'which the review context JSON (artifacts.review_context.artifact_path) still holds unchanged.';

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function decodeCanonicalBase64Utf8(value: string): string | null {
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value) return null;
    try {
        return UTF8_DECODER.decode(bytes);
    } catch {
        return null;
    }
}

interface ExternalizationState {
    valuesDirectory: string;
    files: ExternalizedManifestValueFile[];
    fieldPaths: string[];
}

function addReference(state: ExternalizationState, text: string, encoding: ExternalizedManifestValueReference['content_encoding'],
    original: string): ExternalizedManifestValueReference {
    const contentSha256 = stringSha256(text) || '';
    const contentPath = normalizePath(path.join(state.valuesDirectory, `${contentSha256}.txt`));
    if (!state.files.some((file) => file.path === contentPath)) state.files.push({ path: contentPath, text });
    return {
        externalized_manifest_value: true,
        content_path: contentPath,
        content_sha256: contentSha256,
        content_encoding: encoding,
        content_char_count: text.length,
        original_value_sha256: stringSha256(original) || '',
        original_char_count: original.length
    };
}

function isReference(node: unknown): boolean {
    return !!node && typeof node === 'object' && (node as Record<string, unknown>).externalized_manifest_value === true;
}

function externalizeStrings(node: unknown, fieldKey: string, pointer: string, minChars: number, state: ExternalizationState): unknown {
    if (typeof node === 'string') {
        if (node.length < minChars) return node;
        state.fieldPaths.push(pointer);
        const decoded = fieldKey.endsWith('_base64') ? decodeCanonicalBase64Utf8(node) : null;
        return addReference(state, decoded ?? node, decoded === null ? 'utf8' : 'utf8_decoded_from_base64', node);
    }
    if (isReference(node)) return node;
    // An unchanged subtree keeps its identity; only a container holding an externalized string is copied.
    if (Array.isArray(node)) {
        const projected = node.map((entry, index) => externalizeStrings(entry, fieldKey, `${pointer}/${index}`, minChars, state));
        return projected.every((entry, index) => entry === node[index]) ? node : projected;
    }
    if (node && typeof node === 'object') {
        const entries = Object.entries(node as Record<string, unknown>);
        const projected = entries.map(([key, entry]) => [key, externalizeStrings(entry, key, `${pointer}/${key}`, minChars, state)] as const);
        return projected.every(([, entry], index) => entry === entries[index][1]) ? node : Object.fromEntries(projected);
    }
    return node;
}

function inlineChars(value: unknown): number {
    return (JSON.stringify(value, null, 2) ?? '').length;
}

/**
 * The largest object or array inside an evidence group (by indented JSON), at or above the subtree minimum.
 * The groups themselves (depth 1, such as full_suite_validation) stay inline objects.
 */
function findLargestSubtree(node: unknown, pointer: string, best: { pointer: string; size: number } | null, depth: number) {
    if (!node || typeof node !== 'object' || isReference(node)) return best;
    if (depth > 1) {
        const size = inlineChars(node);
        if (size < EXTERNALIZED_MANIFEST_SUBTREE_MIN_CHARS) return best;
        if (!best || size > best.size) best = { pointer, size };
    }
    const entries = Array.isArray(node) ? node.map((entry, index) => [String(index), entry] as const)
        : Object.entries(node as Record<string, unknown>);
    for (const [key, entry] of entries) best = findLargestSubtree(entry, `${pointer}/${key}`, best, depth + 1);
    return best;
}

function replaceAtPointer(root: unknown, relative: string[], replace: (node: unknown) => unknown): unknown {
    if (relative.length === 0) return replace(root);
    const [head, ...rest] = relative;
    if (Array.isArray(root)) return root.map((entry, index) => String(index) === head ? replaceAtPointer(entry, rest, replace) : entry);
    const record = root as Record<string, unknown>;
    return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, key === head ? replaceAtPointer(entry, rest, replace) : entry]));
}

/** Sidecar directory of a manifest: `<manifest basename without .json>-values` beside the manifest. */
export function resolveExternalizedManifestValuesDirectory(evidenceManifestArtifactPath: string): string {
    const parsed = path.parse(evidenceManifestArtifactPath);
    return path.join(parsed.dir, `${parsed.name}-values`);
}

/**
 * Pure: returns the projected value, the sidecar files to write, and the JSON pointers of externalized values.
 * Strings of at least 4096 characters always move; smaller strings and then the largest subtrees move only while the
 * projected value is still above its inline budget, so the total inline size stays bounded.
 */
export function externalizeLongManifestStrings(
    value: unknown,
    pointer: string,
    valuesDirectory: string,
    maxInlineChars: number = MAX_INLINE_MANIFEST_EVIDENCE_CHARS
): ExternalizedManifestValues {
    const state: ExternalizationState = { valuesDirectory, files: [], fieldPaths: [] };
    let projected = value;
    for (const [index, minChars] of EXTERNALIZED_MANIFEST_VALUE_THRESHOLDS.entries()) {
        if (index > 0 && inlineChars(projected) <= maxInlineChars) break;
        projected = externalizeStrings(projected, '', pointer, minChars, state);
    }
    while (inlineChars(projected) > maxInlineChars) {
        const largest = findLargestSubtree(projected, pointer, null, 0);
        if (!largest) break;
        projected = replaceAtPointer(projected, largest.pointer.slice(pointer.length).split('/').slice(1), (node) => {
            state.fieldPaths.push(largest.pointer);
            return addReference(state, `${JSON.stringify(node, null, 2)}\n`, 'json', JSON.stringify(node));
        });
    }
    return { value: projected, files: state.files, fieldPaths: state.fieldPaths };
}

/** Every externalized reference in a manifest document, in document order. */
export function collectExternalizedManifestValueReferences(document: unknown): ExternalizedManifestValueReference[] {
    const found: ExternalizedManifestValueReference[] = [];
    const visit = (node: unknown) => {
        if (!node || typeof node !== 'object') return;
        if (isReference(node)) { found.push(node as ExternalizedManifestValueReference); return; }
        for (const entry of Array.isArray(node) ? node : Object.values(node as Record<string, unknown>)) visit(entry);
    };
    visit(document);
    return found;
}

/** Inline budget for the fields and files lists; a longer index moves to a sidecar of its own. */
export const MAX_INLINE_MANIFEST_INDEX_CHARS = 4 * 1024;

export const EXTERNALIZED_MANIFEST_VALUES_INDEX_INSTRUCTION =
    'The fields and files lists are stored as indented JSON {"fields": [...], "files": [...]} in the file at '
    + 'index.content_path instead of inline; index.content_sha256 is the sha256 of that file, which the gate verifies '
    + 'together with every file it lists before launch.';

/**
 * The manifest section that lists externalized fields and binds every sidecar by sha256. When that index would itself
 * exceed its inline budget (many captures), the index becomes one more sidecar bound by its sha256, so the final
 * manifest stays bounded with the index included. Returns the section and every sidecar to write, index included.
 */
export function buildExternalizedManifestValuesSection(
    externalized: ExternalizedManifestValues,
    valuesDirectory: string,
    maxInlineIndexChars: number = MAX_INLINE_MANIFEST_INDEX_CHARS
): { section: Record<string, unknown> | null; files: ExternalizedManifestValueFile[] } {
    if (externalized.fieldPaths.length === 0) return { section: null, files: externalized.files };
    const index = {
        fields: externalized.fieldPaths.map((pointer) => (pointer.startsWith('/task_evidence/')
            ? pointer.slice(1) : `artifacts${pointer}`).split('/').join('.')),
        // The manifest sha256 binds every sidecar through this list; launch verifies each file.
        files: externalized.files.map((file) => ({ content_path: file.path, content_sha256: stringSha256(file.text) || '' }))
    };
    if (inlineChars(index) <= maxInlineIndexChars) {
        return { section: { ...index, instruction: EXTERNALIZED_MANIFEST_VALUES_INSTRUCTION }, files: externalized.files };
    }
    const text = `${JSON.stringify(index, null, 2)}\n`;
    const contentSha256 = stringSha256(text) || '';
    const indexFile = { path: normalizePath(path.join(valuesDirectory, `${contentSha256}.txt`)), text };
    return {
        section: {
            index: { content_path: indexFile.path, content_sha256: contentSha256,
                field_count: index.fields.length, file_count: index.files.length },
            instruction: `${EXTERNALIZED_MANIFEST_VALUES_INSTRUCTION} ${EXTERNALIZED_MANIFEST_VALUES_INDEX_INSTRUCTION}`
        },
        files: [...externalized.files, indexFile]
    };
}
