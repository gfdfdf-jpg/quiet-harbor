import { recordedOutOfScopeFollowUpViolations } from '../full-suite/recorded-out-of-scope-follow-ups';
import { resolveRestartTaskIntent } from '../review-context/review-context-task-criteria-binding';
import * as path from 'node:path';
import { buildCoherentCycleRestartCommand } from '../completion/completion-reporting';

import {
    getReviewExecutionDependencies,
    type EffectiveReviewExecutionPolicyMode
} from '../../core/review-execution-policy';
import {
    buildCommand,
    toRepoDisplayPath
} from './next-step-command-formatters';
import {
    buildScopedDiffCommand,
    buildRestartReviewCycleCommand
} from './next-step-review-command-builders';
import {
    buildRequiredReviewsCheckInvocation,
    buildReviewContextCommand,
    getEffectiveDepthForPostPreflightRules
} from './next-step-lifecycle-command-builders';
import {
    getScopedDiffMetadataReadiness,
    scopedDiffExpectedForReview,
    type ReviewArtifactState
} from './next-step-review-artifact-readers';
import {
    buildReviewGateChainStatusSummary,
    findDownstreamReviewNeedingDependencyRebind,
    findReviewGateStaleContextPrecheckRecovery,
    findReviewGateStaleUpstreamRecovery,
    reviewStateHasSatisfiedEvidence,
    timelineHasReviewReuseRecordedAfterCompile
} from './next-step-review-evidence';
import {
    buildReviewerReadinessChainSummary
} from './next-step-reviewer-launch-evidence';
import {
    resolveDownstreamDependencyRebindRoute,
    resolveReviewGateStaleContextPrecheckRecoveryRoute,
    resolveReviewGateStaleUpstreamRecoveryRoute
} from './next-step-review-reuse-routing';
import {
    resolvePostReviewCloseoutRouteFromState,
    type PostReviewCloseoutRouteState
} from './next-step-closeout-routing';
import type {
    NextStepDecisionRoutePayload
} from './next-step-decision-route-groups';
import { buildFollowUpMaterializationCommand } from './next-step-follow-up-materialization-command';
import { finalizeReviewEvidenceOnlyRestartRoute } from './next-step-review-evidence-only-restart';
import { resolveCompiledReviewDependencyGraphFromPreflight } from '../../core/review-dependency-graph';
import { joinOrchestratorPath } from '../shared/helpers';
import {
    findUnmaterializedLaneRecoveryCandidates,
    readMatchingReviewFollowUpBlockedAttempt
} from '../review/review-follow-up-attempt-binding';

type PostReviewRoute = NextStepDecisionRoutePayload;
type PostReviewRouteResolver = () => PostReviewRoute | null;
type PostReviewCommand = PostReviewRoute['commands'][number];

export interface PostReviewLifecycleRouteResolvers {
    resolveDownstreamDependencyRebindRoute: PostReviewRouteResolver;
    resolveStaleUpstreamRecoveryRoute: PostReviewRouteResolver;
    resolveStaleContextRecoveryRoute: PostReviewRouteResolver;
    resolveGroupedFollowUpRoute: PostReviewRouteResolver;
    resolveCloseoutRoute: PostReviewRouteResolver;
}

export interface PostReviewLifecycleStateOptions {
    repoRoot: string;
    eventsRoot: string;
    reviewsRoot: string;
    taskId: string;
    cliPrefix: string;
    preflight: Record<string, unknown> | null;
    preflightPath: string;
    preflightCommandPath: string;
    preflightSha256: string | null;
    taskMode: Record<string, unknown> | null;
    taskModePath: string | null;
    reviewGateAlreadyPassed: boolean;
    requiredReviewTypes: string[];
    requiredReviews: Record<string, boolean>;
    reviewPolicyMode: EffectiveReviewExecutionPolicyMode;
    reviewStates: readonly ReviewArtifactState[];
    closeoutState: Omit<PostReviewCloseoutRouteState, 'requiredReviewsCommand' | 'requiredReviewsOperation'>;
}

