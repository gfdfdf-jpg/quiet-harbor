import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { writeArtifactFileAtomically } from '../../gate-runtime/review-artifacts';
import { buildReviewContextHandoffArtifactPaths } from '../review-context/review-context-artifacts';
import { reviewerPromptRecovery } from './review-artifact-recovery';

import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import {
    fileSha256, isPathInsideRoot, joinOrchestratorPath, normalizePath, resolvePathInsideRepo, toPlainRecord
} from '../shared/helpers';

function getStringField(record: Record<string, unknown> | null, ...keys: string[]): string {
    if (!record) {
        return '';
    }
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return '';
}

export interface ReviewPromptArtifactBinding {
    promptPath: string;
    reviewerPromptSha256: string;
    expectedPromptSha256: string | null;
}

export interface ReviewHandoffArtifactBinding {
    artifactPath: string;
    artifactSha256: string;
    expectedArtifactSha256: string;
}

export interface ReviewerHandoffArtifactBindings {
    rolePrompt: ReviewHandoffArtifactBinding | null;
    promptTemplate: ReviewHandoffArtifactBinding;
    outputTemplate: ReviewHandoffArtifactBinding;
    evidenceManifest: ReviewHandoffArtifactBinding;
}

interface ReviewerLaunchInputOptions {
    repoRoot: string;
    contextPath: string;
    reviewContext: Record<string, unknown>;
    gateName: string;
}

export function getReviewContextRuleContext(reviewContext: Record<string, unknown>): Record<string, unknown> | null {
    return toPlainRecord(reviewContext.rule_context);
}

function resolveReviewerPromptPath(options: {
    repoRoot: string;
    contextPath: string;
    ruleContext: Record<string, unknown> | null;
    gateName: string;
}): { promptPath: string } {
    if (!options.ruleContext) {
        throw new Error(
            `${options.gateName} requires review context rule_context for '${normalizePath(options.contextPath)}' ` +
            'because reviewer prompt artifact binding is mandatory.'
        );
    }

    const preferredPromptPath = getStringField(options.ruleContext, 'preferred_prompt_artifact');
    const artifactPath = getStringField(options.ruleContext, 'artifact_path');
    const reviewerPromptPath = preferredPromptPath || artifactPath;
    if (!reviewerPromptPath) {
        throw new Error(
            `${options.gateName} requires review context rule_context.preferred_prompt_artifact or ` +
            `rule_context.artifact_path for '${normalizePath(options.contextPath)}' because reviewer prompt artifact binding is mandatory.`
        );
    }

    const resolvedPromptPath = resolvePathInsideRepo(reviewerPromptPath, options.repoRoot, {
        allowMissing: true,
        enforceInside: true
    });
    if (!resolvedPromptPath || !fs.existsSync(resolvedPromptPath) || !fs.statSync(resolvedPromptPath).isFile()) {
        throw new Error(
            `${options.gateName} requires a readable reviewer prompt artifact for '${normalizePath(options.contextPath)}'. ` +
            `Resolved prompt path '${normalizePath(resolvedPromptPath || reviewerPromptPath)}' could not be read. ` +
            reviewerPromptRecovery(options.gateName)
        );
    }
    assertReviewerPromptRealpathInsideRepo({
        repoRoot: options.repoRoot,
        promptPath: resolvedPromptPath,
        gateName: options.gateName,
        contextPath: options.contextPath
    });
    assertPromptPathFieldsConsistent({
        repoRoot: options.repoRoot,
        preferredPromptPath,
        artifactPath,
        gateName: options.gateName,
        contextPath: options.contextPath
    });
    return {
        promptPath: resolvedPromptPath
    };
}

function assertPromptPathFieldsConsistent(options: {
    repoRoot: string;
    preferredPromptPath: string;
    artifactPath: string;
    gateName: string;
    contextPath: string;
}): void {
    if (!options.preferredPromptPath || !options.artifactPath) {
        return;
    }
    const preferredResolved = resolvePathInsideRepo(options.preferredPromptPath, options.repoRoot, {
        allowMissing: true,
        enforceInside: true
    });
    const artifactResolved = resolvePathInsideRepo(options.artifactPath, options.repoRoot, {
        allowMissing: true,
        enforceInside: true
    });
    if (!preferredResolved || !artifactResolved || preferredResolved !== artifactResolved) {
        throw new Error(
            `${options.gateName} requires review context rule_context.preferred_prompt_artifact and ` +
            `rule_context.artifact_path to resolve to the same reviewer prompt artifact for '${normalizePath(options.contextPath)}'.`
        );
    }
}

