import { countNextStepWork, countNextStepArrayCopy } from '../../core/next-step-measurement';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    normalizeReviewCycleGuardConfig
} from '../../core/review-cycle-guard';
import {
    extractReviewVerdictToken
} from '../../gate-runtime/review-context';
import { resolveValidatedReviewCycleArtifactForVerdict, getReviewCycleValidationArtifactVerdict } from '../review-attempts/review-history-integrity';
import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import { isAuthenticatedReviewRestartEvent } from '../../gate-runtime/review/review-restart-boundary';
import {
    type TimelineEventEntry
} from '../completion/completion-evidence';
import {
    REVIEW_CONTRACTS
} from '../required-reviews/required-reviews-check';
import {
    getReviewLaneScopeSha256,
    normalizeDomainScopeFingerprints,
    type DomainScopeFingerprints
} from '../scope/domain-scope-fingerprints';
import {
    joinOrchestratorPath
} from '../shared/helpers';
import {
    reviewCycleAttemptMatchesCurrentScope
} from './next-step-review-cycle-scope';
import {
    type NextStepReviewCycleLatestFailedReview,
    type ReviewCycleArtifactVerdictResult,
    type ReviewCycleGuardReadResult
} from './next-step-review-cycle-guard-types';
import { withReviewArtifactReadBarrier } from '../../gate-runtime/review-artifacts';
import {
    createReviewAttemptArtifactIndex,
    type ReviewAttemptArtifactIndex
} from '../review-attempts/review-attempt-artifact-index';

type ReviewCycleGuardConfig = ReturnType<typeof normalizeReviewCycleGuardConfig>;

const REVIEW_VERDICT_PASS_TOKENS: Record<string, string> = Object.freeze(Object.fromEntries(REVIEW_CONTRACTS));
const REVIEW_VERDICT_FAIL_TOKENS: Record<string, string> = Object.freeze(Object.fromEntries(
    REVIEW_CONTRACTS.map(([reviewType, passToken]) => [reviewType, passToken.replace(/\bPASSED\b/g, 'FAILED')])
));

