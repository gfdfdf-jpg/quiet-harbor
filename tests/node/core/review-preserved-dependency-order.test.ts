import test from 'node:test';
import assert from 'node:assert/strict';
import {
    compileReviewDependencyGraph,
    getReviewDependencyTimelineOrderViolations,
    isDownstreamReviewPhaseOrderValid,
    isEvidenceOnlyPreservedReviewOrderValid,
    type ReviewDependencyTimelineEventLike
} from '../../../src/core/review-dependency-graph';

const taskId = 'T-ORDER';
const hash = (digit: string) => digit.repeat(64);
const event = (event_type: string, sequence: number, details: Record<string, unknown> = {}): ReviewDependencyTimelineEventLike => ({
    event_type, sequence, task_id: taskId, actor: event_type === 'REVIEW_CYCLE_RESTARTED' ? 'orchestrator' : 'gate', outcome: 'PASS', details,
    integrity: { task_sequence: sequence, event_sha256: hash(sequence.toString(16)) }
});
const graph = compileReviewDependencyGraph({
    catalogLaneIds: ['code', 'test'], activeLaneIds: ['code', 'test'], requiredReviewIds: ['code', 'test'],
    mode: 'strict_sequential'
});
function preservedEvents(): ReviewDependencyTimelineEventLike[] {
    return [
        event('COMPILE_GATE_PASSED', 1),
        event('REVIEW_RECORDED', 2, { review_type: 'code', review_tree_state_sha256: hash('e'), preflight_sha256: hash('f') }),
        event('REVIEW_PHASE_STARTED', 3, { review_type: 'test' }),
        event('REVIEW_RECORDED', 4, { review_type: 'test', receipt_sha256: hash('a'), review_context_sha256: hash('b'),
            review_tree_state_sha256: hash('e'), preflight_sha256: hash('f') }),
        event('REVIEW_CYCLE_RESTARTED', 5, { task_id: taskId, event_type: 'REVIEW_CYCLE_RESTARTED', status: 'PASSED',
            detection_source: 'review_evidence_only', detected_changed_files_count: 0, preflight_sha256: hash('f'),
            invalidated_review_types: ['code'], preserved_review_types: ['test'] }),
        event('REVIEW_RECORDED', 6, { review_type: 'code', review_tree_state_sha256: hash('e'), preflight_sha256: hash('f'),
            receipt_sha256: hash('d'), review_context_sha256: hash('a') }),
        event('REVIEW_CONTEXT_REUSE_ACCEPTED', 7, { review_type: 'test', current_pass_review_evidence: true,
            review_recorded_event_sha256: hash('4'), receipt_sha256: hash('a'), review_context_sha256: hash('b'),
            preflight_sha256: hash('f') })
    ];
}
const valid = (events: ReviewDependencyTimelineEventLike[], verifiedTimeline = true) =>
    isEvidenceOnlyPreservedReviewOrderValid({ events, downstreamReviewId: 'test', upstreamReviewId: 'code',
        downstreamPhaseSequence: 3, verifiedTimeline });

test('evidence-only preservation retains the original dependency order in the shared graph check', () => {
    const events = preservedEvents();
    assert.equal(valid(events), true);
    assert.deepEqual(getReviewDependencyTimelineOrderViolations(graph, events, { verifiedTimeline: true }), []);
    assert.equal(getReviewDependencyTimelineOrderViolations(graph, events)[0]?.code, 'downstream_started_early');
});

test('implicit policies keep the lane, while a declared dependency invalidates it', () => {
    for (const mode of ['strict_sequential', 'test_after_code', 'code_first_optional', 'parallel_all'] as const) {
        const policyGraph = compileReviewDependencyGraph({ catalogLaneIds: ['code', 'test'],
            activeLaneIds: ['code', 'test'], requiredReviewIds: ['code', 'test'], mode });
        assert.deepEqual(getReviewDependencyTimelineOrderViolations(policyGraph, preservedEvents(), { verifiedTimeline: true }), [], mode);
    }
    const declared = compileReviewDependencyGraph({ catalogLaneIds: ['code', 'test'], activeLaneIds: ['code', 'test'],
        requiredReviewIds: ['code', 'test'], mode: 'parallel_all',
        declaration: { preparation_order: ['code', 'test'], dependencies: { test: ['code'] } } });
    assert.equal(getReviewDependencyTimelineOrderViolations(declared, preservedEvents(), { verifiedTimeline: true })[0]?.code,
        'downstream_started_early');
});

