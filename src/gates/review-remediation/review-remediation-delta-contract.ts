import { countNextStepWork } from '../../core/next-step-measurement';
import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import * as fs from 'node:fs';
import { lstatFileIdentitySync } from '../../core/file-stat';
import * as path from 'node:path';

import {
    hasLineEvidenceDisallowedCharacter,
    isStableRedactedLineEvidence,
    redactLegacyRemediationLinesForHash,
    redactSecretText,
    redactSensitiveData,
    sha256RedactedJsonPayload
} from '../../core/redaction';
import {
    getSafeWorktreePathState,
    type SafeWorktreePathState
} from '../workspace/worktree-path-state';
import { isPathInsideRoot, normalizePath } from '../shared/helpers';

export const REVIEW_REMEDIATION_DELTA_BASE_SCHEMA_VERSION = 2;
export const REVIEW_REMEDIATION_DELTA_LINE_EVIDENCE_VERSION = 2;
export const REVIEW_REMEDIATION_DELTA_MAX_TEXT_BYTES = 1024 * 1024;
export const REVIEW_REMEDIATION_DELTA_MAX_LINES_PER_FILE = 4096;
export const REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_LINES = 16384;
export const REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_BYTES = 4 * REVIEW_REMEDIATION_DELTA_MAX_TEXT_BYTES;
export const REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_FILES = 512;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export type ReviewRemediationDeltaPathStatus =
    | 'text'
    | 'binary'
    | 'missing'
    | 'symbolic_link'
    | 'unreviewable';

export type ReviewRemediationLineAnalysis =
    | 'available'
    | 'not_text'
    | 'unreviewable'
    | 'content_size_limit_exceeded'
    | 'line_count_limit_exceeded'
    | 'redaction_line_mismatch'
    | 'snapshot_line_budget_exceeded'
    | 'snapshot_byte_budget_exceeded'
    | 'snapshot_file_budget_exceeded';

export interface ReviewRemediationDeltaBaseEntry {
    path: string;
    status: ReviewRemediationDeltaPathStatus;
    mode: number | null;
    content_sha256: string | null;
    link_sha256: string | null;
    line_hashes: string[] | null;
    redacted_lines: string[] | null;
    redacted_lines_sha256: string | null;
    redaction_applied: boolean;
    line_count: number | null;
    line_analysis: ReviewRemediationLineAnalysis;
}

export interface ReviewRemediationDeltaBase {
    schema_version: typeof REVIEW_REMEDIATION_DELTA_BASE_SCHEMA_VERSION;
    task_id: string;
    review_type: string;
    review_tree_state_sha256: string;
    changed_files: string[];
    changed_files_sha256: string;
    entries: ReviewRemediationDeltaBaseEntry[];
    entries_sha256: string;
    /** Absent on older bases. When present, the snapshot hash binds the version. */
    line_evidence_version?: typeof REVIEW_REMEDIATION_DELTA_LINE_EVIDENCE_VERSION;
    snapshot_sha256: string;
}

function sha256Buffer(value: Buffer): string {
    return createHash('sha256').update(value).digest('hex');
}

