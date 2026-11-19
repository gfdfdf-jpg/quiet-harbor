import {
    DELEGATED_REVIEWER_IDENTITY_FROM_PROVIDER_PLACEHOLDER,
    isPlannedReviewerIdentity,
    isResolvedReviewerIdentity
} from '../../gate-runtime/review/reviewer-identity-contract';
import { normalizePath } from '../shared/helpers';
import type {
    NextStepDecisionRoutePayload
} from './next-step-decision-route-groups';
import {
    resolveDelegatedReviewDecisionRoute
} from './next-step-decision-route-groups';
import type {
    DelegatedReviewLaunchArtifactState
} from './next-step-review-readiness-routing';

type ReviewLifecycleRoute = NextStepDecisionRoutePayload;
type ReviewLifecycleRouteResolver = () => ReviewLifecycleRoute | null;
type ReviewLifecycleCommand = ReviewLifecycleRoute['commands'][number];

export function resolveFindingsFollowUpLifecycleRoute(options: {
    reviewType: string;
    findingsDispositionReady: boolean;
    followUpCount: number;
    followUpSatisfied: boolean;
    groupedByParent: boolean;
    validationArtifactDisplayPath: string | null;
    materializeFollowUpsCommand: ReviewLifecycleCommand;
}): ReviewLifecycleRoute | null {
    if (
        !options.findingsDispositionReady
        || options.followUpCount <= 0
        || options.followUpSatisfied
        || options.groupedByParent
    ) {
        return null;
    }
    return {
        status: 'BLOCKED',
        nextGate: 'materialize-review-follow-up-tasks',
        title: `Materialize '${options.reviewType}' review follow-up tasks.`,
        reason:
            `Accepted '${options.reviewType}' findings disposition requires ` +
            `${options.followUpCount} follow-up item(s). ` +
            'Materialize TASK.md follow-up rows before downstream review, reuse, required-review, or completion decisions treat this review as satisfied. ' +
            `Validation artifact: ${options.validationArtifactDisplayPath || 'unknown'}.`,
        commands: [options.materializeFollowUpsCommand]
    };
}

export interface ActiveReviewLifecycleRouteResolvers {
    resolveFindingsFollowUpRoute: ReviewLifecycleRouteResolver;
    resolveCurrentCycleReuseRoute: ReviewLifecycleRouteResolver;
    resolveDependencyPreparationRoute: ReviewLifecycleRouteResolver;
    resolveStrictSequentialUpstreamReuseRoute: ReviewLifecycleRouteResolver;
    resolveFailedReviewRemediationRoute: ReviewLifecycleRouteResolver;
    resolveContextPreparationRoute: ReviewLifecycleRouteResolver;
    resolveDelegatedReadinessRoute: ReviewLifecycleRouteResolver;
}

export function resolveActiveReviewLifecycleDecisionRoute(
    resolvers: ActiveReviewLifecycleRouteResolvers
): ReviewLifecycleRoute | null {
    const orderedResolvers: readonly ReviewLifecycleRouteResolver[] = [
        resolvers.resolveFindingsFollowUpRoute,
        resolvers.resolveCurrentCycleReuseRoute,
        resolvers.resolveDependencyPreparationRoute,
        resolvers.resolveStrictSequentialUpstreamReuseRoute,
        resolvers.resolveFailedReviewRemediationRoute,
        resolvers.resolveContextPreparationRoute,
        resolvers.resolveDelegatedReadinessRoute
    ];
    for (const resolveRoute of orderedResolvers) {
        const route = resolveRoute();
        if (route) {
            return route;
        }
    }
    return null;
}