export function resolvePostReviewLifecycleDecisionRoute(
    resolvers: PostReviewLifecycleRouteResolvers
): PostReviewRoute | null {
    const orderedResolvers: readonly PostReviewRouteResolver[] = [
        resolvers.resolveDownstreamDependencyRebindRoute,
        resolvers.resolveStaleUpstreamRecoveryRoute,
        resolvers.resolveStaleContextRecoveryRoute,
        resolvers.resolveGroupedFollowUpRoute,
        resolvers.resolveCloseoutRoute
    ];
    for (const resolveRoute of orderedResolvers) {
        const route = resolveRoute();
        if (route) {
            return route;
        }
    }
    return null;
}

function buildReviewRecoveryRouteContext(
    options: Omit<PostReviewLifecycleStateOptions, 'closeoutState'>,
    reviewType: string,
    state: ReviewArtifactState,
    reason: string,
    buildReviewContextLabel: string
): {
    scopedDiffReadiness: { ready: boolean; reason: string };
    reviewerReadinessChain: string;
    reviewContextChain: string;
    commands: {
        buildScopedDiff: PostReviewCommand;
        buildReviewContext: PostReviewCommand;
    };
} {
    const reviewDepth = getEffectiveDepthForPostPreflightRules(options.preflight, options.taskMode);
    const reviewerReadinessChain = buildReviewerReadinessChainSummary(
        options.repoRoot,
        options.eventsRoot,
        options.taskId,
        reviewType,
        state,
        (candidateState) => reviewStateHasSatisfiedEvidence(
            options.repoRoot,
            options.eventsRoot,
            options.taskId,
            candidateState
        )
    );
    const reviewContextChain = buildReviewGateChainStatusSummary({
        repoRoot: options.repoRoot,
        eventsRoot: options.eventsRoot,
        taskId: options.taskId,
        reviewType,
        edgeId: 'compile-to-review-context',
        reason,
        preflightPath: options.preflightCommandPath,
        reviewContextPath: state.contextPath
            ? toRepoDisplayPath(options.repoRoot, state.contextPath)
            : undefined,
        depth: reviewDepth
    });
    const scopedDiffMetadataPath = path.join(options.reviewsRoot, `${options.taskId}-${reviewType}-scoped.json`);
    const scopedDiffOutputPath = path.join(options.reviewsRoot, `${options.taskId}-${reviewType}-scoped.diff`);
    const scopedDiffReadiness = scopedDiffExpectedForReview({
        preflight: options.preflight,
        reviewType
    })
        ? getScopedDiffMetadataReadiness({
            metadataPath: scopedDiffMetadataPath,
            preflight: options.preflight,
            preflightPath: options.preflightPath,
            preflightSha256: options.preflightSha256,
            reviewType
        })
        : { ready: true, reason: 'Scoped diff metadata is not required for this review context.' };
    return {
        scopedDiffReadiness,
        reviewerReadinessChain,
        reviewContextChain,
        commands: {
            buildScopedDiff: buildCommand(
                'Build scoped diff',
                buildScopedDiffCommand({
                    cliPrefix: options.cliPrefix,
                    reviewType,
                    preflightCommandPath: options.preflightCommandPath,
                    outputPath: toRepoDisplayPath(options.repoRoot, scopedDiffOutputPath),
                    metadataPath: toRepoDisplayPath(options.repoRoot, scopedDiffMetadataPath)
                })
            ),
            buildReviewContext: buildCommand(
                buildReviewContextLabel,
                buildReviewContextCommand(
                    options.repoRoot,
                    options.cliPrefix,
                    options.taskId,
                    reviewType,
                    reviewDepth,
                    options.preflightCommandPath,
                    options.taskModePath
                )
            )
        }
    };
}