function sha256Text(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function normalizeChangedFiles(files: readonly string[]): string[] {
    return [...new Set(files.map((file) => normalizePath(file)).filter(Boolean))].sort();
}

function splitLinesPreservingEndings(content: string): string[] {
    if (!content) {
        return [];
    }
    return content.match(/[^\n]*\n|[^\n]+/gu) ?? [];
}

/** The pre-T-437 split of redacted text: CRLF, LF or CR ends a line. */
function splitReleaseLines(content: string): string[] {
    if (!content) {
        return [];
    }
    return content.match(/.*?(?:\r\n|\n|\r|$)/gu)?.filter((line) => line.length > 0) ?? [];
}

export interface BoundedLineEvidence {
    lineHashes: string[];
    redactedLines: string[];
    redactionApplied: boolean;
}

/**
 * releaseLineCount is the number of lines the pre-T-437 capture stored as evidence for this file, or null when
 * it stored none. Snapshot budgets are charged by it, so the files that get evidence are always among those the
 * release gave evidence to.
 */
export type BoundedLineEvidenceResult =
    | { evidence: BoundedLineEvidence; failure: null; releaseLineCount: number }
    | { evidence: null; failure: 'line_count_limit_exceeded' | 'redaction_line_mismatch'; releaseLineCount: number | null };

export function buildBoundedLineEvidence(
    content: Buffer,
    redact: (text: string) => string = (text) => redactSecretText(text, { preserveLineCount: true })
): BoundedLineEvidenceResult {
    return buildLineEvidence(content, redact, false);
}

function buildLineEvidence(
    content: Buffer,
    redact: (text: string) => string,
    legacyHashOnly: boolean
): BoundedLineEvidenceResult {
    if (content.length === 0) {
        return { evidence: { lineHashes: [], redactedLines: [], redactionApplied: false }, failure: null, releaseLineCount: 0 };
    }
    const lineLimitExceeded: BoundedLineEvidenceResult = { evidence: null, failure: 'line_count_limit_exceeded', releaseLineCount: null };
    const lineHashes: string[] = [];
    let start = 0;
    for (let index = 0; index < content.length; index += 1) {
        if (content[index] === 0x0a) {
            if (lineHashes.length >= REVIEW_REMEDIATION_DELTA_MAX_LINES_PER_FILE) {
                return lineLimitExceeded;
            }
            lineHashes.push(sha256Buffer(content.subarray(start, index + 1)));
            start = index + 1;
        }
    }
    if (start < content.length) {
        if (lineHashes.length >= REVIEW_REMEDIATION_DELTA_MAX_LINES_PER_FILE) {
            return lineLimitExceeded;
        }
        lineHashes.push(sha256Buffer(content.subarray(start)));
    }
    const decoded = content.toString('utf8');
    const redacted = redact(decoded);
    const legacyLines = legacyHashOnly ? splitLinesPreservingEndings(redacted) : null;
    // Earlier captures charged lines when their redacted split agreed with the raw line hashes.
    const chargedLineCount = (legacyLines ?? splitReleaseLines(redacted)).length;
    const releaseLineCount = chargedLineCount === lineHashes.length ? lineHashes.length : null;
    const mismatch: BoundedLineEvidenceResult = { evidence: null, failure: 'redaction_line_mismatch', releaseLineCount };
    // Only TAB, LF and CRLF (or a final CR) may separate text: after any other control or separator character a
    // secret could be kept in clear inside one LF-delimited line, so such a file gets no line evidence.
    if (releaseLineCount === null || (!legacyHashOnly && hasLineEvidenceDisallowedCharacter(decoded))) {
        return mismatch;
    }
    const redactedLines = legacyLines ?? splitLinesPreservingEndings(redacted);
    // A redaction that changes the line structure, or lines the redacting serializer would rewrite (they could not
    // be reloaded under their hash), leave no evidence; what is kept equals the lines the release kept.
    if (redactedLines.length !== lineHashes.length || (!legacyHashOnly && !isStableRedactedLineEvidence(redactedLines))) {
        return mismatch;
    }
    return {
        evidence: { lineHashes, redactedLines, redactionApplied: redacted !== decoded },
        failure: null,
        releaseLineCount
    };
}

function resolveRepoFile(repoRoot: string, relativeFile: string): string | null {
    const resolvedRoot = path.resolve(repoRoot);
    const resolvedFile = path.resolve(resolvedRoot, relativeFile);
    return isPathInsideRoot(resolvedFile, resolvedRoot) ? resolvedFile : null;
}

function buildBudgetExceededEntry(
    relativeFile: string,
    lineAnalysis: Extract<
        ReviewRemediationLineAnalysis,
        'snapshot_line_budget_exceeded' | 'snapshot_byte_budget_exceeded' | 'snapshot_file_budget_exceeded'
    >,
    mode: number | null = null,
    linkSha256: string | null = null
): ReviewRemediationDeltaBaseEntry {
    return {
        path: normalizePath(relativeFile),
        status: 'unreviewable',
        mode,
        content_sha256: null,
        link_sha256: linkSha256,
        line_hashes: null,
        redacted_lines: null,
        redacted_lines_sha256: null,
        redaction_applied: false,
        line_count: null,
        line_analysis: lineAnalysis
    };
}

function buildUnreviewableEntry(
    relativeFile: string,
    mode: number | null = null,
    linkSha256: string | null = null
): ReviewRemediationDeltaBaseEntry {
    return {
        path: normalizePath(relativeFile),
        status: 'unreviewable',
        mode,
        content_sha256: null,
        link_sha256: linkSha256,
        line_hashes: null,
        redacted_lines: null,
        redacted_lines_sha256: null,
        redaction_applied: false,
        line_count: null,
        line_analysis: 'unreviewable'
    };
}

function sameFileIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.mode === right.mode
        && left.size === right.size
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs;
}