export function resolveCurrentCycleReviewReuseRoute(options: {
    reviewType: string;
    stateReady: boolean;
    contextExists: boolean;
    domainScopeCurrent: boolean;
    reviewFailed: boolean;
    currentReviewEvidenceSatisfied: boolean;
    postReviewGateFreshnessRecoveryActive: boolean;
    postReviewGateFreshnessRecoveryReason: string;
    scopedDiffReadiness: {
        ready: boolean;
        reason: string;
    };
    reviewerReadinessChain: string;
    reviewContextChain: string;
    commands: {
        buildScopedDiff: ReviewLifecycleRoute['commands'][number];
        buildReviewContext: ReviewLifecycleRoute['commands'][number];
    };
}): ReviewLifecycleRoute | null {
    if (
        !options.stateReady
        || !options.contextExists
        || !options.domainScopeCurrent
        || options.reviewFailed
        || options.currentReviewEvidenceSatisfied
    ) {
        return null;
    }

    const reuseRecoveryTrigger = options.postReviewGateFreshnessRecoveryActive
        ? `Review gate already passed, but ${options.postReviewGateFreshnessRecoveryReason}`
        : `Current '${options.reviewType}' PASS evidence is lane-domain current but not bound as current-cycle review evidence after the latest compile`;
    if (!options.scopedDiffReadiness.ready) {
        return {
            status: 'BLOCKED',
            nextGate: 'build-scoped-diff',
            title: options.postReviewGateFreshnessRecoveryActive
                ? `Prepare '${options.reviewType}' scoped diff metadata for post-review reuse.`
                : `Prepare '${options.reviewType}' scoped diff metadata for review reuse.`,
            reason:
                `${options.scopedDiffReadiness.reason} ${reuseRecoveryTrigger}; ` +
                'Prepare scoped metadata so build-review-context can materialize reuse instead of launching a fresh reviewer. ' +
                `${options.reviewerReadinessChain} ${options.reviewContextChain}`,
            commands: [options.commands.buildScopedDiff]
        };
    }

    return {
        status: 'BLOCKED',
        nextGate: 'build-review-context',
        title: options.postReviewGateFreshnessRecoveryActive
            ? `Materialize '${options.reviewType}' review reuse before closeout.`
            : `Materialize '${options.reviewType}' review reuse before continuing.`,
        reason:
            `${reuseRecoveryTrigger}. Rebuild the review context to materialize reuse before rerunning ` +
            'required-reviews-check or continuing dependent review work, without launching a fresh reviewer. ' +
            `${options.reviewerReadinessChain} ${options.reviewContextChain}`,
        commands: [options.commands.buildReviewContext]
    };
}

export interface DelegatedReviewerIdentityBinding {
    delegatedReviewerIdentity: string;
    reviewerIdentity: string;
    reviewerIdentityIsPlanned: boolean;
}

export function resolveDelegatedReviewerIdentityBinding(options: {
    contextReviewerIdentity: string;
    launchArtifactState: DelegatedReviewLaunchArtifactState;
    launchReviewerIdentity: string | null;
}): DelegatedReviewerIdentityBinding {
    const resolvedLaunchReviewerIdentity = String(options.launchReviewerIdentity || '').trim();
    const delegatedReviewerIdentity = options.launchArtifactState !== 'prepared'
        && isResolvedReviewerIdentity(resolvedLaunchReviewerIdentity)
        ? resolvedLaunchReviewerIdentity
        : DELEGATED_REVIEWER_IDENTITY_FROM_PROVIDER_PLACEHOLDER;
    return {
        delegatedReviewerIdentity,
        reviewerIdentity: isResolvedReviewerIdentity(options.contextReviewerIdentity)
            ? options.contextReviewerIdentity
            : delegatedReviewerIdentity,
        reviewerIdentityIsPlanned: isPlannedReviewerIdentity(options.contextReviewerIdentity)
    };
}

export function buildReviewerOneShotLaunchHint(options: {
    launchArtifactState: DelegatedReviewLaunchArtifactState;
    launchInputArtifactPath: string | null;
    launchInputArtifactSha256: string | null;
}): string | null {
    if (
        options.launchArtifactState !== 'prepared'
        || !options.launchInputArtifactPath
        || !options.launchInputArtifactSha256
    ) {
        return null;
    }
    return (
        'ReviewerOneShotLaunchHint: launch a fresh delegated reviewer once with the exact opaque handoff ' +
        `ReviewerLaunchInputArtifactPath: ${normalizePath(options.launchInputArtifactPath)} ` +
        `(launch_input_sha256=${options.launchInputArtifactSha256}) ` +
        'or CopyPasteReviewerLaunchPrompt from prepare-reviewer-launch. ' +
        'ReviewerLaunchArtifactPath is main-agent control metadata, not the clean-context reviewer prompt. ' +
        'Then run record-reviewer-delegation-started immediately after provider launch.'
    );
}

export function resolveContextPreparationLifecycleRoute(options: {
    contextReady: boolean;
    reviewType: string;
    reviewerReadinessChain: string;
    reviewContextChain: string;
    preparationRoute: ReviewLifecycleRoute | null;
    buildReviewContextCommand: ReviewLifecycleCommand;
}): ReviewLifecycleRoute | null {
    if (options.contextReady) {
        return null;
    }
    if (options.preparationRoute) {
        return options.preparationRoute;
    }
    return {
        status: 'BLOCKED',
        nextGate: 'build-review-context',
        title: `Prepare '${options.reviewType}' review context.`,
        reason:
            `Required review '${options.reviewType}' review-context state is inconsistent for the current preflight. ` +
            `${options.reviewerReadinessChain} ${options.reviewContextChain}`,
        commands: [options.buildReviewContextCommand]
    };
}

