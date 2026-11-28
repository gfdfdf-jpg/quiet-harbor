import { measureNextStepPhase } from '../../core/next-step-measurement';
import * as path from 'node:path';

import { getNodeCliCommandForTarget } from '../../materialization/command-constants';
import {
    assertValidTaskId
} from '../../gate-runtime/task-events';
import { readInvocationVerifiedEventIndex } from '../../gate-runtime/timeline/task-events-integrity';
import { verifiedEventPosition } from '../../gate-runtime/timeline/task-verified-event-index';
import {
    resolveEventsRoot,
    resolveReviewsRoot
} from '../task-audit/task-audit-summary-collectors';
import {
    isPathRealpathInsideRoot,
    normalizePath
} from '../shared/helpers';
import { resolveRulePackArtifactPath } from '../rule-pack/rule-pack-artifact-store';
import { isPlainRecord } from '../../core/records';
import {
    toRepoDisplayPath
} from './next-step-command-formatters';
import {
    readNextStepReadinessArtifacts,
    type NextStepReadinessArtifacts
} from './next-step-readiness-readers';
import {
    resolveActiveTaskModeArtifactPath
} from './next-step-preflight-recovery';

export interface NextStepOptions {
    taskId: string;
    repoRoot: string;
    eventsRoot?: string | null;
    reviewsRoot?: string | null;
    preflightPath?: string | null;
    /** The bounded validation-inspection retry the previous answer stated (`<attempt>:<content witness>`). */
    inspectionRetry?: string | null;
}

export interface NextStepResolutionContext {
    repoRoot: string;
    taskId: string;
    reviewsRoot: string;
    eventsRoot: string;
    cliPrefix: string;
    taskModePath: string;
    preflightCommandPath: string;
    readinessArtifacts: NextStepReadinessArtifacts;
    preflightPath: string;
    rulePackPath: string;
    rulePackCommandPath: string | null;
    preflight: Record<string, unknown> | null;
    rulePack: Record<string, unknown> | null;
    taskMode: Record<string, unknown> | null;
    preflightSha256: string | null;
    taskEventsPath: string;
    inspectionRetry: string | null;
}

export function buildCliPrefix(repoRoot: string): string {
    return getNodeCliCommandForTarget(repoRoot);
}

function assertRuntimeRootInsideRepo(repoRoot: string, runtimeRoot: string, label: string): void {
    if (isPathRealpathInsideRoot(runtimeRoot, repoRoot, { allowMissing: true })) {
        return;
    }
    throw new Error(
        `${label} must resolve inside repo root without symlink or junction escape: ${normalizePath(runtimeRoot)}.`
    );
}