function assertReviewerPromptRealpathInsideRepo(options: {
    repoRoot: string;
    promptPath: string;
    gateName: string;
    contextPath: string;
}): void {
    const repoRealPath = fs.realpathSync(options.repoRoot);
    const promptRealPath = fs.realpathSync(options.promptPath);
    if (!isPathInsideRoot(promptRealPath, repoRealPath)) {
        throw new Error(
            `${options.gateName} requires reviewer prompt artifact to stay inside repo root for ` +
            `'${normalizePath(options.contextPath)}'. Resolved prompt realpath '${normalizePath(promptRealPath)}' escapes ` +
            `repo root '${normalizePath(repoRealPath)}'.`
        );
    }
}

function assertReviewerHandoffRealpathInsideRepo(options: {
    repoRoot: string;
    artifactPath: string;
    gateName: string;
    contextPath: string;
    artifactLabel: string;
}): void {
    const repoRealPath = fs.realpathSync(options.repoRoot);
    const artifactRealPath = fs.realpathSync(options.artifactPath);
    if (!isPathInsideRoot(artifactRealPath, repoRealPath)) {
        throw new Error(
            `${options.gateName} requires ${options.artifactLabel} artifact to stay inside repo root for ` +
            `'${normalizePath(options.contextPath)}'. Resolved artifact realpath '${normalizePath(artifactRealPath)}' escapes ` +
            `repo root '${normalizePath(repoRealPath)}'.`
        );
    }
}

function getExpectedReviewerPromptSha256(options: {
    reviewContext: Record<string, unknown>;
    ruleContext: Record<string, unknown> | null;
    gateName: string;
    contextPath: string;
}): string {
    const expectedPromptSha256 = getStringField(options.ruleContext, 'artifact_sha256', 'artifactSha256').toLowerCase();
    if (!expectedPromptSha256) {
        throw new Error(
            `${options.gateName} requires review context rule_context.artifact_sha256 for '${normalizePath(options.contextPath)}' ` +
            'because reviewer prompt artifact binding is mandatory.'
        );
    }
    if (!/^[0-9a-f]{64}$/.test(expectedPromptSha256)) {
        throw new Error(
            `${options.gateName} requires review context rule_context.artifact_sha256 to be a lowercase sha256 hex digest. ` +
            `Got '${expectedPromptSha256}' for '${normalizePath(options.contextPath)}'.`
        );
    }
    return expectedPromptSha256;
}

export function resolveReviewerPromptArtifactBinding(options: {
    repoRoot: string;
    contextPath: string;
    reviewContext: Record<string, unknown>;
    gateName: string;
}): ReviewPromptArtifactBinding {
    const ruleContext = getReviewContextRuleContext(options.reviewContext);
    const promptResolution = resolveReviewerPromptPath({
        repoRoot: options.repoRoot,
        contextPath: options.contextPath,
        ruleContext,
        gateName: options.gateName
    });
    const reviewerPromptSha256 = fileSha256(promptResolution.promptPath);
    if (!reviewerPromptSha256) {
        throw new Error(
            `${options.gateName} requires a hashable reviewer prompt artifact for '${normalizePath(options.contextPath)}'. ` +
            `Resolved prompt path '${normalizePath(promptResolution.promptPath)}' could not be read. ` +
            reviewerPromptRecovery(options.gateName)
        );
    }
    const expectedPromptSha256 = getExpectedReviewerPromptSha256({
        reviewContext: options.reviewContext,
        ruleContext,
        gateName: options.gateName,
        contextPath: options.contextPath
    });
    if (reviewerPromptSha256 !== expectedPromptSha256) {
        throw new Error(
            `${options.gateName} cannot continue because reviewer prompt artifact is stale for '${normalizePath(options.contextPath)}'. ` +
            `Expected reviewer_prompt_sha256=${expectedPromptSha256} from review_context.rule_context.artifact_sha256; ` +
            `current reviewer_prompt_sha256=${reviewerPromptSha256} at '${normalizePath(promptResolution.promptPath)}'. ` +
            'Rebuild review context before launching or attesting a reviewer.'
        );
    }
    return {
        promptPath: promptResolution.promptPath,
        reviewerPromptSha256,
        expectedPromptSha256
    };
}

