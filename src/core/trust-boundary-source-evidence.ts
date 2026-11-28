import type { ValidationFileIdentity } from './project-validation-contract';
import type { TrustBoundarySourceEvidence } from './trust-boundary-analysis';

export const MAX_BOUNDARY_SOURCE_REFERENCES = 128;
export const MAX_BOUNDARY_SOURCE_BYTES = 8 * 1024 * 1024;
// Tested against exactly one code point, never anchored: V8 in Node 26 fails `[\p{L}]$` for astral letters.
const IDENTIFIER_CODE_POINT = /[\p{L}\p{N}\p{M}_$]/u;

function isIdentifierCodePoint(codePoint: number | undefined): boolean {
    return codePoint !== undefined && IDENTIFIER_CODE_POINT.test(String.fromCodePoint(codePoint));
}

function codePointBefore(text: string, index: number): number | undefined {
    if (index <= 0) return undefined;
    const last = text.charCodeAt(index - 1);
    const high = index >= 2 ? text.charCodeAt(index - 2) : 0;
    return last >= 0xdc00 && last <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? text.codePointAt(index - 2) : last;
}

export function decodeBoundarySource(bytes: Buffer): string {
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
        : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
    const hasBom = encoding !== 'utf-8' || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf);
    const decoder = new TextDecoder(encoding, { fatal: true });
    if (hasBom) return decoder.decode(bytes);
    try {
        return decoder.decode(bytes);
    } catch {
        // Buffer's Latin-1 decoder maps every byte directly to its Unicode code point.
        return bytes.toString('latin1');
    }
}

export function isValidBoundaryCaseId(caseId: string): boolean {
    return caseId.trim().length > 0 && !/[\uD800-\uDFFF]/u.test(caseId);
}

export function containsCaseIdentifier(text: string, caseId: string): boolean {
    if (!isValidBoundaryCaseId(caseId)) return false;
    for (let index = text.indexOf(caseId); index !== -1; index = text.indexOf(caseId, index + 1)) {
        const end = index + caseId.length;
        if (!isIdentifierCodePoint(codePointBefore(text, index)) && !isIdentifierCodePoint(text.codePointAt(end))) return true;
    }
    return false;
}

export const CASE_SOURCE_CORRECTION_PREFIX = 'Cannot bind source ';

export function caseSourceCorrection(source: string, caseId: string, selector?: string): string {
    return `${CASE_SOURCE_CORRECTION_PREFIX}${JSON.stringify(source)}, case ${JSON.stringify(caseId)}, selector ${selector === undefined ? 'unknown' : JSON.stringify(selector)}. `
        + 'Cite the file that declares this case in the checklist reference and in --selected-case. '
        + 'Use the identifier as written in that file as case_id (for example, "test_price"). '
        + 'The selector may stay the full runner ID (for example, "tests/test_price.py::test_price[zero]").';
}

export interface BoundarySourceReference { filePath: string; caseId: string }
interface BoundarySourceReadOptions {
    repoRoot: string; references: readonly BoundarySourceReference[];
    expectedSources?: readonly ValidationFileIdentity[];
}
type SourceWithIdentity = { identity: ValidationFileIdentity };

function retainedSources(expected: readonly ValidationFileIdentity[] | undefined,
    paths: readonly string[], violations: string[]): Map<string, ValidationFileIdentity> | null {
    if (expected === undefined) return null;
    const sources = new Map<string, ValidationFileIdentity>();
    if (!Array.isArray(expected) || expected.length > MAX_BOUNDARY_SOURCE_REFERENCES) {
        violations.push('Retained boundary source identities must be a bounded array.');
        return sources;
    }
    for (const identity of expected) {
        if (!identity || typeof identity.path !== 'string' || sources.has(identity.path)) {
            violations.push('Retained boundary source identities are missing or ambiguous.');
        } else {
            sources.set(identity.path, identity);
        }
    }
    if (sources.size !== paths.length || paths.some(file => !sources.has(file))) {
        violations.push('Retained boundary source identities must cover the exact source set.');
    }
    return sources;
}