function sameReadablePathState(left: SafeWorktreePathState, right: SafeWorktreePathState): boolean {
    return left.status === right.status
        && left.mode === right.mode
        && left.size === right.size
        && left.link_sha256 === right.link_sha256
        && left.link_target === right.link_target
        && left.target_path === right.target_path
        && left.target_status === right.target_status
        && left.target_mode === right.target_mode
        && left.target_size === right.target_size;
}

function readExactObservedFile(fileDescriptor: number, expectedSize: number): Buffer | null {
    const buffer = Buffer.alloc(expectedSize + 1);
    let offset = 0;
    while (offset < buffer.length) {
        const bytesRead = fs.readSync(fileDescriptor, buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) {
            break;
        }
        offset += bytesRead;
    }
    return offset === expectedSize ? buffer.subarray(0, offset) : null;
}

interface BuiltEntry {
    entry: ReviewRemediationDeltaBaseEntry;
    bytes_read: number;
    redacted_bytes?: number;
    /** Lines the release capture charged to the snapshot line budget for this file. */
    charged_lines?: number;
    /** The release capture found this file over the remaining line budget, which ends line evidence for the rest. */
    exhausts_line_budget?: boolean;
}

/** What the release capture charged a file to the snapshot line budget: its evidence lines, or the rest of the budget. */
function releaseLineCharge(
    releaseLineCount: number | null,
    remainingSnapshotLines: number
): { charged_lines: number; exhausts_line_budget: boolean } {
    if (releaseLineCount === null) return { charged_lines: 0, exhausts_line_budget: false };
    return releaseLineCount > remainingSnapshotLines
        ? { charged_lines: 0, exhausts_line_budget: true }
        : { charged_lines: releaseLineCount, exhausts_line_budget: false };
}