export function resolveReviewerHandoffArtifactBinding(options: {
    repoRoot: string;
    contextPath: string;
    reviewContext: Record<string, unknown>;
    gateName: string;
    handoffKey: string;
    artifactLabel: string;
}): ReviewHandoffArtifactBinding {
    const handoff = toPlainRecord(options.reviewContext.reviewer_handoff);
    const artifact = toPlainRecord(handoff?.[options.handoffKey]);
    const artifactPathValue = getStringField(artifact, 'artifact_path', 'artifactPath');
    const expectedArtifactSha256 = getStringField(artifact, 'artifact_sha256', 'artifactSha256').toLowerCase();
    if (!artifactPathValue) {
        throw new Error(
            `${options.gateName} requires review context reviewer_handoff.${options.handoffKey}.artifact_path ` +
            `for '${normalizePath(options.contextPath)}' because ${options.artifactLabel} handoff is mandatory.`
        );
    }
    if (!expectedArtifactSha256) {
        throw new Error(
            `${options.gateName} requires review context reviewer_handoff.${options.handoffKey}.artifact_sha256 ` +
            `for '${normalizePath(options.contextPath)}' because ${options.artifactLabel} handoff is mandatory.`
        );
    }
    if (!/^[0-9a-f]{64}$/.test(expectedArtifactSha256)) {
        throw new Error(
            `${options.gateName} requires review context reviewer_handoff.${options.handoffKey}.artifact_sha256 ` +
            `to be a lowercase sha256 hex digest for '${normalizePath(options.contextPath)}'.`
        );
    }
    const resolvedArtifactPath = resolvePathInsideRepo(artifactPathValue, options.repoRoot, {
        allowMissing: true,
        enforceInside: true
    });
    if (!resolvedArtifactPath || !fs.existsSync(resolvedArtifactPath) || !fs.statSync(resolvedArtifactPath).isFile()) {
        throw new Error(
            `${options.gateName} requires a readable ${options.artifactLabel} artifact for '${normalizePath(options.contextPath)}'. ` +
            `Resolved path '${normalizePath(resolvedArtifactPath || artifactPathValue)}' could not be read. ` +
            reviewerPromptRecovery(options.gateName)
        );
    }
    assertReviewerHandoffRealpathInsideRepo({
        repoRoot: options.repoRoot,
        artifactPath: resolvedArtifactPath,
        gateName: options.gateName,
        contextPath: options.contextPath,
        artifactLabel: options.artifactLabel
    });
    const artifactSha256 = fileSha256(resolvedArtifactPath);
    if (!artifactSha256) {
        throw new Error(
            `${options.gateName} requires a hashable ${options.artifactLabel} artifact for '${normalizePath(options.contextPath)}'. ` +
            `Resolved path '${normalizePath(resolvedArtifactPath)}' could not be read. ` +
            reviewerPromptRecovery(options.gateName)
        );
    }
    if (artifactSha256 !== expectedArtifactSha256) {
        throw new Error(
            `${options.gateName} cannot continue because ${options.artifactLabel} artifact is stale for '${normalizePath(options.contextPath)}'. ` +
            `Expected ${options.handoffKey}_sha256=${expectedArtifactSha256}; current sha256=${artifactSha256} at ` +
            `'${normalizePath(resolvedArtifactPath)}'. Rebuild review context before launching or attesting a reviewer.`
        );
    }
    return {
        artifactPath: resolvedArtifactPath,
        artifactSha256,
        expectedArtifactSha256
    };
}

/** Every reviewer handoff artifact a reviewer launch binds to its review context. */
export function resolveReviewerHandoffArtifactBindings(options: ReviewerLaunchInputOptions): ReviewerHandoffArtifactBindings {
    const handoff = toPlainRecord(options.reviewContext.reviewer_handoff);
    const bind = (handoffKey: string, artifactLabel: string) => resolveReviewerHandoffArtifactBinding({
        ...options,
        handoffKey,
        artifactLabel
    });
    return {
        rolePrompt: toPlainRecord(handoff?.role_prompt) ? bind('role_prompt', 'reviewer role prompt') : null,
        promptTemplate: bind('prompt_template', 'reviewer prompt template'),
        outputTemplate: bind('output_template', 'reviewer output template'),
        evidenceManifest: bind('evidence_manifest', 'reviewer evidence manifest')
    };
}