function sameSource(actual: ValidationFileIdentity, expected: ValidationFileIdentity): boolean {
    return actual.path === expected.path && actual.sha256 === expected.sha256
        && actual.size === expected.size && actual.identity === expected.identity;
}

function captureSources<T extends SourceWithIdentity>(root: string, paths: readonly string[],
    expected: Map<string, ValidationFileIdentity> | null, violations: string[],
    project: (identity: ValidationFileIdentity, bytes: Buffer) => T) {
    const { readValidationFile } = require('./project-validation-identity') as typeof import('./project-validation-identity');
    const sources = new Map<string, T>();
    let remainingBytes = MAX_BOUNDARY_SOURCE_BYTES;
    for (const file of paths) {
        try {
            const { identity, bytes } = readValidationFile(root, file, remainingBytes);
            remainingBytes -= identity.size;
            if (expected && (!expected.has(file) || !sameSource(identity, expected.get(file)!))) {
                throw new Error('Retained source identity changed');
            }
            sources.set(file, project(identity, bytes));
        } catch (error) {
            violations.push(`Boundary source rejected (${file}): ${String(error)}`);
        }
    }
    return sources;
}

function revalidateSources(root: string, sources: Map<string, SourceWithIdentity>, violations: string[]) {
    const { readValidationFile } = require('./project-validation-identity') as typeof import('./project-validation-identity');
    for (const [file, { identity: expected }] of sources) {
        try {
            if (!sameSource(readValidationFile(root, file, expected.size).identity, expected)) {
                throw new Error('Boundary source identity changed during capture');
            }
        } catch (error) {
            sources.delete(file);
            violations.push(`Boundary source changed (${file}): ${String(error)}`);
        }
    }
}

function readBoundSources<T extends SourceWithIdentity>(options: BoundarySourceReadOptions,
    project: (identity: ValidationFileIdentity, bytes: Buffer) => T) {
    const violations: string[] = [];
    if (options.references.length > MAX_BOUNDARY_SOURCE_REFERENCES) {
        return { sources: new Map<string, T>(), violations: ['Boundary evidence exceeds the reference bound.'] };
    }
    const paths = [...new Set(options.references.map(reference => reference.filePath))];
    const expected = retainedSources(options.expectedSources, paths, violations);
    const sources = captureSources(options.repoRoot, paths, expected, violations, project);
    revalidateSources(options.repoRoot, sources, violations);
    return { sources, violations };
}

export function readBoundarySources(options: BoundarySourceReadOptions) {
    return readBoundSources(options, (identity, bytes) => ({ identity, text: decodeBoundarySource(bytes) }));
}

export function readBoundarySourceIdentities(options: BoundarySourceReadOptions) {
    return readBoundSources(options, identity => ({ identity }));
}

export function readBoundarySourceEvidence(options: BoundarySourceReadOptions & {
    selectorForRefusal?: (source: string, caseId: string) => string | undefined;
}): {
    sourceEvidence: TrustBoundarySourceEvidence[]; violations: string[];
} {
    const { sources, violations } = readBoundarySources(options);
    if (options.references.length > MAX_BOUNDARY_SOURCE_REFERENCES) return { sourceEvidence: [], violations };
    const sourceEvidence = options.references.flatMap(reference => {
        const { filePath, caseId } = reference;
        const source = sources.get(filePath);
        if (!source || !containsCaseIdentifier(source.text, caseId)) {
            violations.push(caseSourceCorrection(filePath, caseId, options.selectorForRefusal?.(filePath, caseId)));
            return [];
        }
        return [{ source_identity: { ...source.identity }, case_id: caseId,
            selector: caseId, syntax_status: 'UNRESOLVED' as const }];
    });
    return { sourceEvidence, violations };
}

/** Stabilize this fixed lazy loader edge before capturing transitive executable identity. */
export function prepareBoundarySourceEvidenceModules(): void {
    require('./project-validation-identity');
}