function buildEntry(
    repoRoot: string,
    relativeFile: string,
    remainingSnapshotLines: number,
    remainingSnapshotBytes: number,
    remainingRedactedBytes: number,
    legacyHashOnly: boolean
): BuiltEntry {
    const normalizedPath = normalizePath(relativeFile);
    const resolvedFile = resolveRepoFile(repoRoot, normalizedPath);
    if (!resolvedFile) {
        return { entry: {
            path: normalizedPath,
            status: 'unreviewable',
            mode: null,
            content_sha256: null,
            link_sha256: null,
            line_hashes: null,
            redacted_lines: null,
            redacted_lines_sha256: null,
            redaction_applied: false,
            line_count: null,
            line_analysis: 'unreviewable'
        }, bytes_read: 0 };
    }
    const pathState = getSafeWorktreePathState(repoRoot, normalizedPath, {
        includeContentHashes: false,
        distinguishAccessErrors: true
    });
    if (pathState.status === 'missing') {
        return { entry: {
            path: normalizedPath,
            status: 'missing',
            mode: null,
            content_sha256: null,
            link_sha256: null,
            line_hashes: [],
            redacted_lines: [],
            redacted_lines_sha256: sha256Text(''),
            redaction_applied: false,
            line_count: 0,
            line_analysis: 'available'
        }, bytes_read: 0 };
    }
    const symbolicLink = pathState.status === 'symbolic_link';
    const linkSha256 = pathState.link_sha256 || null;
    const observedMode = symbolicLink
        ? (pathState.target_mode ?? pathState.mode ?? null)
        : (pathState.mode ?? null);
    const readableFile = pathState.status === 'file'
        || (pathState.status === 'symbolic_link' && pathState.target_status === 'file');
    if (!readableFile) {
        return { entry: {
            path: normalizedPath,
            status: symbolicLink ? 'symbolic_link' : 'unreviewable',
            mode: observedMode,
            content_sha256: null,
            link_sha256: linkSha256,
            line_hashes: null,
            redacted_lines: null,
            redacted_lines_sha256: null,
            redaction_applied: false,
            line_count: null,
            line_analysis: 'unreviewable'
        }, bytes_read: 0 };
    }
    if (remainingSnapshotLines <= 0) {
        return {
            entry: buildBudgetExceededEntry(
                normalizedPath,
                'snapshot_line_budget_exceeded',
                observedMode,
                linkSha256
            ),
            bytes_read: 0
        };
    }
    let fileSize: number;
    let content: Buffer;
    try {
        const repoRealPath = fs.realpathSync(repoRoot);
        const observedRealPath = fs.realpathSync(resolvedFile);
        if (!isPathInsideRoot(observedRealPath, repoRealPath)) {
            return { entry: buildUnreviewableEntry(normalizedPath, observedMode, linkSha256), bytes_read: 0 };
        }
        const beforeOpen = lstatFileIdentitySync(observedRealPath, { bigint: true });
        if (!beforeOpen.isFile() || beforeOpen.size > BigInt(Number.MAX_SAFE_INTEGER)) {
            return { entry: buildUnreviewableEntry(normalizedPath, observedMode, linkSha256), bytes_read: 0 };
        }
        fileSize = Number(beforeOpen.size);
        if (fileSize > remainingSnapshotBytes) {
            return {
                entry: buildBudgetExceededEntry(
                    normalizedPath,
                    'snapshot_byte_budget_exceeded',
                    observedMode,
                    linkSha256
                ),
                bytes_read: 0
            };
        }
        if (fileSize > REVIEW_REMEDIATION_DELTA_MAX_TEXT_BYTES) {
            return { entry: {
                path: normalizedPath,
                status: 'unreviewable',
                mode: observedMode,
                content_sha256: null,
                link_sha256: linkSha256,
                line_hashes: null,
                redacted_lines: null,
                redacted_lines_sha256: null,
                redaction_applied: false,
                line_count: null,
                line_analysis: 'content_size_limit_exceeded'
            }, bytes_read: 0 };
        }
        const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
        const fileDescriptor = fs.openSync(observedRealPath, openFlags);
        try {
            const opened = fs.fstatSync(fileDescriptor, { bigint: true });
            if (!opened.isFile() || !sameFileIdentity(beforeOpen, opened)) {
                return { entry: buildUnreviewableEntry(normalizedPath, observedMode, linkSha256), bytes_read: 0 };
            }
            const observedContent = readExactObservedFile(fileDescriptor, fileSize);
            const afterRead = fs.fstatSync(fileDescriptor, { bigint: true });
            if (!observedContent || !sameFileIdentity(opened, afterRead)) {
                return { entry: buildUnreviewableEntry(normalizedPath, observedMode, linkSha256), bytes_read: 0 };
            }
            content = observedContent;
        } finally {
            fs.closeSync(fileDescriptor);
        }
        const finalRealPath = fs.realpathSync(resolvedFile);
        const afterPath = lstatFileIdentitySync(observedRealPath, { bigint: true });
        const finalPathState = getSafeWorktreePathState(repoRoot, normalizedPath, {
            includeContentHashes: false,
            distinguishAccessErrors: true
        });
        if (
            finalRealPath !== observedRealPath
            || !sameFileIdentity(beforeOpen, afterPath)
            || !sameReadablePathState(pathState, finalPathState)
        ) {
            return { entry: buildUnreviewableEntry(normalizedPath, observedMode, linkSha256), bytes_read: 0 };
        }
    } catch {
        return { entry: buildUnreviewableEntry(normalizedPath, observedMode, linkSha256), bytes_read: 0 };
    }
    const contentSha256 = sha256Buffer(content);
    if (content.includes(0) || !isUtf8(content)) {
        return { entry: {
            path: normalizedPath,
            status: symbolicLink ? 'symbolic_link' : 'binary',
            mode: observedMode,
            content_sha256: contentSha256,
            link_sha256: linkSha256,
            line_hashes: null,
            redacted_lines: null,
            redacted_lines_sha256: null,
            redaction_applied: false,
            line_count: null,
            line_analysis: 'not_text'
        }, bytes_read: fileSize };
    }
    const lineResult = legacyHashOnly
        ? buildLineEvidence(content, redactLegacyRemediationLinesForHash, true)
        : buildBoundedLineEvidence(content);
    if (lineResult.failure !== null) {
        return { entry: {
            path: normalizedPath,
            status: symbolicLink ? 'symbolic_link' : 'text',
            mode: observedMode,
            content_sha256: contentSha256,
            link_sha256: linkSha256,
            line_hashes: null,
            redacted_lines: null,
            redacted_lines_sha256: null,
            redaction_applied: false,
            line_count: null,
            line_analysis: lineResult.failure
        }, bytes_read: fileSize, ...releaseLineCharge(lineResult.releaseLineCount, remainingSnapshotLines) };
    }
    const lineEvidence = lineResult.evidence;
    // New evidence follows the validator's redacted-byte cap. The old digest used only source-byte and line budgets.
    const redactedBytes = Buffer.byteLength(lineEvidence.redactedLines.join(''), 'utf8');
    if (lineEvidence.lineHashes.length > remainingSnapshotLines || (!legacyHashOnly && redactedBytes > remainingRedactedBytes)) {
        return { entry: {
            path: normalizedPath,
            status: symbolicLink ? 'symbolic_link' : 'text',
            mode: observedMode,
            content_sha256: contentSha256,
            link_sha256: linkSha256,
            line_hashes: null,
            redacted_lines: null,
            redacted_lines_sha256: null,
            redaction_applied: false,
            line_count: null,
            line_analysis: 'snapshot_line_budget_exceeded'
        }, bytes_read: fileSize, ...releaseLineCharge(lineResult.releaseLineCount, remainingSnapshotLines) };
    }
    return { entry: {
        path: normalizedPath,
        status: symbolicLink ? 'symbolic_link' : 'text',
        mode: observedMode,
        content_sha256: contentSha256,
        link_sha256: linkSha256,
        line_hashes: lineEvidence.lineHashes,
        redacted_lines: lineEvidence.redactedLines,
        redacted_lines_sha256: sha256Text(lineEvidence.redactedLines.join('')),
        redaction_applied: lineEvidence.redactionApplied,
        line_count: lineEvidence.lineHashes.length,
        line_analysis: 'available'
    }, bytes_read: fileSize, redacted_bytes: redactedBytes, charged_lines: lineEvidence.lineHashes.length };
}