/**
 * The launch-input check of prepare-reviewer-launch, record-reviewer-delegation-started and complete-reviewer-launch, in their order:
 * the bound reviewer prompt, then every handoff artifact. Returns that gate's refusal, or null when it accepts.
 * Next-step routes with this same check, so it never names a gate that this check refuses.
 */
export function findReviewerLaunchInputRefusal(options: ReviewerLaunchInputOptions): string | null {
    try {
        resolveReviewerPromptArtifactBinding(options);
        if (options.gateName !== 'record-review-result' && options.gateName !== 'record-review-receipt') {
            resolveReviewerHandoffArtifactBindings(options);
        }
        return null;
    } catch (error: unknown) {
        return error instanceof Error ? error.message : String(error);
    }
}

interface HandoffCacheOptions {
    repoRoot: string;
    taskId: string;
    contextPath: string;
    reviewContext: Record<string, unknown>;
}

const REVIEWER_INPUT_CACHE_DIR = '.reviewer-input-cache';

function isSafeTaskDirectoryName(taskId: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(taskId) && taskId.length <= 128;
}

/**
 * Copies are kept per task (runtime/tmp/.reviewer-input-cache/<task-id>/<sha256>), so one task's cleanup never
 * removes a copy another active task still needs. An older task without that directory simply has no copy.
 */
function reviewerInputCacheDirectory(runtimeRoot: string, taskId: string): string | null {
    return isSafeTaskDirectoryName(taskId) ? path.join(runtimeRoot, 'tmp', REVIEWER_INPUT_CACHE_DIR, taskId) : null;
}

export function resolveTaskReviewerInputCopiesDirectory(repoRoot: string, taskId: string): string | null {
    return reviewerInputCacheDirectory(joinOrchestratorPath(repoRoot, 'runtime'), String(taskId || '').trim());
}

/**
 * Remove one task's disposable reviewer-input copies (task-reset, final closeout). Copies are never integrity
 * authority, so removing them only means a later loss of that task's inputs is treated as "no copy". Loose files
 * left directly in the cache root by the earlier unscoped layout belong to no task and are never read; they go too.
 */

export function removeTaskReviewerInputCopies(options: { repoRoot: string; taskId: string }): void {
    const directory = resolveTaskReviewerInputCopiesDirectory(options.repoRoot, options.taskId);
    if (!directory) return;
    const cacheRoot = path.dirname(directory);
    if (!resolvePathInsideRepo(directory, options.repoRoot, { allowMissing: true, enforceInside: true })) return;
    fs.rmSync(directory, { recursive: true, force: true });
    try {
        for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
            if (entry.isFile() && /^[0-9a-f]{64}$/u.test(entry.name)) fs.rmSync(path.join(cacheRoot, entry.name), { force: true });
        }
        try { fs.rmdirSync(cacheRoot); } catch (error: unknown) {
            if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(String((error as NodeJS.ErrnoException).code))) throw error;
        }
    } catch { /* No cache root: nothing to remove. */ }
}

function entries(options: HandoffCacheOptions): Array<{ file: string; sha256: string; cache: string | null }> {
    const paths = buildReviewContextHandoffArtifactPaths(options.contextPath);
    const rule = toPlainRecord(options.reviewContext.rule_context);
    const handoff = toPlainRecord(options.reviewContext.reviewer_handoff);
    const candidates = [
        [paths.ruleContextArtifactPath, rule?.artifact_sha256, rule?.artifact_path],
        ...([
            [paths.rolePromptArtifactPath, handoff?.role_prompt],
            [paths.promptTemplateArtifactPath, handoff?.prompt_template],
            [paths.outputTemplateArtifactPath, handoff?.output_template],
            [paths.evidenceManifestArtifactPath, handoff?.evidence_manifest]
        ] as const).map(([file, binding]) => [file, toPlainRecord(binding)?.artifact_sha256, toPlainRecord(binding)?.artifact_path])
    ];
    return candidates.flatMap(([file, digest, boundPath]) => {
        const sha256 = String(digest || '').trim().toLowerCase();
        // Custom/legacy prompt locations remain valid but are not writable recovery destinations.
        if (!/^[0-9a-f]{64}$/u.test(sha256) || typeof boundPath !== 'string'
            || path.resolve(options.repoRoot, boundPath) !== path.resolve(String(file))) return [];
        const resolved = resolvePathInsideRepo(String(file), options.repoRoot, { allowMissing: true, enforceInside: true });
        const directory = reviewerInputCacheDirectory(path.join(path.dirname(options.contextPath), '..'), options.taskId);
        const cache = directory
            ? resolvePathInsideRepo(path.join(directory, sha256), options.repoRoot, { allowMissing: true, enforceInside: true })
            : null;
        return resolved ? [{ file: resolved, sha256, cache: cache || null }] : [];
    });
}