test('preservation requires authenticated history, the original order and the exact retained receipt', () => {
    const cases: Array<[string, (events: ReviewDependencyTimelineEventLike[]) => void]> = [
        ['unauthenticated restart', events => { events[4].actor = 'user'; }],
        ['forged context acceptance', events => { events[6].actor = 'user'; }],
        ['forged review record', events => { events[1].actor = 'user'; }],
        ['downstream invalidated', events => { events[4].details!.invalidated_review_types = ['code', 'test']; }],
        ['missing preserved lane', events => { events[4].details!.preserved_review_types = []; }],
        ['changed workspace', events => { events[4].details!.detected_changed_files_count = 1; }],
        ['wrong receipt', events => { events[6].details!.receipt_sha256 = hash('c'); }],
        ['wrong recorded event', events => { events[6].details!.review_recorded_event_sha256 = hash('c'); }],
        ['changed tree', events => { events[5].details!.review_tree_state_sha256 = hash('c'); }],
        ['changed preflight', events => { events[5].details!.preflight_sha256 = hash('c'); }],
        ['out-of-order original launch', events => { events[1].sequence = 4; }],
        ['failed original upstream', events => { events[1].details!.verdict = 'fail'; }]
    ];
    for (const [label, mutate] of cases) {
        const events = preservedEvents();
        mutate(events);
        assert.equal(valid(events), false, label);
        assert.equal(getReviewDependencyTimelineOrderViolations(graph, events, { verifiedTimeline: true })[0]?.code,
            'downstream_started_early', label);
    }
    assert.equal(valid(preservedEvents(), false), false);
});

test('a later compile starts its own order checks without reusing the old restart as a proof', () => {
    const events = preservedEvents();
    events.push(event('COMPILE_GATE_PASSED', 8));
    assert.equal(valid(events), false);
    assert.deepEqual(getReviewDependencyTimelineOrderViolations(graph, events, { verifiedTimeline: true }), []);
    events.push(event('REVIEW_PHASE_STARTED', 9, { review_type: 'test' }));
    events.push(event('REVIEW_RECORDED', 10, { review_type: 'code' }));
    assert.equal(getReviewDependencyTimelineOrderViolations(graph, events, { verifiedTimeline: true })[0]?.code,
        'downstream_started_early');
});

test('a kept review survives successive authenticated evidence-only recoveries', () => {
    const events = preservedEvents();
    events.push(event('REVIEW_CYCLE_RESTARTED', 8, { task_id: taskId, event_type: 'REVIEW_CYCLE_RESTARTED',
        status: 'PASSED', detection_source: 'review_evidence_only', detected_changed_files_count: 0,
        preflight_sha256: hash('f'), invalidated_review_types: ['security'], preserved_review_types: ['code', 'test'] }));
    events.push(event('REVIEW_CONTEXT_REUSE_ACCEPTED', 9, { review_type: 'test', current_pass_review_evidence: true,
        review_recorded_event_sha256: hash('4'), receipt_sha256: hash('a'), review_context_sha256: hash('b'),
        preflight_sha256: hash('f') }));
    assert.equal(valid(events), true);
    assert.deepEqual(getReviewDependencyTimelineOrderViolations(graph, events, { verifiedTimeline: true }), []);
    for (const [label, mutate] of [
        ['forged intermediate restart', (copy: ReviewDependencyTimelineEventLike[]) => { copy[4].actor = 'user'; }],
        ['changed intermediate tree', (copy: ReviewDependencyTimelineEventLike[]) => { copy[4].details!.detected_changed_files_count = 1; }],
        ['changed intermediate preflight', (copy: ReviewDependencyTimelineEventLike[]) => { copy[4].details!.preflight_sha256 = hash('c'); }],
        ['changed intermediate receipt', (copy: ReviewDependencyTimelineEventLike[]) => { copy[6].details!.receipt_sha256 = hash('c'); }],
        ['lost intermediate acceptance', (copy: ReviewDependencyTimelineEventLike[]) => { copy[6].event_type = 'OTHER'; }],
        ['downstream invalidated later', (copy: ReviewDependencyTimelineEventLike[]) => { copy[7].details!.invalidated_review_types = ['test']; }]
    ] as const) {
        const copy = structuredClone(events);
        mutate(copy);
        assert.equal(valid(copy), false, label);
    }
});