export function resolveDownstreamDependencyRebindDecisionRoute(
    options: Omit<PostReviewLifecycleStateOptions, 'closeoutState'>
): PostReviewRoute | null {
    const dependencyGraph = options.preflight
        ? resolveCompiledReviewDependencyGraphFromPreflight(options.preflight, options.reviewPolicyMode)
        : null;
    const dependencyRebind = options.reviewGateAlreadyPassed
        ? null
        : findDownstreamReviewNeedingDependencyRebind({
            eventsRoot: options.eventsRoot,
            taskId: options.taskId,
            requiredReviewTypes: options.requiredReviewTypes,
            requiredReviews: options.requiredReviews,
            policyMode: options.reviewPolicyMode,
            reviewStates: options.reviewStates,
            dependencyGraph
        });
    if (!dependencyRebind) {
        return null;
    }
    const reviewType = dependencyRebind.downstreamState.reviewType;
    // This check also runs before fresh launches. Do not offer a rebind whose upstream
    // evidence still needs recovery; build-review-context would refuse the same inputs.
    const dependencies = getReviewExecutionDependencies(reviewType, options.requiredReviews, options.reviewPolicyMode,
        dependencyGraph);
    if (dependencies.some(dependency => {
        const state = options.reviewStates.find(candidate => candidate.reviewType === dependency);
        return !state || !reviewStateHasSatisfiedEvidence(options.repoRoot, options.eventsRoot, options.taskId, state);
    })) return null;
    const context = buildReviewRecoveryRouteContext(
        options,
        reviewType,
        dependencyRebind.downstreamState,
        `latest upstream '${dependencyRebind.upstreamReviewType}' review evidence is recorded before re-binding '${reviewType}' review context`,
        'Build review context'
    );
    return resolveDownstreamDependencyRebindRoute({
        reviewPolicyMode: options.reviewPolicyMode,
        downstreamReviewType: reviewType,
        upstreamReviewType: dependencyRebind.upstreamReviewType,
        ...context
    });
}

function resolveStaleUpstreamRecoveryDecisionRoute(
    options: PostReviewLifecycleStateOptions
): PostReviewRoute | null {
    // Restarts name the current preflight's intent, so passed reviews keep their criteria binding.
    const restartTaskIntent = (): string => resolveRestartTaskIntent({
        repoRoot: options.repoRoot, taskId: options.taskId, preflight: options.preflight, taskMode: options.taskMode
    }) || options.taskId;
    const recovery = options.reviewGateAlreadyPassed
        ? null
        : findReviewGateStaleUpstreamRecovery({
            repoRoot: options.repoRoot,
            eventsRoot: options.eventsRoot,
            taskId: options.taskId,
            requiredReviewTypes: options.requiredReviewTypes,
            requiredReviews: options.requiredReviews,
            policyMode: options.reviewPolicyMode,
            reviewStates: options.reviewStates
        });
    if (!recovery) {
        return null;
    }
    if (recovery.kind === 'lost-review-evidence' && recovery.reviewType && options.preflight) {
        const reviewType = recovery.reviewType;
        const taskIntent = restartTaskIntent();
        const restart = (reviewEvidenceOnly: boolean) => buildCommand('Recover lost review evidence', buildRestartReviewCycleCommand(
            options.repoRoot, options.cliPrefix, options.taskId, taskIntent,
            options.preflightCommandPath, options.taskModePath, [],
            { includeChangedFileScope: false, reviewType, reviewEvidenceOnly }
        ));
        return finalizeReviewEvidenceOnlyRestartRoute({
            status: 'BLOCKED' as const,
            nextGate: 'restart-review-cycle',
            title: `Recover lost '${reviewType}' review evidence.`,
            reason: `${recovery.violation} Repeat the review whose receipt-bound evidence is lost; do not reconstruct it by hand.`,
            commands: [restart(true)]
        }, () => ({
            ...options, reviewType, preflight: options.preflight!, requiredReviewTypes: options.requiredReviewTypes,
            dependencyGraph: resolveCompiledReviewDependencyGraphFromPreflight(options.preflight!, options.reviewPolicyMode),
            ordinaryRestart: restart(false)
        }));
    }
    if (recovery.kind !== 'stale-upstream') {
        return {
            status: 'BLOCKED',
            nextGate: 'restart-coherent-cycle',
            title: 'Restart ordered reviews after lost upstream evidence.',
            reason: recovery.kind === 'dependency-order'
                ? `${recovery.violation} Rebuilding review context cannot repair the earlier launch order. `
                    + 'Run restart-coherent-cycle to start fresh ordered reviews from the current evidence.'
                : `${recovery.violation} Run restart-coherent-cycle for fresh ordered reviews; `
                    + 'do not reconstruct lost receipt-bound evidence or repeat an unrelated upstream context rebind.',
            commands: [buildCommand('Restart coherent cycle', buildCoherentCycleRestartCommand(
                options.repoRoot, options.taskId, options.preflightCommandPath, options.taskModePath, null, null,
                { requiresOperatorConfirmation: options.taskMode?.orchestrator_work === true || options.taskMode?.workflow_config_work === true,
                    taskIntent: restartTaskIntent() }
            ))]
        };
    }
    const reviewType = recovery.upstreamReviewType;
    const context = buildReviewRecoveryRouteContext(
        options,
        reviewType,
        recovery.upstreamState,
        `latest review gate failure seq ${recovery.latestReviewGateFailureSequence} ` +
            `rejected stale upstream '${reviewType}' context/routing before downstream ` +
            `'${recovery.downstreamReviewType}' closeout validation`,
        'Build upstream review context'
    );
    return resolveReviewGateStaleUpstreamRecoveryRoute({
        upstreamReviewType: reviewType,
        reuseCandidateHint:
            recovery.upstreamState.reusedExistingReview
            && timelineHasReviewReuseRecordedAfterCompile(
                options.eventsRoot,
                options.taskId,
                recovery.upstreamState
            )
                ? 'current-context-candidate'
                : 'validation-required',
        ...context
    });
}

