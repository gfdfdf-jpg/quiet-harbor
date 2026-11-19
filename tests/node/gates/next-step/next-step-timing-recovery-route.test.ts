import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDelegatedReviewReadinessRoute, type DelegatedReviewReadinessRouteOptions } from '../../../../src/gates/next-step/next-step-review-readiness-routing';

test('timing-untrusted receipt starts fresh evidence recovery once and then permits a new launch', () => {
    const command = (name: string) => ({ label: name, command: name });
    const options: DelegatedReviewReadinessRouteOptions = {
        reviewType: 'test', currentReviewReuseRecorded: false, currentReviewEvidenceSatisfied: false,
        currentReviewContextInvocationAttested: true, routingCurrent: true,
        artifactExists: true, receiptExists: true, reviewFailed: false, stateReady: true, recordedAttemptIsCurrent: true,
        stateViolationsText: '', reviewerIdentity: 'agent:reviewer', contextReviewerIdentity: 'agent:reviewer',
        reviewerIdentityIsPlanned: false, launchArtifactState: 'launched', providerLaunchTargetSummary: '',
        reviewerReadinessChain: '', reviewRoutingChain: '', launchPreparationChain: '', launchCompletionChain: '',
        reviewInvocationChain: '', reviewResultChain: '', acceptedVerdictTokens: '',
        hiddenTimingTrustRemediation: 'Review evidence is not sufficiently trustworthy.', reusedExistingReview: false,
        oneShotLaunchHint: null,
        instructions: { opaqueHandoff: '', freshContextLaunch: '', sessionReuseBoundary: '', realSubagentOrStop: '', cleanupAfterReceipt: '' },
        commands: {
            recordRouting: command('record-review-routing'), prepareLaunch: command('prepare-reviewer-launch'),
            recordDelegationStartedChoices: [], recordDelegationStarted: command('record-reviewer-delegation-started'),
            completeLaunch: command('complete-reviewer-launch'), recoverOrphanedLaunch: command('orphan-recovery'),
            recoverFailedLaunch: command('restart-review-cycle --review-type test --review-evidence-only'),
            recordInvocation: command('record-review-invocation'), recordResult: command('record-review-result')
        }
    };
    const restart = resolveDelegatedReviewReadinessRoute(options);
    assert.equal(restart?.nextGate, 'restart-review-cycle');
    assert.match(restart?.commands[0]?.command || '', /--review-evidence-only/u);
    const afterRestart = { ...options, currentReviewContextInvocationAttested: false,
        routingCurrent: false, launchArtifactState: 'missing_or_invalid' as const };
    assert.equal(resolveDelegatedReviewReadinessRoute(afterRestart)?.nextGate, 'record-review-routing');
    assert.equal(resolveDelegatedReviewReadinessRoute({ ...afterRestart, routingCurrent: true })?.nextGate, 'prepare-reviewer-launch');
    assert.equal(resolveDelegatedReviewReadinessRoute({ ...options, recordedAttemptIsCurrent: false })?.nextGate, 'record-review-result',
        'a fresh invocation must record its result before the old receipt can cause another restart');
});