function getTimelineDetailText(details: Record<string, unknown> | null, fieldNames: string[]): string | null {
    for (const fieldName of fieldNames) {
        const value = details?.[fieldName];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return null;
}

function getTimelineReviewType(details: Record<string, unknown> | null): string {
    return String(details?.review_type || details?.reviewType || '').trim().toLowerCase();
}

function getTimelineReviewerIdentity(details: Record<string, unknown> | null): string {
    return String(details?.reviewer_identity || details?.reviewerIdentity || '').trim();
}

function getTimelineReviewContextSha256(details: Record<string, unknown> | null): string {
    return String(details?.review_context_sha256 || details?.reviewContextSha256 || '').trim().toLowerCase();
}

function normalizeReviewCycleScopeHash(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : null;
}

function getTimelineReviewScopeHash(details: Record<string, unknown> | null): string | null {
    return normalizeReviewCycleScopeHash(details?.review_scope_sha256 ?? details?.reviewScopeSha256);
}

function getTimelineCodeScopeHash(details: Record<string, unknown> | null): string | null {
    return normalizeReviewCycleScopeHash(details?.code_scope_sha256 ?? details?.codeScopeSha256);
}

function getReviewCycleAttemptScopeHash(
    reviewType: string,
    details: Record<string, unknown> | null
): string | null {
    const normalizedReviewType = reviewType.trim().toLowerCase();
    const detailFingerprints = normalizeDomainScopeFingerprints(details?.domain_scope_fingerprints);
    return getReviewLaneScopeSha256(normalizedReviewType, detailFingerprints)
        || (normalizedReviewType === 'test'
        ? getTimelineReviewScopeHash(details)
        : getTimelineCodeScopeHash(details) || getTimelineReviewScopeHash(details));
}

function getTimelineReviewFailure(eventType: string, details: Record<string, unknown> | null, outcome: string | null): boolean | null {
    const normalizedOutcome = String(outcome || '').trim().toUpperCase();
    if (normalizedOutcome === 'FAIL') {
        return true;
    }
    const verdictToken = String(details?.verdict_token || details?.verdictToken || '').trim().toUpperCase();
    if (verdictToken.endsWith('FAILED')) {
        return true;
    }
    if (verdictToken.endsWith('PASSED')) {
        return false;
    }
    if (
        eventType === 'REVIEW_RECORDED'
        && String(details?.review_artifact_snapshot_path || details?.reviewArtifactSnapshotPath || '').trim()
    ) {
        return null;
    }
    if (normalizedOutcome === 'PASS') {
        return false;
    }
    return null;
}

/** The findings-disposition verdict the result gate signed into REVIEW_RECORDED, or null when absent. */
function getSignedDispositionFailure(details: Record<string, unknown> | null): boolean | null {
    const disposition = details?.review_findings_disposition;
    const verdict = disposition && typeof disposition === 'object' && !Array.isArray(disposition)
        ? String((disposition as Record<string, unknown>).verdict || '') : '';
    if (verdict === 'fail_for_fix_now') return true;
    return verdict === 'pass_no_findings' || verdict === 'pass_with_follow_up_or_ignored_findings' ? false : null;
}

function normalizeReviewCycleSha256(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : null;
}

function resolveReviewCycleReviewsRoot(repoRoot: string): string {
    return path.resolve(joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews')));
}

function getReviewCycleArtifactVerdict(
    artifactIndex: ReviewAttemptArtifactIndex,
    repoRoot: string,
    taskId: string,
    reviewType: string,
    details: Record<string, unknown> | null,
    verdictCache: Map<string, ReviewCycleArtifactVerdictResult>
): ReviewCycleArtifactVerdictResult {
    const passToken = REVIEW_VERDICT_PASS_TOKENS[reviewType] || '';
    const failToken = REVIEW_VERDICT_FAIL_TOKENS[reviewType] || '';
    if (!passToken || !failToken) {
        return { failed: null, invalidSnapshot: false };
    }
    const cacheKey = JSON.stringify([
        reviewType,
        details?.review_artifact_snapshot_path ?? details?.reviewArtifactSnapshotPath ?? null,
        details?.review_artifact_snapshot_sha256 ?? details?.reviewArtifactSnapshotSha256 ?? null,
        details?.receipt_snapshot_path ?? details?.receiptSnapshotPath ?? null,
        details?.receipt_snapshot_sha256 ?? details?.receiptSnapshotSha256 ?? null,
        details?.review_artifact_path ?? details?.reviewArtifactPath ?? null,
        details?.review_context_path ?? details?.reviewContextPath ?? null,
        details?.review_context_sha256 ?? details?.reviewContextSha256 ?? null,
        details?.preflight_sha256 ?? details?.preflightSha256 ?? null,
        details?.scope_sha256 ?? details?.scopeSha256 ?? null,
        details?.review_scope_sha256 ?? details?.reviewScopeSha256 ?? null,
        details?.code_scope_sha256 ?? details?.codeScopeSha256 ?? null,
        details?.review_tree_state_sha256 ?? details?.reviewTreeStateSha256 ?? null
    ]);
    const cached = verdictCache.get(cacheKey);
    if (cached !== undefined) {
        return cached;
    }
    const artifactResolution = resolveValidatedReviewCycleArtifactForVerdict({
        artifactIndex,
        repoRoot,
        taskId,
        reviewType,
        details
    });
    if (artifactResolution.invalidSnapshot) {
        const result = { failed: null, invalidSnapshot: true };
        verdictCache.set(cacheKey, result);
        return result;
    }
    const resolvedArtifactPath = artifactResolution.resolvedPath;
    if (!resolvedArtifactPath) {
        return { failed: null, invalidSnapshot: false };
    }
    const snapshotSha256 = normalizeReviewCycleSha256(
        details?.review_artifact_snapshot_sha256 ?? details?.reviewArtifactSnapshotSha256
    );
    if (snapshotSha256) {
        const validationArtifactVerdict = getReviewCycleValidationArtifactVerdict({
            artifactIndex,
            repoRoot,
            taskId,
            reviewType,
            details,
            reviewArtifactSha256: snapshotSha256
        });
        if (validationArtifactVerdict) {
            verdictCache.set(cacheKey, validationArtifactVerdict);
            return validationArtifactVerdict;
        }
    }
    const content = artifactResolution.content || '';
    if (content.trimStart().startsWith('{')) {
        const result = { failed: null, invalidSnapshot: false };
        verdictCache.set(cacheKey, result);
        return result;
    }
    if (!content.includes(passToken) && !content.includes(failToken)) {
        const result = { failed: null, invalidSnapshot: false };
        verdictCache.set(cacheKey, result);
        return result;
    }
    const verdictToken = extractReviewVerdictToken(content, passToken, failToken, reviewType);
    const result = {
        failed: verdictToken === failToken
            ? true
            : verdictToken === passToken
                ? false
                : null,
        invalidSnapshot: false
    };
    verdictCache.set(cacheKey, result);
    return result;
}

function parseReviewCycleTimelineLine(line: string, sequence: number): TimelineEventEntry | null {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const eventType = String(parsed.event_type || '').trim().toUpperCase();
    if (!eventType) {
        return null;
    }
    const details = parsed.details && typeof parsed.details === 'object' && !Array.isArray(parsed.details)
        ? parsed.details as Record<string, unknown>
        : null;
    return {
        event_type: eventType,
        outcome: String(parsed.outcome || '').trim().toUpperCase() || undefined,
        timestamp_utc: String(parsed.timestamp_utc || '').trim(),
        sequence,
        details
    };
}

function buildLatestFailedReviewSummary(
    event: TimelineEventEntry,
    reviewType: string,
    details: Record<string, unknown> | null
): NextStepReviewCycleLatestFailedReview {
    return {
        review_type: reviewType,
        event_type: event.event_type,
        outcome: event.outcome || null,
        verdict_token: getTimelineDetailText(details, ['verdict_token', 'verdictToken']),
        reviewer_identity: getTimelineReviewerIdentity(details) || null,
        review_artifact_path: getTimelineDetailText(details, ['review_artifact_path', 'reviewArtifactPath']),
        summary: getTimelineDetailText(details, ['summary', 'finding_summary', 'findingSummary', 'reason', 'message']),
        sequence: event.sequence,
        timestamp_utc: event.timestamp_utc || null
    };
}

/** A restart or task entry after a result starts its repeat, so that result is no longer what the task relies on. */
const REVIEW_HISTORY_RESTART_BOUNDARIES = new Set([
    'REVIEW_CYCLE_RESTARTED', 'COHERENT_CYCLE_RESTARTED', 'TASK_MODE_ENTERED', 'TASK_RESET'
]);

function readReviewCycleGuardAttemptsUnlocked(
    repoRoot: string,
    timelinePath: string,
    taskId: string,
    reviewCycleGuardConfig: ReviewCycleGuardConfig,
    currentPreflightFingerprints: DomainScopeFingerprints | null,
    artifactIndex: ReviewAttemptArtifactIndex
): ReviewCycleGuardReadResult {
    const resolvedPath = path.resolve(String(timelinePath || ''));
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        return {
            attempts: [],
            timelineValid: false,
            latestFailedReview: null,
            lostCurrentResultReviewTypes: []
        };
    }

    const attemptsByKey = new Map<string, {
        reviewType: string;
        failed: boolean;
        passed: boolean;
        latestEventFailed: boolean;
        reused: boolean;
        scopeHash: string | null;
        currentScope: boolean;
        lastSequence: number;
    }>();
    const verdictCache = new Map<string, ReviewCycleArtifactVerdictResult>();
    const excludedReviewTypes = new Set(reviewCycleGuardConfig.excluded_review_types.map((entry) => entry.trim().toLowerCase()).filter(Boolean));
    let malformedReviewCycleEvent = false;
    let latestFailedReview: NextStepReviewCycleLatestFailedReview | null = null;
    // A lost or altered immutable snapshot is lost evidence of that review only, never a damaged timeline.
    const latestRecordedByLane = new Map<string, { sequence: number; lostSnapshot: boolean }>();
    let lostSupersededSnapshot = false;
    let latestAllLaneRestartSequence = -1;
    const latestLaneRestartSequence = new Map<string, number>();
    let sequence = 0;
    let pending = '';
    const file = fs.openSync(resolvedPath, 'r');
    const buffer = Buffer.alloc(64 * 1024);

    // Lanes whose latest recorded result lost its snapshot and that no later restart has already sent back to review.
    const lostCurrentResultReviewTypes = (): string[] => [...latestRecordedByLane.entries()]
        .filter(([lane, latest]) => latest.lostSnapshot && latest.sequence > latestAllLaneRestartSequence
            && latest.sequence > (latestLaneRestartSequence.get(lane) ?? -1))
        .map(([lane]) => lane);
    const timelineIsValid = (): boolean => {
        if (malformedReviewCycleEvent) return false;
        if (!lostSupersededSnapshot) return true;
        // Authenticate the timeline before using it to separate open attempts from closed archives.
        const openRecords: Array<Readonly<Record<string, unknown>>> = [];
        const inspection = inspectTaskEventFile(resolvedPath, taskId, { onIntegrityEvent: event => {
            if (isAuthenticatedReviewRestartEvent(event, taskId)) openRecords.length = 0;
            else if (event.event_type === 'REVIEW_RECORDED') openRecords.push(event);
        } });
        if (inspection.status !== 'PASS' || inspection.violations.length) return false;
        const latestByLane = new Map<string, number>();
        const detailsOf = (event: Readonly<Record<string, unknown>>): Record<string, unknown> | null => (
            event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                ? event.details as Record<string, unknown> : null
        );
        openRecords.forEach((event, index) => latestByLane.set(getTimelineReviewType(detailsOf(event)), index));
        return openRecords.every((event, index) => {
            const details = detailsOf(event), lane = getTimelineReviewType(details);
            const hasReceiptSnapshot = Boolean(getTimelineDetailText(details, ['receipt_snapshot_path', 'receiptSnapshotPath'])
                || getTimelineDetailText(details, ['receipt_snapshot_sha256', 'receiptSnapshotSha256']));
            if (excludedReviewTypes.has(lane) || latestByLane.get(lane) === index
                || !hasReceiptSnapshot
                || !getTimelineDetailText(details, ['review_artifact_snapshot_path', 'reviewArtifactSnapshotPath'])) return true;
            // A later reuse record of the lane rebinds this very immutable snapshot: losing it is the loss of the latest
            // result, which lane-specific recovery repeats, never damaged history of a separate earlier result.
            const latest = detailsOf(openRecords[latestByLane.get(lane) ?? index]);
            const snapshotSha256 = (record: Record<string, unknown> | null) => normalizeReviewCycleSha256(
                record?.review_artifact_snapshot_sha256 ?? record?.reviewArtifactSnapshotSha256);
            if (latest?.reused_existing_review === true && snapshotSha256(details) !== null
                && snapshotSha256(latest) === snapshotSha256(details)) return true;
            // An earlier committed receipt in the open cycle is still relied upon. Closed archives are checked
            // by the full audit, while the latest lost result is routed to lane-specific recovery.
            try {
                const options = { artifactIndex, repoRoot, taskId, reviewType: lane, details };
                const artifact = resolveValidatedReviewCycleArtifactForVerdict(options);
                if (artifact.invalidSnapshot) return false;
                const sha256 = normalizeReviewCycleSha256(details?.review_artifact_snapshot_sha256 ?? details?.reviewArtifactSnapshotSha256);
                return sha256 !== null && getReviewCycleValidationArtifactVerdict({ ...options, reviewArtifactSha256: sha256 })?.invalidSnapshot !== true;
            } catch {
                return false;
            }
        });
    };
    const handleLine = (rawLine: string): boolean => {
        const line = rawLine.trim();
        if (!line) {
            return false;
        }
        let event: TimelineEventEntry | null = null;
        try {
            event = parseReviewCycleTimelineLine(line, sequence);
        } catch {
            malformedReviewCycleEvent = true;
            return reviewCycleGuardConfig.action === 'BLOCK_FOR_OPERATOR_DECISION';
        } finally {
            sequence += 1;
        }
        if (event && REVIEW_HISTORY_RESTART_BOUNDARIES.has(event.event_type)) {
            // A review-cycle restart repeats only the lanes it invalidated; a restart without that list, a coherent
            // restart, a task entry or a reset repeats every lane.
            const invalidated = event.event_type === 'REVIEW_CYCLE_RESTARTED' ? event.details?.invalidated_review_types : null;
            if (Array.isArray(invalidated)) {
                for (const lane of invalidated) {
                    if (typeof lane === 'string' && lane.trim()) latestLaneRestartSequence.set(lane.trim().toLowerCase(), event.sequence);
                }
            } else {
                latestAllLaneRestartSequence = event.sequence;
            }
        }
        if (!event || event.event_type !== 'REVIEW_RECORDED') {
            return false;
        }
        const reviewType = getTimelineReviewType(event.details);
        if (!reviewType) {
            malformedReviewCycleEvent = true;
            return reviewCycleGuardConfig.action === 'BLOCK_FOR_OPERATOR_DECISION';
        }
        const reviewerIdentity = getTimelineReviewerIdentity(event.details);
        const reviewContextSha256 = getTimelineReviewContextSha256(event.details);
        const key = reviewerIdentity && reviewContextSha256
            ? `${reviewType}|${reviewerIdentity}|${reviewContextSha256}`
            : `${event.event_type}:${event.sequence}`;
        const timelineFailure = getTimelineReviewFailure(event.event_type, event.details, event.outcome || null);
        const hasArtifactEvidence = Boolean(getTimelineDetailText(event.details, [
            'review_artifact_snapshot_path',
            'reviewArtifactSnapshotPath',
            'review_artifact_path',
            'reviewArtifactPath'
        ]));
        const artifactVerdict = event.event_type === 'REVIEW_RECORDED' && hasArtifactEvidence
            ? getReviewCycleArtifactVerdict(artifactIndex, repoRoot, taskId, reviewType, event.details, verdictCache)
            : { failed: null, invalidSnapshot: false };
        const countedLane = reviewType.trim().toLowerCase();
        if (!excludedReviewTypes.has(countedLane) && latestRecordedByLane.get(countedLane)?.lostSnapshot) {
            lostSupersededSnapshot = true;
        }
        latestRecordedByLane.set(countedLane, { sequence: event.sequence, lostSnapshot: artifactVerdict.invalidSnapshot });
        if (artifactVerdict.invalidSnapshot && excludedReviewTypes.has(countedLane)) {
            // Excluded review types never count toward the guard, so their lost history changes nothing here.
            return false;
        }
        // Without its snapshot the attempt counts from the gate-signed verdict; an unreadable verdict counts as
        // failed, which can only tighten the limit.
        const failed = artifactVerdict.invalidSnapshot
            ? timelineFailure ?? getSignedDispositionFailure(event.details) ?? true
            : timelineFailure ?? artifactVerdict.failed ?? false;
        const hasReviewArtifactPath = Boolean(getTimelineDetailText(event.details, ['review_artifact_path', 'reviewArtifactPath']));
        const passed = !failed && (
            timelineFailure === false
            || artifactVerdict.failed === false
            || (event.outcome === 'PASS' && !hasReviewArtifactPath)
        );
        const reused = event.details?.reused_existing_review === true || event.details?.reusedExistingReview === true;
        const scopeHash = getReviewCycleAttemptScopeHash(reviewType, event.details);
        const currentScope = reviewCycleAttemptMatchesCurrentScope(reviewType, event.details, currentPreflightFingerprints);
        const existing = attemptsByKey.get(key);
        const existingFailed = Boolean(existing?.failed);
        const existingPassed = Boolean(existing?.passed);
        const nextFailed = Boolean(existingFailed || failed);
        const nextPassed = Boolean(!nextFailed && (existingPassed || passed));
        attemptsByKey.set(key, {
            reviewType,
            failed: nextFailed,
            passed: nextPassed,
            latestEventFailed: Boolean(failed),
            reused: existing ? Boolean(existing.reused && reused) : reused,
            scopeHash: existing?.scopeHash || scopeHash,
            currentScope: Boolean(existing?.currentScope || currentScope),
            lastSequence: event.sequence
        });
        const countedReviewType = reviewType.trim().toLowerCase();
        const countsTowardGuard = countedReviewType && !excludedReviewTypes.has(countedReviewType);
        if (!existingFailed && nextFailed && countsTowardGuard && !reused) {
            latestFailedReview = buildLatestFailedReviewSummary(event, countedReviewType, event.details);
        }
        return false;
    };

    try {
        let bytesRead = 0;
        do {
            bytesRead = fs.readSync(file, buffer, 0, buffer.length, null);
            if (bytesRead <= 0) {
                break;
            }
            pending += buffer.subarray(0, bytesRead).toString('utf8');
            let newlineIndex = pending.indexOf('\n');
            while (newlineIndex >= 0) {
                const line = pending.slice(0, newlineIndex).replace(/\r$/, '');
                pending = pending.slice(newlineIndex + 1);
                if (handleLine(line)) {
                    return {
                        attempts: countNextStepArrayCopy('visit:next-step-review-cycle-guard-attempts:copy:554', [...attemptsByKey.values()]).sort((left, right) => (countNextStepWork('visit:next-step-review-cycle-guard-attempts:event:554'), left.lastSequence - right.lastSequence)),
                        timelineValid: timelineIsValid(),
                        latestFailedReview,
                        lostCurrentResultReviewTypes: lostCurrentResultReviewTypes()
                    };
                }
                newlineIndex = pending.indexOf('\n');
            }
        } while (bytesRead > 0);
        if (pending.trim() && handleLine(pending.replace(/\r$/, ''))) {
            return {
                attempts: countNextStepArrayCopy('visit:next-step-review-cycle-guard-attempts:copy:564', [...attemptsByKey.values()]).sort((left, right) => (countNextStepWork('visit:next-step-review-cycle-guard-attempts:event:564'), left.lastSequence - right.lastSequence)),
                timelineValid: timelineIsValid(),
                latestFailedReview,
                lostCurrentResultReviewTypes: lostCurrentResultReviewTypes()
            };
        }
    } finally {
        fs.closeSync(file);
    }

    return {
        attempts: countNextStepArrayCopy('visit:next-step-review-cycle-guard-attempts:copy:574', [...attemptsByKey.values()]).sort((left, right) => (countNextStepWork('visit:next-step-review-cycle-guard-attempts:event:574'), left.lastSequence - right.lastSequence)),
        timelineValid: timelineIsValid(),
        latestFailedReview,
        lostCurrentResultReviewTypes: lostCurrentResultReviewTypes()
    };
}

export function readReviewCycleGuardAttempts(
    repoRoot: string,
    timelinePath: string,
    taskId: string,
    reviewCycleGuardConfig: ReviewCycleGuardConfig,
    currentPreflightFingerprints: DomainScopeFingerprints | null
): ReviewCycleGuardReadResult {
    const reviewsRoot = resolveReviewCycleReviewsRoot(repoRoot);
    return withReviewArtifactReadBarrier(reviewsRoot, () => readReviewCycleGuardAttemptsUnlocked(
        repoRoot,
        timelinePath,
        taskId,
        reviewCycleGuardConfig,
        currentPreflightFingerprints,
        createReviewAttemptArtifactIndex(reviewsRoot, taskId)
    ));
}