function resolveStaleContextRecoveryDecisionRoute(
    options: PostReviewLifecycleStateOptions
): PostReviewRoute | null {
    const recovery = options.reviewGateAlreadyPassed
        ? null
        : findReviewGateStaleContextPrecheckRecovery({
            repoRoot: options.repoRoot,
            eventsRoot: options.eventsRoot,
            taskId: options.taskId,
            requiredReviewTypes: options.requiredReviewTypes,
            reviewStates: options.reviewStates
        });
    if (!recovery) {
        return null;
    }
    const context = buildReviewRecoveryRouteContext(
        options,
        recovery.reviewType,
        recovery.state,
        `current '${recovery.reviewType}' review context must be rebound before required-reviews-check`,
        'Build review context'
    );
    return resolveReviewGateStaleContextPrecheckRecoveryRoute({
        reviewType: recovery.reviewType,
        ...context
    });
}

function buildReviewAuthorshipAttestationDefaults(
    options: PostReviewLifecycleStateOptions
): Record<string, boolean> {
    return Object.fromEntries(options.requiredReviewTypes.map((reviewType) => {
        const state = options.reviewStates.find((candidate) => candidate.reviewType === reviewType);
        return [
            reviewType,
            state
                ? reviewStateHasSatisfiedEvidence(options.repoRoot, options.eventsRoot, options.taskId, state)
                : false
        ];
    }));
}

function resolveRecordedOutOfScopeFollowUpRoute(
    options: PostReviewLifecycleStateOptions,
    authorshipDefaults: Record<string, boolean>
): PostReviewRoute | null {
    const allRequiredReviewLanesSatisfied = Object.values(authorshipDefaults).every(Boolean);
    if (allRequiredReviewLanesSatisfied
        && recordedOutOfScopeFollowUpViolations(options.repoRoot, options.taskId).length) {
        return { status: 'BLOCKED', nextGate: 'materialize-review-follow-up-tasks',
            title: 'Materialize recorded out-of-scope failures.',
            reason: 'Create and verify the recorded failure follow-up before closeout, independently of review lanes and review follow-up policy.',
            commands: [buildFollowUpMaterializationCommand('Materialize recorded failure follow-up', options.cliPrefix, {
                task_id: options.taskId, review_type: 'recorded-out-of-scope', review_types: [], disposition_artifact_path: null,
                receipt_path: null, artifact_path: null, reviews_root: null
            })] };
    }
    return null;
}

function groupedFollowUpLanePathsAreStandard(
    options: Pick<PostReviewLifecycleStateOptions, 'reviewsRoot' | 'taskId'>,
    state: ReviewArtifactState
): boolean {
    const standardDispositionPath = path.join(
        options.reviewsRoot, `${options.taskId}-${state.reviewType}-findings-disposition.json`
    );
    const standardReceiptPath = path.join(options.reviewsRoot, `${options.taskId}-${state.reviewType}-receipt.json`);
    const dispositionArtifactPath = state.reviewFindingsDispositionArtifactPath || standardDispositionPath;
    const followUpArtifactPath = state.reviewFindingsFollowUpArtifactPath
        || dispositionArtifactPath.replace(/-findings-disposition\.json$/u, '-findings-follow-ups.json');
    return path.resolve(dispositionArtifactPath) === path.resolve(standardDispositionPath)
        && path.resolve(followUpArtifactPath)
            === path.resolve(standardDispositionPath.replace(/-findings-disposition\.json$/u, '-findings-follow-ups.json'))
        && path.resolve(state.receiptPath || standardReceiptPath) === path.resolve(standardReceiptPath);
}