function authenticatedBytes(file: string, sha256: string): Buffer | null {
    try {
        const bytes = fs.readFileSync(file);
        return createHash('sha256').update(bytes).digest('hex') === sha256 ? bytes : null;
    } catch { return null; }
}

/** Disposable byte copies, never launch authority. Only the context/launch-pinned digest authenticates them. */
export function preserveReviewerHandoffInputs(options: HandoffCacheOptions): void {
    for (const entry of entries(options)) {
        const bytes = authenticatedBytes(entry.file, entry.sha256);
        if (!bytes) throw new Error(`Cannot preserve unauthenticated reviewer input '${entry.file}'.`);
        if (entry.cache && !authenticatedBytes(entry.cache, entry.sha256)) {
            fs.mkdirSync(path.dirname(entry.cache), { recursive: true });
            writeArtifactFileAtomically(entry.cache, bytes.toString('utf8'));
        }
    }
}

function restoreEntries(
    options: HandoffCacheOptions, allowed: (file: string, sha256: string) => boolean, dryRun = false
): boolean {
    let restored = false;
    for (const entry of entries(options)) {
        if (!entry.cache || authenticatedBytes(entry.file, entry.sha256) || !allowed(entry.file, entry.sha256)) continue;
        const bytes = authenticatedBytes(entry.cache, entry.sha256);
        if (!bytes) continue;
        if (!dryRun) writeArtifactFileAtomically(entry.file, bytes.toString('utf8'));
        restored = true;
    }
    return restored;
}

function proofKey(repoRoot: string, file: string): string {
    return normalizePath(path.relative(path.resolve(repoRoot), path.resolve(file)));
}

/**
 * The reviewer inputs a result gate found intact (same digests as the review context) when it accepted the reviewer's
 * output. Recorded in the gate-signed REVIEW_RECORDED event: it is the only proof that lets a later gate restore one of
 * these inputs without changing what the reviewer is credited with having seen.
 */
export function buildReviewerInputPostRunProof(options: HandoffCacheOptions): {
    review_context_sha256: string;
    inputs: Array<{ path: string; sha256: string }>;
} | null {
    const contextSha256 = fileSha256(options.contextPath);
    if (!contextSha256) return null;
    const inputs = entries(options).filter(entry => authenticatedBytes(entry.file, entry.sha256))
        .map(entry => ({ path: proofKey(options.repoRoot, entry.file), sha256: entry.sha256 }));
    return { review_context_sha256: contextSha256, inputs };
}

const ATTEMPT_EVENT_TYPES = new Set([
    'REVIEWER_DELEGATION_ROUTED', 'REVIEWER_LAUNCH_PREPARED', 'REVIEWER_LAUNCH_INPUT_PINNED', 'REVIEWER_DELEGATION_STARTED',
    'REVIEWER_LAUNCH_FAILED', 'REVIEWER_LAUNCH_COMPLETED', 'REVIEWER_INVOCATION_ATTESTED'
]);

/**
 * The input digests that the latest gate-signed REVIEW_RECORDED of this lane proved intact after its reviewer's run,
 * or null. Read only from the verified native timeline. A later reviewer attempt of the lane, or a task reset,
 * voids the proof: that run's reviewer has not been proven to read intact inputs. No time window is involved.
 */