/**
 * The launch gate this route would name refused the current reviewer handoff inputs and would refuse again.
 * No reviewer has started for the lane, so rebuilding its context loses no review; the changed files are
 * regenerated, never reused.
 */
export function resolveReviewerHandoffInputRebuildLifecycleRoute(options: {
    reviewType: string;
    refusedGate: string;
    refusal: string;
    reviewerReadinessChain: string;
    buildReviewContextCommand: ReviewLifecycleCommand;
}): ReviewLifecycleRoute {
    return {
        status: 'BLOCKED',
        nextGate: 'build-review-context',
        title: `Rebuild '${options.reviewType}' review context: its reviewer handoff inputs changed.`,
        reason:
            `${options.refusedGate} refused the current '${options.reviewType}' reviewer handoff inputs and would refuse again: ` +
            `${options.refusal} No reviewer has started for this lane, so rebuilding the review context loses no review. ` +
            'Do not restore or reuse the changed prompt or template files; build-review-context regenerates them, ' +
            `then next-step prepares a fresh reviewer launch. ${options.reviewerReadinessChain}`,
        commands: [options.buildReviewContextCommand]
    };
}

/**
 * A launch gate refused the reviewer handoff inputs of an attempt that already exists for the current context.
 * The attempt can never complete: its prompt or template changed after it was prepared, so what the reviewer
 * received cannot be authenticated (a copy restores only inputs a recorded result proved intact after the run, see
 * restoreProvenReviewerHandoffInputs). It is closed through the failed-launch recovery, the review-evidence-only
 * restart, which supersedes the attempt and repeats only this review with a fresh reviewer and regenerated inputs.
 */
export function resolveReviewerHandoffInputAttemptRecoveryLifecycleRoute(options: {
    reviewType: string;
    refusedGate: string;
    refusal: string;
    reviewerReadinessChain: string;
    recoverFailedLaunchCommand: ReviewLifecycleCommand;
}): ReviewLifecycleRoute {
    return {
        status: 'BLOCKED',
        nextGate: 'restart-review-cycle',
        title: `Recover the '${options.reviewType}' reviewer launch: its reviewer handoff inputs changed.`,
        reason:
            `${options.refusedGate} refused the reviewer handoff inputs of the current '${options.reviewType}' launch attempt `
            + `and would refuse again: ${options.refusal} The attempt cannot be completed because what its reviewer `
            + 'received can no longer be authenticated: the reviewer read these inputs from disk while it ran, and no '
            + 'recorded result proved them intact after its run, so Garda does not restore them from a copy. '
            + 'Treat it as a failed delegated reviewer launch: do not complete it, '
            + 'do not restore or reuse the changed prompt or template files, and do not fabricate review output. '
            + 'Restart the review evidence of this lane so a fresh reviewer gets regenerated inputs. '
            + options.reviewerReadinessChain,
        commands: [options.recoverFailedLaunchCommand]
    };
}

type DelegatedReviewDecisionOptions = Parameters<typeof resolveDelegatedReviewDecisionRoute>[0];

export function resolveDelegatedReadinessLifecycleRoute(options: {
    contextReady: boolean;
    contextReviewerIdentity: string;
    recordedReviewerIdentity: string;
    launchArtifactState: DelegatedReviewLaunchArtifactState;
    identityBinding: DelegatedReviewerIdentityBinding;
    launchInputArtifactPath: string | null;
    launchInputArtifactSha256: string | null;
    decision: Omit<
        DelegatedReviewDecisionOptions,
        | 'reviewerIdentity'
        | 'contextReviewerIdentity'
        | 'reviewerIdentityIsPlanned'
        | 'oneShotLaunchHint'
        | 'launchArtifactState'
    >;
}): ReviewLifecycleRoute | null {
    if (!options.contextReady) {
        return null;
    }
    return resolveDelegatedReviewDecisionRoute({
        ...options.decision,
        reviewerIdentity: options.recordedReviewerIdentity,
        contextReviewerIdentity: options.contextReviewerIdentity,
        reviewerIdentityIsPlanned: options.identityBinding.reviewerIdentityIsPlanned,
        launchArtifactState: options.launchArtifactState,
        oneShotLaunchHint: buildReviewerOneShotLaunchHint({
            launchArtifactState: options.launchArtifactState,
            launchInputArtifactPath: options.launchInputArtifactPath,
            launchInputArtifactSha256: options.launchInputArtifactSha256
        })
    });
}