function formatReviewTypeList(reviewTypes: readonly string[]): string {
    return reviewTypes.map((reviewType) => `'${reviewType}'`).join(', ');
}

function buildReviewsRootValue(options: Pick<PostReviewLifecycleStateOptions, 'repoRoot' | 'reviewsRoot'>): string | null {
    return path.resolve(options.reviewsRoot) === path.resolve(
        joinOrchestratorPath(options.repoRoot, path.join('runtime', 'reviews'))
    ) ? null : toRepoDisplayPath(options.repoRoot, options.reviewsRoot);
}

function buildReviewsRootOption(options: Pick<PostReviewLifecycleStateOptions, 'repoRoot' | 'reviewsRoot'>): string {
    const value = buildReviewsRootValue(options);
    return value === null ? '' : `--reviews-root "${value}" `;
}

function resolveRepeatedGroupedFollowUpFailureRoute(
    options: Pick<PostReviewLifecycleStateOptions, 'repoRoot' | 'reviewsRoot' | 'taskId' | 'cliPrefix'>,
    reviewTypes: readonly string[]
): PostReviewRoute | null {
    const attemptInput = {
        repoRoot: options.repoRoot,
        reviewsRoot: options.reviewsRoot,
        taskId: options.taskId,
        reviewTypes
    };
    const recorded = readMatchingReviewFollowUpBlockedAttempt(attemptInput);
    if (!recorded) {
        return null;
    }
    const cause = recorded.violations.slice(0, 3).join(' ') || 'The recorded attempt reported no details.';
    // Recovery is offered only after a registry refusal (or a refused confirmed
    // run), and only when it covers every pending lane that has no artifact and
    // every pending lane the current child does not bind. The exact recovery that
    // was already refused for these inputs is never offered again.
    const candidates = recorded.refusalCode === 'current_registry'
        || (recorded.refusalCode === 'confirmed_lane' && recorded.confirmedReviewTypes.length > 0)
        ? findUnmaterializedLaneRecoveryCandidates(attemptInput)
        : null;
    const sameLanes = (left: readonly string[], right: readonly string[]): boolean => (
        JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
    );
    const recovery = candidates
        && sameLanes(candidates.reviewTypes, candidates.lanesWithoutArtifact)
        && sameLanes(candidates.reviewTypes, candidates.unboundPendingLanes)
        && !sameLanes(candidates.reviewTypes, recorded.confirmedReviewTypes)
        ? candidates
        : null;
    if (recovery) {
        return {
            status: 'BLOCKED',
            nextGate: 'operator-maintenance',
            title: 'Grouped review follow-up lanes need operator-confirmed recovery.',
            reason:
                `The materialization command for ${formatReviewTypeList(reviewTypes)} was already blocked against the ` +
                `same inputs. Cause: ${cause} Lanes ${formatReviewTypeList(recovery.reviewTypes)} have pending deferred ` +
                `items but no follow-up artifact and no binding in '${recovery.childTaskId}', and Garda cannot tell a ` +
                'lane that was never materialized from one whose artifact was erased. Ask the operator to confirm ' +
                'that these lanes were never materialized in this review cycle. Run the command only after genuine ' +
                'operator approval, replacing both placeholders with the exact value yes and the ISO-8601 timestamp ' +
                'of that approval; never fill them in without it. Do not edit evidence or TASK.md registries.',
            commands: [buildCommand(
                'Recover never-materialized grouped follow-up lanes after operator confirmation',
                `${options.cliPrefix} gate materialize-review-follow-up-tasks ` +
                    `--task-id "${options.taskId}" ` +
                    `--review-types "${[...reviewTypes].sort().join(',')}" ` +
                    `--operator-confirmed-unmaterialized-lanes "${recovery.reviewTypes.join(',')}" ` +
                    '--operator-confirmed "<yes, only after genuine operator approval>" ' +
                    '--operator-confirmed-at-utc "<ISO-8601 timestamp of the operator approval>" ' +
                    buildReviewsRootOption(options) +
                    '--repo-root "."'
            )]
        };
    }
    return {
        status: 'BLOCKED',
        nextGate: 'operator-maintenance',
        title: 'Grouped review follow-up materialization already failed for the current inputs.',
        reason:
            `The materialization command for ${formatReviewTypeList(reviewTypes)} was already blocked against the ` +
            'same review cycle, receipts, follow-up artifacts and TASK.md follow-up rows, so repeating it cannot ' +
            `succeed. Cause: ${cause} Operator recovery required; do not edit evidence or TASK.md registries.`,
        commands: []
    };
}