function readReviewerInputPostRunProof(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    contextSha256: string;
}): Map<string, string> | null {
    const timelinePath = joinOrchestratorPath(options.repoRoot, path.join('runtime', 'task-events', `${options.taskId}.jsonl`));
    if (!fs.existsSync(timelinePath)) return null;
    const reviewType = options.reviewType.trim().toLowerCase();
    let proof: Map<string, string> | null = null;
    const inspection = inspectTaskEventFile(timelinePath, options.taskId, { onIntegrityEvent: event => {
        const type = String(event.event_type || '');
        if (type === 'TASK_RESET' || type === 'TASK_DISCARDED' || type === 'TASK_MODE_ENTERED') {
            proof = null;
            return;
        }
        const details = toPlainRecord(event.details);
        if (String(details?.review_type ?? details?.reviewType ?? '').trim().toLowerCase() !== reviewType) return;
        if (ATTEMPT_EVENT_TYPES.has(type)) {
            proof = null;
            return;
        }
        if (type !== 'REVIEW_RECORDED') return;
        proof = null;
        const recorded = toPlainRecord(details?.reviewer_input_proof);
        if (event.actor !== 'gate' || event.outcome !== 'PASS' || String(event.task_id || '') !== options.taskId
            || !recorded || recorded.review_context_sha256 !== options.contextSha256 || !Array.isArray(recorded.inputs)) return;
        const inputs = new Map<string, string>();
        for (const input of recorded.inputs) {
            const item = toPlainRecord(input);
            if (typeof item?.path === 'string' && typeof item.sha256 === 'string' && /^[0-9a-f]{64}$/u.test(item.sha256)) {
                inputs.set(item.path, item.sha256);
            }
        }
        proof = inputs;
    } });
    return inspection.status === 'PASS' || inspection.status === 'PASS_WITH_LEGACY_PREFIX' ? proof : null;
}

/**
 * Before the handoff (prepare-reviewer-launch) no reviewer has read the inputs yet, so any digest-bound copy restores.
 * Called only after a binding refusal; the caller must rerun every original binding and authentication check.
 */
export function restoreReviewerHandoffInputsBeforeHandoff(options: HandoffCacheOptions): boolean {
    return restoreEntries(options, () => true);
}

/**
 * After the handoff the reviewer reads its inputs from disk while it runs, so a copy may restore an input only when a
 * gate-signed result of this lane already proved that input intact (same digest) after the run. Without that proof a
 * changed input is lost evidence of this review only: nothing is restored and the caller's refusal stands.
 * The one rule shared by the attempt and result gates, required-reviews-check, the dependency gate and next-step.
 * Called only after a binding refusal; the caller must rerun every original binding and authentication check.
 */
export function restoreProvenReviewerHandoffInputs(
    options: HandoffCacheOptions & { reviewType: string; dryRun?: boolean }
): boolean {
    const contextSha256 = fileSha256(options.contextPath);
    if (!contextSha256 || !options.taskId || !options.reviewType) return false;
    let proof: Map<string, string> | null | undefined;
    return restoreEntries(options, (file, sha256) => {
        if (proof === undefined) {
            proof = readReviewerInputPostRunProof({ repoRoot: options.repoRoot, taskId: options.taskId,
                reviewType: options.reviewType, contextSha256 });
        }
        return proof?.get(proofKey(options.repoRoot, file)) === sha256;
    }, options.dryRun === true);
}

/** The same rule for a lane's generated review context, as the result gates' readers (dependency, required reviews) see it. */
export function restoreProvenLaneReviewerInputs(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    reviewsRoot: string;
    /** next-step only asks whether the gate would restore; it never writes. */
    dryRun?: boolean;
}): boolean {
    if (!options.taskId || !options.reviewType || /[\\/]/u.test(options.reviewType)) return false;
    const contextPath = path.join(options.reviewsRoot, `${options.taskId}-${options.reviewType}-review-context.json`);
    try {
        const reviewContext = toPlainRecord(JSON.parse(fs.readFileSync(contextPath, 'utf8')));
        return reviewContext ? restoreProvenReviewerHandoffInputs({ repoRoot: options.repoRoot, contextPath, reviewContext,
            taskId: options.taskId, reviewType: options.reviewType, dryRun: options.dryRun }) : false;
    } catch {
        // Unavailable contexts and copies retain the caller's original refusal.
        return false;
    }
}