function readActiveRulePackPath(repoRoot: string, taskId: string, taskEventsPath: string, preflightPath: string): string | null {
    const index = readInvocationVerifiedEventIndex(taskEventsPath, taskId);
    if (!index) return null;
    const taskMode = index.byTrimmedType.TASK_MODE_ENTERED?.at(-1);
    const taskModePosition = taskMode && verifiedEventPosition(taskMode);
    if (taskModePosition === undefined) return null;
    const latestPosition = (type: string) => {
        const event = index.byTrimmedType[type]?.at(-1);
        return event ? verifiedEventPosition(event) ?? -1 : -1;
    };
    const reviewStarted = latestPosition('REVIEW_PHASE_STARTED');
    const reviewPassed = Math.max(latestPosition('REVIEW_GATE_PASSED'), latestPosition('REVIEW_GATE_PASSED_WITH_OVERRIDE'));
    const ruleLoadFailures = index.byTrimmedType.RULE_PACK_LOAD_FAILED ?? [];
    const events = index.byTrimmedType.RULE_PACK_LOADED ?? [];
    let entryArtifact: string | null = null;
    let entryPosition = -1;
    let postArtifact: string | null = null;
    let postPosition = -1;
    for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        const position = verifiedEventPosition(event) ?? -1;
        if (position <= taskModePosition) break;
        if (event.actor !== 'gate' || event.outcome !== 'PASS' || !event.integrity || !isPlainRecord(event.details)) continue;
        const { stage, artifact_path: artifact, preflight_path: preflight } = event.details;
        if (typeof artifact !== 'string' || !artifact.trim()) continue;
        if (!entryArtifact && stage === 'TASK_ENTRY') {
            entryArtifact = artifact;
            entryPosition = position;
            if (reviewStarted <= taskModePosition || entryPosition <= reviewStarted
                || (reviewPassed > reviewStarted && reviewPassed < entryPosition)) break;
        }
        if (!postArtifact && stage === 'POST_PREFLIGHT' && typeof preflight === 'string'
            && path.relative(preflightPath, path.resolve(repoRoot, preflight)) === '') {
            postArtifact = artifact;
            postPosition = position;
        }
        if (entryArtifact && postArtifact) break;
    }
    // During an active review, a late TASK_ENTRY load alone does not replace the downstream stage
    // that backed the review. Startup still checks the latest entry and routes any required recovery.
    const preserveReview = reviewStarted > taskModePosition && postPosition < reviewStarted
        && entryPosition > reviewStarted && !(reviewPassed > reviewStarted && reviewPassed < entryPosition)
        && !ruleLoadFailures.some(event => {
            const position = verifiedEventPosition(event) ?? -1;
            return position > reviewStarted && position < entryPosition
                && isPlainRecord(event.details) && event.details.stage === 'POST_PREFLIGHT';
        });
    const selectedArtifact = preserveReview && postArtifact ? postArtifact : entryArtifact ?? postArtifact;
    const artifactPath = selectedArtifact ? path.resolve(repoRoot, selectedArtifact) : null;
    return artifactPath && isPathRealpathInsideRoot(artifactPath, repoRoot, { allowMissing: true }) ? artifactPath : null;
}

export function createNextStepResolutionContext(options: NextStepOptions): NextStepResolutionContext {
    return measureNextStepPhase('context', () => {
    const repoRoot = path.resolve(options.repoRoot || '.');
    const taskId = assertValidTaskId(options.taskId);
    const reviewsRoot = resolveReviewsRoot(repoRoot, options.reviewsRoot);
    const eventsRoot = resolveEventsRoot(repoRoot, options.eventsRoot);
    assertRuntimeRootInsideRepo(repoRoot, reviewsRoot, 'ReviewsRoot');
    assertRuntimeRootInsideRepo(repoRoot, eventsRoot, 'EventsRoot');
    const cliPrefix = buildCliPrefix(repoRoot);
    const taskModePath = resolveActiveTaskModeArtifactPath(repoRoot, eventsRoot, reviewsRoot, taskId);
    const preflightArtifactPath = options.preflightPath
        ? path.resolve(repoRoot, options.preflightPath)
        : path.join(reviewsRoot, `${taskId}-preflight.json`);
    assertRuntimeRootInsideRepo(repoRoot, preflightArtifactPath, 'PreflightPath');
    const preflightCommandPath = toRepoDisplayPath(repoRoot, preflightArtifactPath);
    const taskEventsPath = path.join(eventsRoot, `${taskId}.jsonl`);
    const readinessArtifacts = readNextStepReadinessArtifacts({
        reviewsRoot,
        taskId,
        taskModePath,
        preflightPath: preflightArtifactPath,
        preflightCommandPath,
        rulePackPath: readActiveRulePackPath(repoRoot, taskId, taskEventsPath, preflightArtifactPath)
    });
    const { preflightPath, rulePackPath } = readinessArtifacts.paths;
    const rulePackCommandPath = path.relative(resolveRulePackArtifactPath(repoRoot, taskId, ''), rulePackPath) === ''
        ? null : toRepoDisplayPath(repoRoot, rulePackPath);
    const { preflight, rulePack, taskMode, preflightSha256 } = readinessArtifacts;

    return {
        repoRoot,
        taskId,
        reviewsRoot,
        eventsRoot,
        cliPrefix,
        taskModePath,
        preflightCommandPath,
        readinessArtifacts,
        preflightPath,
        rulePackPath,
        rulePackCommandPath,
        preflight,
        rulePack,
        taskMode,
        preflightSha256,
        taskEventsPath,
        inspectionRetry: options.inspectionRetry ?? null
    };

    });
}