/**
 * After completion passes, grouped follow-up materialization publishes once. When several lanes still hold unmaterialized deferred items, one
 * command binds all of them to the same grouped child, so a cycle that mixes
 * fresh and reused lanes cannot dead-end between lane-by-lane updates. A command
 * that already failed against unchanged inputs is not prescribed again.
 */
export function resolveGroupedFollowUpMaterializationRoute(
    options: Pick<PostReviewLifecycleStateOptions, 'repoRoot' | 'reviewsRoot' | 'taskId' | 'cliPrefix' | 'reviewStates'>,
    allRequiredReviewLanesSatisfied: boolean
): PostReviewRoute | null {
    const pendingStates = allRequiredReviewLanesSatisfied
        ? options.reviewStates.filter((candidate) => (
            candidate.reviewFollowUpMaterializationMode === 'grouped_by_parent'
            && candidate.ready
            && candidate.reviewFindingsDisposition
            && (candidate.reviewFindingsDisposition.counts_by_action.create_follow_up > 0 || candidate.previouslyBoundGroupedLane)
            && !candidate.reviewFindingsFollowUpSatisfied
        ))
        : [];
    const [state] = pendingStates;
    if (!state) {
        return null;
    }
    const reviewTypes = [...new Set(pendingStates.map((candidate) => candidate.reviewType))].sort();
    const standardLanePaths = pendingStates.every((candidate) => groupedFollowUpLanePathsAreStandard(options, candidate));
    const batchForm = standardLanePaths || pendingStates.length > 1;
    // Only the standard batch command is ever recorded as refused, so only the
    // batch prescription can be stopped by a recorded refusal.
    const repeatedFailureRoute = batchForm && standardLanePaths
        ? resolveRepeatedGroupedFollowUpFailureRoute(options, reviewTypes)
        : null;
    if (repeatedFailureRoute) {
        return repeatedFailureRoute;
    }
    if (batchForm) {
        if (!standardLanePaths) {
            return {
                status: 'BLOCKED',
                nextGate: 'operator-maintenance',
                title: 'Grouped review follow-up lanes use non-standard evidence paths.',
                reason:
                    `Deferred items from ${formatReviewTypeList(reviewTypes)} must be added to one grouped follow-up ` +
                    'task in one step, and that step reads each lane\'s standard disposition, receipt and follow-up ' +
                    'artifact paths. At least one pending lane is bound to other paths. Operator recovery required; ' +
                    'do not edit evidence or TASK.md registries.',
                commands: []
            };
        }
        const followUpCount = pendingStates.reduce((total, candidate) => (
            total + (candidate.reviewFindingsDisposition?.counts_by_action.create_follow_up || 0)
        ), 0);
        return {
            status: 'BLOCKED',
            nextGate: 'materialize-review-follow-up-tasks',
            title: reviewTypes.length === 1
                ? `Add '${reviewTypes[0]}' deferred items to the grouped follow-up task.`
                : `Add deferred items from ${reviewTypes.length} review lanes to one grouped follow-up task.`,
            reason:
                `All currently required review lanes are complete. Add ${followUpCount} deferred item(s) from ` +
                `${formatReviewTypeList(reviewTypes)} to the snapshot-bound grouped ` +
                'child in one step before publishing the final report.',
            commands: [buildFollowUpMaterializationCommand('Update grouped review follow-up task for all pending lanes', options.cliPrefix, {
                task_id: options.taskId, review_type: null, review_types: reviewTypes, disposition_artifact_path: null,
                receipt_path: null, artifact_path: null, reviews_root: buildReviewsRootValue(options)
            })]
        };
    }
    const disposition = state.reviewFindingsDisposition;
    if (!disposition) {
        throw new Error(`Grouped follow-up state '${state.reviewType}' is missing disposition evidence.`);
    }
    const dispositionArtifactPath = state.reviewFindingsDispositionArtifactPath
        || path.join(options.reviewsRoot, `${options.taskId}-${state.reviewType}-findings-disposition.json`);
    const followUpArtifactPath = state.reviewFindingsFollowUpArtifactPath
        || dispositionArtifactPath.replace(/-findings-disposition\.json$/u, '-findings-follow-ups.json');
    return resolveGroupedReviewFollowUpRoute({
        allRequiredReviewLanesSatisfied,
        reviewType: state.reviewType,
        groupedByParent: state.reviewFollowUpMaterializationMode === 'grouped_by_parent',
        stateReady: state.ready,
        dispositionReady: true,
        followUpCount: disposition.counts_by_action.create_follow_up,
        followUpSatisfied: state.reviewFindingsFollowUpSatisfied,
        updateCommand: buildFollowUpMaterializationCommand('Update grouped review follow-up task', options.cliPrefix, {
            task_id: options.taskId, review_type: state.reviewType, review_types: [],
            disposition_artifact_path: toRepoDisplayPath(options.repoRoot, dispositionArtifactPath),
            receipt_path: toRepoDisplayPath(options.repoRoot, state.receiptPath),
            artifact_path: toRepoDisplayPath(options.repoRoot, followUpArtifactPath), reviews_root: null
        })
    });
}