test('a freshly relaunched review uses its authenticated delegation for order after an evidence-only restart', () => {
    const events = preservedEvents();
    events.push(event('REVIEW_CYCLE_RESTARTED', 8, { task_id: taskId, event_type: 'REVIEW_CYCLE_RESTARTED',
        status: 'PASSED', detection_source: 'review_evidence_only', detected_changed_files_count: 0,
        preflight_sha256: hash('f'), invalidated_review_types: ['test'], preserved_review_types: ['code'] }));
    const binding = { review_type: 'test', reviewer_identity: 'agent:new-test', reviewer_launch_attempt_id: 'attempt-new',
        provider_invocation_id: 'provider-new',
        review_context_sha256: hash('b'), review_tree_state_sha256: hash('e') };
    const start = event('REVIEWER_DELEGATION_STARTED', 9, binding); start.actor = 'orchestrator'; start.outcome = 'INFO';
    const completed = event('REVIEWER_LAUNCH_COMPLETED', 10, { ...binding, reviewer_launch_artifact_sha256: hash('a') });
    completed.actor = 'orchestrator'; completed.outcome = 'INFO';
    const invocation = event('REVIEWER_INVOCATION_ATTESTED', 11, { ...binding, reviewer_launch_artifact_sha256: hash('a') });
    invocation.actor = 'orchestrator'; invocation.outcome = 'INFO';
    events.push(start, completed, invocation, event('REVIEW_RECORDED', 12, { ...binding,
        preflight_sha256: hash('f'), receipt_sha256: hash('c'),
        reviewer_provenance: { event_sha256: hash('b'), task_sequence: 11 } }));
    assert.equal(valid(events), true);
    for (const [label, mutate] of [
        ['delegation before upstream', (copy: ReviewDependencyTimelineEventLike[]) => { copy[8].sequence = 5; }],
        ['wrong invocation', (copy: ReviewDependencyTimelineEventLike[]) => { copy[11].details!.reviewer_provenance = { event_sha256: hash('c') }; }],
        ['different tree', (copy: ReviewDependencyTimelineEventLike[]) => { copy[8].details!.review_tree_state_sha256 = hash('c'); }],
        ['upstream invalidated', (copy: ReviewDependencyTimelineEventLike[]) => { copy[7].details!.invalidated_review_types = ['test', 'code']; }],
        ['duplicate delegation', (copy: ReviewDependencyTimelineEventLike[]) => { copy.push({ ...copy[8], sequence: 13 }); }]
    ] as const) {
        const copy = structuredClone(events); mutate(copy);
        assert.equal(valid(copy), false, label);
    }
});

// An evidence-only restart repeats the upstream lane while the downstream lane, prepared earlier, has not finished.
// Both review gates judge its pre-restart phase with the same shared rule.
function restartedUpstreamEvents(): ReviewDependencyTimelineEventLike[] {
    const binding = { review_type: 'test', reviewer_identity: 'agent:test', review_context_sha256: hash('b'), review_tree_state_sha256: hash('e'),
        reviewer_launch_attempt_id: 'attempt-test', provider_invocation_id: 'provider-test' };
    const orchestrator = (entry: ReviewDependencyTimelineEventLike) => { entry.actor = 'orchestrator'; entry.outcome = 'INFO'; return entry; };
    return [
        event('COMPILE_GATE_PASSED', 1),
        event('REVIEW_RECORDED', 2, { review_type: 'code', review_tree_state_sha256: hash('e'), preflight_sha256: hash('f') }),
        event('REVIEW_PHASE_STARTED', 3, { review_type: 'test' }),
        event('REVIEW_CYCLE_RESTARTED', 4, { task_id: taskId, event_type: 'REVIEW_CYCLE_RESTARTED', status: 'PASSED',
            detection_source: 'review_evidence_only', detected_changed_files_count: 0, preflight_sha256: hash('f'),
            invalidated_review_types: ['code'], preserved_review_types: [] }),
        event('REVIEW_RECORDED', 5, { review_type: 'code', review_tree_state_sha256: hash('e'), preflight_sha256: hash('f') }),
        orchestrator(event('REVIEWER_DELEGATION_ROUTED', 6, binding)),
        orchestrator(event('REVIEWER_DELEGATION_STARTED', 7, binding)),
        orchestrator(event('REVIEWER_LAUNCH_COMPLETED', 8, { ...binding, reviewer_launch_artifact_sha256: hash('d') })),
        orchestrator(event('REVIEWER_INVOCATION_ATTESTED', 9, { ...binding, reviewer_launch_artifact_sha256: hash('d') })),
        event('REVIEW_RECORDED', 10, { ...binding, preflight_sha256: hash('f'), receipt_sha256: hash('c'),
            reviewer_provenance: { event_sha256: hash('9'), task_sequence: 9 } })
    ];
}
const sharedValid = (events: ReviewDependencyTimelineEventLike[], verified = true) => isDownstreamReviewPhaseOrderValid({
    events, downstreamReviewId: 'test', upstreamReviewId: 'code', downstreamPhaseSequence: 3, isVerifiedTimeline: () => verified });

