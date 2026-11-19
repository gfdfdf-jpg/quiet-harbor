import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReviewReceiptReviewerInvocationProvenance } from '../../../../src/gate-runtime/review-context';
import { readRemediationLaneEventTiming } from '../../../../src/gates/review-remediation/review-remediation-scope-review-types';

test('DELTA history requires the exact earlier invocation and cannot invent timing trust from missing provenance', () => {
    const integrity = { schema_version: 1, task_sequence: 4, prev_event_sha256: 'a'.repeat(64), event_sha256: 'b'.repeat(64) };
    const invocation = { task_id: 'T-HISTORY', review_type: 'test', reviewer_execution_mode: 'delegated_subagent',
        reviewer_identity: 'agent:history', reviewer_session_id: 'agent:history',
        review_context_sha256: 'c'.repeat(64), review_tree_state_sha256: 'd'.repeat(64),
        routing_event_sha256: 'e'.repeat(64), reviewer_launch_artifact_path: 'runtime/history-launch.json',
        reviewer_launch_artifact_sha256: 'f'.repeat(64), provider_invocation_id: 'history-provider',
        reviewer_launch_tool: 'test-subagent-spawn', reviewer_launch_attestation_source: 'test-subagent-spawn',
        launch_prepared_at_utc: '2026-04-28T00:00:00.000Z', delegation_started_at_utc: '2026-04-28T00:00:01.000Z',
        launched_at_utc: '2026-04-28T00:00:01.000Z', launch_completed_at_utc: '2026-04-28T00:00:12.000Z',
        invocation_attested_at_utc: '2026-04-28T00:00:13.000Z' };
    const provenance = buildReviewReceiptReviewerInvocationProvenance('REVIEWER_INVOCATION_ATTESTED', integrity, invocation);
    const options = { repoRoot: '.', taskId: 'T-HISTORY', reviewType: 'test', trustedReceipts: new Set<string>(),
        timingEvents: [{ event_type: 'REVIEWER_INVOCATION_ATTESTED', integrity, details: invocation }],
        details: { ...invocation, receipt_sha256: '1'.repeat(64), review_execution_mode: 'FULL',
            reviewer_provenance: provenance, review_result_recorded_at_utc: '2026-04-28T00:00:14.000Z' } };
    assert.equal(readRemediationLaneEventTiming(options).authenticated, true);
    assert.equal(readRemediationLaneEventTiming({ ...options, timingEvents: [] }).authenticated, false,
        'an invocation beyond the decision prefix must not authorize an earlier DELTA');
    assert.equal(readRemediationLaneEventTiming({ ...options, timingEvents: [{ ...options.timingEvents[0],
        event_type: 'REVIEWER_DELEGATION_ROUTED' }] }).authenticated, false);
    assert.equal(readRemediationLaneEventTiming({ ...options, details: { ...options.details, reviewer_provenance: null } }).authenticated, false);
    assert.equal(readRemediationLaneEventTiming({ ...options, details: { ...options.details,
        reviewer_provenance: { ...provenance, task_sequence: 5 } } }).authenticated, false);
    assert.equal(readRemediationLaneEventTiming({ ...options, details: { ...options.details,
        review_tree_state_sha256: '2'.repeat(64) } }).authenticated, false);
    assert.equal(readRemediationLaneEventTiming({ ...options, timingEvents: [{ ...options.timingEvents[0],
        details: { ...invocation, reviewer_launch_artifact_sha256: '3'.repeat(64) } }] }).authenticated, false);
    const reused = { ...options, details: { ...options.details, reused_existing_review: true,
        reused_from_receipt_sha256: '1'.repeat(64), reused_from_review_tree_state_sha256: invocation.review_tree_state_sha256 } };
    assert.equal(readRemediationLaneEventTiming(reused).authenticated, false);
    assert.equal(readRemediationLaneEventTiming({ ...reused, trustedReceipts: new Set(['test:' + '1'.repeat(64)]) }).authenticated, true);
});