function resolveCloseoutDecisionRoute(
    options: PostReviewLifecycleStateOptions,
    authorshipDefaults: Record<string, boolean>
): PostReviewRoute {
    const requiredReviews = buildRequiredReviewsCheckInvocation(
        options.repoRoot,
        options.cliPrefix,
        options.taskId,
        options.preflightCommandPath,
        options.taskModePath,
        authorshipDefaults
    );
    const route = resolvePostReviewCloseoutRouteFromState({
        ...options.closeoutState,
        requiredReviewsCommand: requiredReviews.command,
        requiredReviewsOperation: { boundary: requiredReviews.boundary, arguments: requiredReviews.arguments }
    });
    return {
        status: route.status,
        nextGate: route.nextGate,
        title: route.title,
        reason: route.reason,
        commands: route.commands
    };
}

export function resolvePostReviewLifecycleDecisionRouteFromState(
    options: PostReviewLifecycleStateOptions
): PostReviewRoute {
    let authorshipDefaults: Record<string, boolean> | null = null;
    const getAuthorshipDefaults = (): Record<string, boolean> => {
        authorshipDefaults ||= buildReviewAuthorshipAttestationDefaults(options);
        return authorshipDefaults;
    };
    const route = resolvePostReviewLifecycleDecisionRoute({
        resolveDownstreamDependencyRebindRoute: () => resolveDownstreamDependencyRebindDecisionRoute(options),
        resolveStaleUpstreamRecoveryRoute: () => resolveStaleUpstreamRecoveryDecisionRoute(options),
        resolveStaleContextRecoveryRoute: () => resolveStaleContextRecoveryDecisionRoute(options),
        resolveGroupedFollowUpRoute: () => resolveRecordedOutOfScopeFollowUpRoute(options, getAuthorshipDefaults()),
        resolveCloseoutRoute: () => resolveCloseoutDecisionRoute(options, getAuthorshipDefaults())
    });
    if (!route) {
        throw new Error('Post-review lifecycle routing did not produce a closeout decision.');
    }
    return route;
}

export function resolveGroupedReviewFollowUpRoute(options: {
    allRequiredReviewLanesSatisfied: boolean;
    reviewType: string;
    groupedByParent: boolean;
    stateReady: boolean;
    dispositionReady: boolean;
    followUpCount: number;
    followUpSatisfied: boolean;
    updateCommand: PostReviewCommand;
}): PostReviewRoute | null {
    if (
        !options.allRequiredReviewLanesSatisfied
        || !options.groupedByParent
        || !options.stateReady
        || !options.dispositionReady
        || options.followUpCount <= 0
        || options.followUpSatisfied
    ) {
        return null;
    }
    return {
        status: 'BLOCKED',
        nextGate: 'materialize-review-follow-up-tasks',
        title: `Add '${options.reviewType}' deferred items to the grouped follow-up task.`,
        reason:
            `All currently required review lanes are complete. Add ${options.followUpCount} ` +
            `'${options.reviewType}' deferred item(s) to the snapshot-bound grouped child before publishing the final report.`,
        commands: [options.updateCommand]
    };
}