test('a downstream review started after the repeated upstream result keeps its pre-restart phase valid in both gates', () => {
    const events = restartedUpstreamEvents();
    assert.equal(sharedValid(events), true);
    assert.deepEqual(getReviewDependencyTimelineOrderViolations(graph, events, { verifiedTimeline: true }), []);
    // The review gate no longer accepts this phase by omission: an unverified timeline is refused like completion does.
    assert.equal(sharedValid(events, false), false);
    assert.equal(getReviewDependencyTimelineOrderViolations(graph, events)[0]?.code, 'downstream_started_early');
    for (const [label, mutate] of [
        ['routed before the repeated upstream', (copy: ReviewDependencyTimelineEventLike[]) => { copy[5].sequence = 4.5; }],
        ['downstream invalidated too', (copy: ReviewDependencyTimelineEventLike[]) => { copy[3].details!.invalidated_review_types = ['code', 'test']; }],
        ['changed workspace', (copy: ReviewDependencyTimelineEventLike[]) => { copy[3].details!.detected_changed_files_count = 1; }],
        ['forged restart', (copy: ReviewDependencyTimelineEventLike[]) => { copy[3].actor = 'user'; }],
        ['different reviewed tree', (copy: ReviewDependencyTimelineEventLike[]) => { copy[4].details!.review_tree_state_sha256 = hash('c'); }],
        ['wrong invocation', (copy: ReviewDependencyTimelineEventLike[]) => { copy[9].details!.reviewer_provenance = { event_sha256: hash('c') }; }],
        ['wrong invocation sequence', (copy: ReviewDependencyTimelineEventLike[]) => { copy[9].details!.reviewer_provenance = { event_sha256: hash('9'), task_sequence: 8 }; }],
        ['wrong attempt', (copy: ReviewDependencyTimelineEventLike[]) => { copy[8].details!.reviewer_launch_attempt_id = 'different'; }],
        ['wrong provider', (copy: ReviewDependencyTimelineEventLike[]) => { copy[8].details!.provider_invocation_id = 'different'; }],
        ['wrong launch artifact', (copy: ReviewDependencyTimelineEventLike[]) => { copy[7].details!.reviewer_launch_artifact_sha256 = hash('c'); }],
        ['no completion', (copy: ReviewDependencyTimelineEventLike[]) => { copy.splice(7, 1); }],
        ['duplicate delegation', (copy: ReviewDependencyTimelineEventLike[]) => { copy.push({ ...copy[6], sequence: 11 }); }],
        ['failed original upstream', (copy: ReviewDependencyTimelineEventLike[]) => { copy[1].details!.verdict = 'fail'; }],
        ['later compile', (copy: ReviewDependencyTimelineEventLike[]) => { copy.push(event('COMPILE_GATE_PASSED', 11)); }]
    ] as const) {
        const copy = structuredClone(restartedUpstreamEvents()); mutate(copy);
        assert.equal(sharedValid(copy), false, label);
    }
});

test('reuse never excuses an early phase using a failed or previous-cycle upstream record', () => {
    for (const previous of [event('REVIEW_RECORDED', 2, { review_type: 'code', verdict: 'fail' }),
        event('REVIEW_RECORDED', 0, { review_type: 'code' })]) {
        const events = [previous, event('COMPILE_GATE_PASSED', 1), event('REVIEW_PHASE_STARTED', 3, { review_type: 'test' }),
            event('REVIEW_RECORDED', 4, { review_type: 'code', reused_existing_review: true })];
        assert.equal(sharedValid(events), false);
        assert.equal(getReviewDependencyTimelineOrderViolations(graph, events, { verifiedTimeline: true })[0]?.code,
            'downstream_started_early');
    }
});

test('without a restart the shared rule keeps refusing a downstream phase that started before its upstream result', () => {
    const events = restartedUpstreamEvents().filter(entry => entry.event_type !== 'REVIEW_CYCLE_RESTARTED');
    assert.equal(sharedValid(events), false);
    assert.equal(getReviewDependencyTimelineOrderViolations(graph, events, { verifiedTimeline: true })[0]?.code, 'downstream_started_early');
});