interface DeltaSnapshotOptions {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    reviewTreeStateSha256: string;
    changedFiles: readonly string[];
    deferSnapshotPath?: (filePath: string) => boolean;
}

function captureDeltaSnapshot(options: DeltaSnapshotOptions, legacyHashOnly: boolean) {
    if (options.changedFiles.length > REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_FILES) {
        throw new Error(
            `Review remediation delta snapshot accepts at most ${REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_FILES} changed files.`
        );
    }
    const changedFiles = normalizeChangedFiles(options.changedFiles);
    let remainingSnapshotLines = REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_LINES;
    let remainingSnapshotBytes = REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_BYTES;
    let remainingRedactedBytes = REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_BYTES;
    const snapshotOrder = options.deferSnapshotPath
        ? [...changedFiles.filter((file) => !options.deferSnapshotPath!(file)), ...changedFiles.filter(options.deferSnapshotPath)]
        : changedFiles;
    const entries = snapshotOrder.map((file) => {
        const built = buildEntry(options.repoRoot, file, remainingSnapshotLines, remainingSnapshotBytes,
            remainingRedactedBytes, legacyHashOnly);
        const entry = built.entry;
        // Lines are charged as the release capture charged them, even for a file whose evidence is now withheld,
        // so withholding evidence never frees budget for a file the release gave none.
        remainingSnapshotLines -= built.charged_lines ?? 0;
        remainingSnapshotBytes -= built.bytes_read;
        remainingRedactedBytes -= built.redacted_bytes ?? 0;
        if (built.exhausts_line_budget) {
            remainingSnapshotLines = 0;
        }
        return entry;
    }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    return {
        schema_version: REVIEW_REMEDIATION_DELTA_BASE_SCHEMA_VERSION,
        task_id: String(options.taskId || '').trim(),
        review_type: String(options.reviewType || '').trim().toLowerCase(),
        review_tree_state_sha256: String(options.reviewTreeStateSha256 || '').trim().toLowerCase(),
        changed_files: changedFiles,
        changed_files_sha256: sha256Text(changedFiles.join('\n')),
        entries
    } as const;
}

export function buildReviewRemediationDeltaBase(options: DeltaSnapshotOptions): ReviewRemediationDeltaBase {
    const snapshot = captureDeltaSnapshot(options, false);
    const base = {
        ...snapshot,
        entries_sha256: sha256RedactedJsonPayload(snapshot.entries),
        line_evidence_version: REVIEW_REMEDIATION_DELTA_LINE_EVIDENCE_VERSION
    } as const;
    return {
        ...base,
        snapshot_sha256: sha256RedactedJsonPayload(base)
    };
}

/** Compare a recorded 2.0 snapshot without exposing its historical line evidence to callers. */
export function matchesLegacyReviewRemediationSnapshot(options: DeltaSnapshotOptions, recordedSha256: string): boolean {
    const snapshot = captureDeltaSnapshot(options, true);
    const redactedEntries = snapshot.entries.map(entry => {
        const redacted = redactSensitiveData({ ...entry, redacted_lines: null }) as Record<string, unknown>;
        const lines = entry.redacted_lines;
        // The old serializer used text stability alone for this field.
        if (lines !== null) {
            const joined = lines.join('');
            redacted.redacted_lines = redactSecretText(joined) === joined && lines.every(line => redactSecretText(line) === line)
                ? lines : lines.map(() => '<redacted>');
        }
        return redacted;
    });
    const payload = redactSensitiveData({ ...snapshot, entries: null,
        entries_sha256: sha256Text(`${JSON.stringify(redactedEntries, null, 2)}\n`) }) as Record<string, unknown>;
    payload.entries = redactedEntries;
    return sha256Text(`${JSON.stringify(payload, null, 2)}\n`) === recordedSha256;
}

/**
 * Whether a delta base carries aligned line evidence. Only deciding a new DELTA (the classifier) requires it; a DELTA
 * decided, built, launched or finished before the update completes as the earlier release would have completed it.
 */
export function hasAlignedLineEvidence(base: { line_evidence_version?: unknown }): boolean {
    return base.line_evidence_version === REVIEW_REMEDIATION_DELTA_LINE_EVIDENCE_VERSION;
}

export function getReviewRemediationDeltaBaseViolations(
    value: unknown,
    expected: {
        taskId?: string;
        reviewType?: string;
        reviewTreeStateSha256?: string;
    } = {}
): string[] {
    const violations: string[] = [];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return ['delta_base must be an object.'];
    }
    const base = value as Partial<ReviewRemediationDeltaBase>;
    if (base.schema_version !== REVIEW_REMEDIATION_DELTA_BASE_SCHEMA_VERSION) {
        violations.push(`delta_base.schema_version must be ${REVIEW_REMEDIATION_DELTA_BASE_SCHEMA_VERSION}.`);
    }
    if (base.line_evidence_version !== undefined && !hasAlignedLineEvidence(base)) {
        violations.push(`delta_base.line_evidence_version must be ${REVIEW_REMEDIATION_DELTA_LINE_EVIDENCE_VERSION} when present.`);
    }
    if (!String(base.task_id || '').trim()) {
        violations.push('delta_base.task_id is required.');
    } else if (expected.taskId && base.task_id !== expected.taskId) {
        violations.push(`delta_base.task_id mismatch: expected ${expected.taskId}, found ${base.task_id}.`);
    }
    if (!String(base.review_type || '').trim()) {
        violations.push('delta_base.review_type is required.');
    } else if (expected.reviewType && base.review_type !== expected.reviewType) {
        violations.push(`delta_base.review_type mismatch: expected ${expected.reviewType}, found ${base.review_type}.`);
    }
    const treeHash = String(base.review_tree_state_sha256 || '').trim().toLowerCase();
    if (!SHA256_PATTERN.test(treeHash)) {
        violations.push('delta_base.review_tree_state_sha256 must be a SHA-256 hash.');
    } else if (expected.reviewTreeStateSha256 && treeHash !== expected.reviewTreeStateSha256) {
        violations.push('delta_base.review_tree_state_sha256 does not match the remediation baseline tree binding.');
    }
    if (!Array.isArray(base.changed_files) || !Array.isArray(base.entries)) {
        violations.push('delta_base changed_files and entries must be arrays.');
        return violations;
    }
    if (base.changed_files.length > REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_FILES) {
        violations.push(
            `delta_base.changed_files must contain at most ${REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_FILES} paths.`
        );
        return violations;
    }
    if (base.entries.length > REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_FILES) {
        violations.push(
            `delta_base.entries must contain at most ${REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_FILES} entries.`
        );
        return violations;
    }
    const changedFiles = normalizeChangedFiles(base.changed_files);
    if (JSON.stringify(changedFiles) !== JSON.stringify(base.changed_files)) {
        violations.push('delta_base.changed_files must be normalized, unique, and sorted.');
    }
    if (base.changed_files_sha256 !== sha256Text(changedFiles.join('\n'))) {
        violations.push('delta_base.changed_files_sha256 does not match changed_files.');
    }
    const entryPaths: string[] = [];
    let lineHashCount = 0;
    let redactedTextBytes = 0;
    for (const [index, entryValue] of base.entries.entries()) {
        countNextStepWork('visit:review-remediation-delta-contract:event:514');
        if (!entryValue || typeof entryValue !== 'object' || Array.isArray(entryValue)) {
            violations.push(`delta_base.entries[${index}] must be an object.`);
            continue;
        }
        const entry = entryValue as Partial<ReviewRemediationDeltaBaseEntry>;
        const normalizedPath = normalizePath(entry.path);
        entryPaths.push(normalizedPath);
        if (!normalizedPath || normalizedPath !== entry.path) {
            violations.push(`delta_base.entries[${index}].path must be a normalized relative path.`);
        }
        if (!['text', 'binary', 'missing', 'symbolic_link', 'unreviewable'].includes(String(entry.status))) {
            violations.push(`delta_base.entries[${index}].status is invalid.`);
        }
        if (entry.mode !== null && (!Number.isInteger(entry.mode) || (entry.mode as number) < 0)) {
            violations.push(`delta_base.entries[${index}].mode must be null or a non-negative integer.`);
        }
        if (![
            'available',
            'not_text',
            'unreviewable',
            'content_size_limit_exceeded',
            'line_count_limit_exceeded',
            'redaction_line_mismatch',
            'snapshot_line_budget_exceeded',
            'snapshot_byte_budget_exceeded',
            'snapshot_file_budget_exceeded'
        ].includes(String(entry.line_analysis))) {
            violations.push(`delta_base.entries[${index}].line_analysis is invalid.`);
        }
        if (entry.content_sha256 !== null && !SHA256_PATTERN.test(String(entry.content_sha256 || ''))) {
            violations.push(`delta_base.entries[${index}].content_sha256 must be null or a SHA-256 hash.`);
        }
        if (entry.link_sha256 !== null && !SHA256_PATTERN.test(String(entry.link_sha256 || ''))) {
            violations.push(`delta_base.entries[${index}].link_sha256 must be null or a SHA-256 hash.`);
        } else if (entry.status === 'symbolic_link' && entry.link_sha256 === null) {
            violations.push(`delta_base.entries[${index}].link_sha256 is required for symbolic links.`);
        }
        if (typeof entry.redaction_applied !== 'boolean') {
            violations.push(`delta_base.entries[${index}].redaction_applied must be boolean.`);
        }
        if (entry.line_hashes !== null) {
            if (!Array.isArray(entry.line_hashes)) {
                violations.push(`delta_base.entries[${index}].line_hashes must contain only SHA-256 hashes.`);
            } else if (entry.line_hashes.length > REVIEW_REMEDIATION_DELTA_MAX_LINES_PER_FILE) {
                violations.push(
                    `delta_base.entries[${index}].line_hashes must contain at most ${REVIEW_REMEDIATION_DELTA_MAX_LINES_PER_FILE} hashes.`
                );
                return violations;
            } else if (
                lineHashCount + entry.line_hashes.length
                > REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_LINES
            ) {
                violations.push(
                    `delta_base line_hashes must contain at most ${REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_LINES} hashes in aggregate.`
                );
                return violations;
            } else if (entry.line_hashes.some((hash) => !SHA256_PATTERN.test(hash))) {
                violations.push(`delta_base.entries[${index}].line_hashes must contain only SHA-256 hashes.`);
            } else if (entry.line_count !== entry.line_hashes.length) {
                violations.push(`delta_base.entries[${index}].line_count does not match line_hashes.`);
            } else if (entry.line_analysis !== 'available') {
                violations.push(`delta_base.entries[${index}].line_analysis must be available when line_hashes are present.`);
            }
            if (Array.isArray(entry.line_hashes)) {
                lineHashCount += entry.line_hashes.length;
            }
            if (!Array.isArray(entry.redacted_lines)) {
                violations.push(`delta_base.entries[${index}].redacted_lines must accompany line_hashes.`);
            } else {
                const redactedText = entry.redacted_lines.join('');
                redactedTextBytes += Buffer.byteLength(redactedText, 'utf8');
                if (!Array.isArray(entry.line_hashes) || entry.redacted_lines.length !== entry.line_hashes.length) {
                    violations.push(`delta_base.entries[${index}].redacted_lines must match line_hashes length.`);
                }
                if (entry.redacted_lines.some((line) => typeof line !== 'string')) {
                    violations.push(`delta_base.entries[${index}].redacted_lines must contain only strings.`);
                } else if (entry.redacted_lines.some((line) => redactSecretText(line) !== line)) {
                    violations.push(`delta_base.entries[${index}].redacted_lines contains unredacted secret-like text.`);
                } else if (hasLineEvidenceDisallowedCharacter(redactedText)
                    || entry.redacted_lines.some((line) => hasLineEvidenceDisallowedCharacter(line))) {
                    violations.push(`delta_base.entries[${index}].redacted_lines contains a control or line separator character outside the line evidence allowlist.`);
                }
                if (entry.redacted_lines_sha256 !== sha256Text(redactedText)) {
                    violations.push(`delta_base.entries[${index}].redacted_lines_sha256 does not match redacted_lines.`);
                }
            }
        } else if (entry.line_count !== null) {
            violations.push(`delta_base.entries[${index}].line_count must be null when line_hashes are unavailable.`);
        } else if (entry.line_analysis === 'available') {
            violations.push(`delta_base.entries[${index}].line_analysis cannot be available when line_hashes are unavailable.`);
        } else if (entry.redacted_lines !== null || entry.redacted_lines_sha256 !== null || entry.redaction_applied === true) {
            violations.push(`delta_base.entries[${index}] must not retain readable text when line evidence is unavailable.`);
        }
    }
    if (redactedTextBytes > REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_BYTES) {
        violations.push(
            `delta_base redacted_lines must contain at most ${REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_BYTES} UTF-8 bytes in aggregate.`
        );
    }
    if (JSON.stringify(entryPaths) !== JSON.stringify(changedFiles)) {
        violations.push('delta_base entries must match changed_files exactly and in order.');
    }
    // Both seals contain the same entries. Redact them once, preserving the existing
    // two independently serialized payloads and their exact hash format.
    const redactedEntries = redactSensitiveData(base.entries);
    if (base.entries_sha256 !== sha256Text(`${JSON.stringify(redactedEntries, null, 2)}\n`)) {
        violations.push('delta_base.entries_sha256 does not match entries.');
    }
    const snapshotPayload = {
        schema_version: base.schema_version,
        task_id: base.task_id,
        review_type: base.review_type,
        review_tree_state_sha256: base.review_tree_state_sha256,
        changed_files: base.changed_files,
        changed_files_sha256: base.changed_files_sha256,
        entries: base.entries,
        entries_sha256: base.entries_sha256,
        ...(base.line_evidence_version === undefined ? {} : { line_evidence_version: base.line_evidence_version })
    };
    const redactedSnapshot = redactSensitiveData({ ...snapshotPayload, entries: null }) as Record<string, unknown>;
    redactedSnapshot.entries = redactedEntries;
    if (base.snapshot_sha256 !== sha256Text(`${JSON.stringify(redactedSnapshot, null, 2)}\n`)) {
        violations.push('delta_base.snapshot_sha256 does not match the baseline snapshot payload.');
    }
    return violations;
}
