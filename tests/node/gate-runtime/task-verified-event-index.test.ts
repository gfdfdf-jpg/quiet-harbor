import { readStartupCycleReadiness } from '../../../src/gates/next-step/next-step-startup-readiness';
import { getHiddenReviewTimingTrustRemediation, readCompleteReviewTimelineEvidence } from '../../../src/gates/next-step/next-step-review-evidence';
import type { ReviewArtifactState } from '../../../src/gates/next-step/next-step-review-artifact-readers';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendTaskEvent, buildEventIntegrityHash, inspectTaskEventFile } from '../../../src/gate-runtime/task-events';
import { readInvocationVerifiedEventIndex } from '../../../src/gate-runtime/timeline/task-events-integrity';
import { selectVerifiedEvents, readVerifiedExecutionEpochPosition, readVerifiedIntermediateStarts,
    readVerifiedReviewWitnesses, verifiedEventPosition, beginVerifiedEventIndexPass,
    readVerifiedOriginalEntryRefresh, readVerifiedRecoverySequence } from '../../../src/gate-runtime/timeline/task-verified-event-index';
import { withInvocationReadObservation } from '../../../src/core/invocation-read-observation';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../src/core/next-step-measurement';
import { readNavigationOrderedTaskEvents, readOrderedTaskEvents } from '../../../src/gates/task-audit/task-audit-summary-lifecycle';
import { collectImmutableTimelineEvents, findLatestTimelineEvent } from '../../../src/gates/next-step/next-step-timeline-readers';
import { readImmutableTaskTimelineEventWindow, readImmutableTaskTimelineEventLikes, readTaskTimelineEventWindow } from '../../../src/gates/next-step/next-step-review-timeline-evidence';
import { isLatestCompletionCurrent, readPendingPreflightRefresh } from '../../../src/gates/next-step/next-step-preflight-recovery';
import { normalizePath } from '../../../src/core/orchestrator-paths';
import { readVerifiedQualityBindingWitness, readVerifiedQualityRepairCandidate,
    type QualityBindingWitness } from '../../../src/gate-runtime/timeline/task-verified-event-index';
import { readImmutableQualityBindingWitness, readImmutableQualityRepairCandidate } from '../../../src/gates/next-step/next-step-review-timeline-evidence';

function fixture(t: TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-verified-index-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const taskId = 'T-VERIFIED-INDEX', eventsRoot = path.join(root, 'runtime/task-events');
    const file = path.join(eventsRoot, taskId + '.jsonl');
    const append = (type: string, details: Record<string, unknown> = {}) => {
        assert.equal(appendTaskEvent(root, taskId, type, 'PASS', 'Index consumer regression', details,
            { passThru: true, lowNoiseRuntimeWrites: true })?.commit_status, 'committed');
    };
    return { root, taskId, eventsRoot, file, append };
}

const bindingType = 'QUALITY_CHECKLIST_ANSWERS_TEMPLATE_BINDING_RECORDED';
const currentBinding: QualityBindingWitness = { answersPath: 'answers/current.json', bindingPath: 'bindings/current.json',
    bindingSha256: 'a'.repeat(64), policySha256: 'b'.repeat(64) };
const bindingDetails = { answers_path: './answers//current.json', binding_path: 'bindings\\current.json',
    binding_sha256: 'A'.repeat(64) + ' ', answers_template_policy_sha256: 'B'.repeat(64) };
function nativeBindingWitness(events: ReturnType<typeof readTaskTimelineEventWindow>['events'], input = currentBinding): boolean {
    return events.some(event => {
        if (String(event.event_type || '') !== bindingType) return false;
        const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
            ? event.details as Record<string, unknown> : {};
        return normalizePath(details.answers_path) === normalizePath(input.answersPath)
            && normalizePath(details.binding_path) === normalizePath(input.bindingPath)
            && String(details.binding_sha256 || '').trim().toLowerCase() === input.bindingSha256
            && String(details.answers_template_policy_sha256 || '').trim().toLowerCase() === input.policySha256;
    });
}

test('quality binding facts preserve native joint-field, type and path/hash coercion semantics', t => {
    const wrongFields = Object.keys(bindingDetails).map(key => ({ ...bindingDetails, [key]: 'wrong' }));
    const cases: Array<{ type: unknown; details: unknown }[]> = [
        [{ type: bindingType, details: { ...bindingDetails, binding_sha256: null } }],
        [{ type: bindingType, details: bindingDetails }],
        [{ type: [bindingType], details: bindingDetails }],
        [{ type: ` ${bindingType} `, details: bindingDetails }],
        [{ type: bindingType.toLowerCase(), details: bindingDetails }],
        [{ type: 'UNRELATED', details: bindingDetails }],
        [{ type: bindingType, details: null }],
        [{ type: bindingType, details: [bindingDetails] }],
        [{ type: bindingType, details: { ...bindingDetails, answers_path: ['answers/current.json'] } }],
        wrongFields.map(details => ({ type: bindingType, details })),
        [{ type: bindingType, details: bindingDetails }, ...wrongFields.map(details => ({ type: bindingType, details }))],
        ...wrongFields.map(details => [{ type: bindingType, details }])
    ];
    let positives = 0, negatives = 0;
    for (const rows of cases) {
        const f = fixture(t); fs.mkdirSync(f.eventsRoot, { recursive: true });
        fs.writeFileSync(f.file, rows.map(row => JSON.stringify({ task_id: f.taskId,
            event_type: row.type, details: row.details })).join('\n') + '\n', { mode: 0o600 });
        f.append('TASK_MODE_ENTERED');
        const native = readTaskTimelineEventWindow(f.eventsRoot, f.taskId).events;
        const expected = nativeBindingWitness(native);
        if (expected) positives++; else negatives++;
        withInvocationReadObservation(() => {
            const index = readInvocationVerifiedEventIndex(f.file, f.taskId)!;
            assert.ok(index);
            assert.equal(readImmutableQualityBindingWitness(f.eventsRoot, f.taskId, currentBinding), expected,
                JSON.stringify(rows));
            for (const bindingSha256 of [null, 'A'.repeat(64), ' ' + 'a'.repeat(64)] as const) {
                const unavailable = { ...currentBinding, bindingSha256 };
                assert.equal(readImmutableQualityBindingWitness(f.eventsRoot, f.taskId, unavailable),
                    nativeBindingWitness(native, unavailable), 'A missing or noncanonical query hash must not gain a witness.');
            }
            assert.equal(readVerifiedQualityBindingWitness({ ...index }, currentBinding,
                { minimumPosition: 0, afterStartByte: -1 }), null, 'Copied index tokens grant no facts.');
        });
    }
    assert.equal(positives, 4, 'The matrix must include genuine accepted witnesses.');
    assert.equal(negatives, 11, 'Every independent field and event type has a rejecting axis.');
});


test('quality binding witness preserves one leading-dot normalization for event and query paths', t => {
    const prefixes = ['', './', '././', './././'];
    let positives = 0, negatives = 0;
    for (const base of ['answers/current.json', 'D:/repo/answers.json', '/repo/answers.json']) {
        for (const recordedPrefix of prefixes) {
            const f = fixture(t);
            f.append(bindingType, { ...bindingDetails, answers_path: recordedPrefix + base });
            const native = readTaskTimelineEventWindow(f.eventsRoot, f.taskId).events;
            withInvocationReadObservation(() => {
                for (const queryPrefix of prefixes) {
                    const input = { ...currentBinding, answersPath: queryPrefix + base };
                    const expected = nativeBindingWitness(native, input);
                    if (expected) positives++; else negatives++;
                    assert.equal(readImmutableQualityBindingWitness(f.eventsRoot, f.taskId, input), expected,
                        JSON.stringify({ base, recordedPrefix, queryPrefix }));
                }
            });
        }
    }
    assert.equal(positives, 18, 'Canonical, single-prefix and identical repeated-prefix paths retain their witnesses.');
    assert.equal(negatives, 30, 'Independent event/query prefixes cannot gain a witness through extra normalization.');
});

test('quality binding facts respect native byte/event eviction and preserve fallback on incompatible coercion', t => {
    for (const boundary of ['bytes', 'events'] as const) {
        const f = fixture(t);
        f.append(bindingType, bindingDetails);
        if (boundary === 'bytes') f.append('UNRELATED', { padding: 'x'.repeat(2 * 1024 * 1024) });
        else {
            // Genuine legacy prefix exercises the same bounded native parser without thousands of writer transactions.
            const rows = Array.from({ length: 4096 }, () => JSON.stringify({ task_id: f.taskId, event_type: 'UNRELATED' }));
            const oldBinding = JSON.stringify({ task_id: f.taskId, event_type: bindingType, details: bindingDetails });
            fs.writeFileSync(f.file, oldBinding + '\n' + rows.join('\n') + '\n');
            f.append('TASK_MODE_ENTERED');
        }
        assert.equal(nativeBindingWitness(readTaskTimelineEventWindow(f.eventsRoot, f.taskId).events), false, boundary);
        withInvocationReadObservation(() => assert.equal(readImmutableQualityBindingWitness(f.eventsRoot, f.taskId, currentBinding), false));
        f.append(bindingType, bindingDetails);
        assert.equal(nativeBindingWitness(readTaskTimelineEventWindow(f.eventsRoot, f.taskId).events), true, boundary);
        withInvocationReadObservation(() => {
            assert.equal(readImmutableQualityBindingWitness(f.eventsRoot, f.taskId, currentBinding), true);
            const index = readInvocationVerifiedEventIndex(f.file, f.taskId)!;
            const position = index.events.length - 1, start = index.startBytes[position];
            assert.equal(readVerifiedQualityBindingWitness(index, currentBinding,
                { minimumPosition: position, afterStartByte: start - 1 }), true);
            assert.equal(readVerifiedQualityBindingWitness(index, currentBinding,
                { minimumPosition: position, afterStartByte: start }), false, 'A clipped first line is excluded.');
            assert.equal(readVerifiedQualityBindingWitness(index, currentBinding,
                { minimumPosition: position + 1, afterStartByte: -1 }), false);
        });
    }
    const f = fixture(t); f.append(bindingType, bindingDetails);
    f.append(bindingType, { answers_path: { toString: null } });
    assert.equal(nativeBindingWitness(readTaskTimelineEventWindow(f.eventsRoot, f.taskId).events), true,
        'The old predicate short-circuits before the incompatible later path.');
    withInvocationReadObservation(() => assert.equal(readImmutableQualityBindingWitness(f.eventsRoot, f.taskId, currentBinding), null,
        'An optional eager coercion failure preserves the exact old short-circuit fallback.'));
});

test('quality binding repair candidates preserve exact suffix grammar, retained order and private identity', t => {
    const prefix = 'answers/current.json.repair.json';
    const suffixes = ['', '.recovery.json', '.recovery.2.json', '.recovery.9.json', '.recovery.10.json', '.recovery.99.json',
        '.recovery.0.json', '.recovery.1.json', '.recovery.01.json', '.recovery.2.json.extra', '.other.json'];
    for (const suffix of suffixes) {
        const f = fixture(t);
        f.append(bindingType, { answers_path: prefix + suffix });
        const events = readTaskTimelineEventWindow(f.eventsRoot, f.taskId).events;
        const expected = [...events].reverse().map(event => normalizePath((event.details as Record<string, unknown>).answers_path))
            .find(candidate => {
                if (!candidate.startsWith(prefix)) return false;
                const tail = candidate.slice(prefix.length);
                return tail === '' || tail === '.recovery.json' || /^\.recovery\.(?:[2-9]|[1-9]\d+)\.json$/u.test(tail);
            }) ?? null;
        withInvocationReadObservation(() => {
            const index = readInvocationVerifiedEventIndex(f.file, f.taskId)!;
            const selected = readImmutableQualityRepairCandidate(f.eventsRoot, f.taskId, prefix);
            assert.deepEqual(selected, { answersPath: expected }, suffix);
            assert.equal(readVerifiedQualityRepairCandidate({ ...index }, prefix,
                { minimumPosition: 0, afterStartByte: -1 }), null);
            if (selected) selected.answersPath = 'caller mutation';
            assert.deepEqual(readImmutableQualityRepairCandidate(f.eventsRoot, f.taskId, prefix), { answersPath: expected });
        });
    }
    const f = fixture(t);
    f.append(bindingType, { answers_path: prefix });
    f.append(bindingType, { answers_path: prefix + '.recovery.2.json' });
    f.append(bindingType, { answers_path: prefix + '.recovery.1.json' });
    withInvocationReadObservation(() => {
        const index = readInvocationVerifiedEventIndex(f.file, f.taskId)!;
        assert.deepEqual(readImmutableQualityRepairCandidate(f.eventsRoot, f.taskId, prefix),
            { answersPath: prefix + '.recovery.2.json' });
        assert.deepEqual(readVerifiedQualityRepairCandidate(index, prefix,
            { minimumPosition: index.events.length, afterStartByte: -1 }), { answersPath: null });
        assert.deepEqual(readVerifiedQualityRepairCandidate(index, prefix,
            { minimumPosition: 0, afterStartByte: index.startBytes.at(-2)! }), { answersPath: null });
    });
});

test('current recovery queries do not revisit closed preflight or completion witnesses', t => {
    for (const cycles of [2, 16]) {
        const f = fixture(t); f.append('TASK_MODE_ENTERED');
        for (let cycle = 0; cycle < cycles; cycle++) {
            f.append('PREFLIGHT_CLASSIFIED'); f.append('IMPLEMENTATION_STARTED');
            f.append('REVIEW_PHASE_STARTED'); f.append('COMPLETION_GATE_PASSED');
        }
        let measured: NextStepMeasurement | undefined;
        withNextStepMeasurement(() => withInvocationReadObservation(() => {
            for (let consumer = 0; consumer < 5; consumer++) {
                assert.equal(isLatestCompletionCurrent(f.eventsRoot, f.taskId), true);
                assert.equal(readPendingPreflightRefresh(f.eventsRoot, f.taskId)?.nextGate, 'restart-coherent-cycle');
            }
        }), value => { measured = value; });
        assert.equal(measured!.work.timeline_verify, 1, 'Canonical integrity verification remains mandatory.');
        for (const key of ['visit:next-step-preflight-recovery:event:1163',
            'visit:next-step-preflight-recovery:event:826'])
            assert.equal(measured!.work[key] || 0, 0, key + ': current consumers must use fused recovery facts.');
    }
});

test('current recovery prefix facts preserve original-entry and pending coherent lineage', () => {
    const boundaries = new Set(['IMPLEMENTATION_STARTED', 'REVIEW_PHASE_STARTED', 'REVIEW_GATE_PASSED',
        'REVIEW_GATE_PASSED_WITH_OVERRIDE', 'COMPLETION_GATE_FAILED', 'COMPLETION_GATE_PASSED']);
    const histories = [
        [], ['IMPLEMENTATION_STARTED'], ['TASK_MODE_ENTERED'],
        ['TASK_MODE_ENTERED', 'IMPLEMENTATION_STARTED'],
        ['IMPLEMENTATION_STARTED', 'TASK_MODE_ENTERED', 'IMPLEMENTATION_STARTED'],
        ...[...boundaries].map(type => ['TASK_MODE_ENTERED', type]),
        ['TASK_MODE_ENTERED', 'REVIEW_PHASE_STARTED', 'TASK_MODE_ENTERED', 'COHERENT_CYCLE_RED_PENDING'],
        ['TASK_MODE_ENTERED', 'REVIEW_PHASE_STARTED', 'COHERENT_CYCLE_RED_PENDING'],
        ['TASK_MODE_ENTERED', 'COHERENT_CYCLE_RED_PENDING', 'IMPLEMENTATION_STARTED'],
        ['TASK_MODE_ENTERED', 'COHERENT_CYCLE_RED_PENDING', 'COHERENT_CYCLE_RESTARTED'],
        ['TASK_MODE_ENTERED', 'COHERENT_CYCLE_RED_PENDING', 'COHERENT_CYCLE_RESTARTED', 'IMPLEMENTATION_STARTED'],
        ['TASK_MODE_ENTERED', 'COHERENT_CYCLE_RESTARTED', 'COHERENT_CYCLE_RED_PENDING'],
        ['COHERENT_CYCLE_RED_PENDING', 'TASK_MODE_ENTERED', 'IMPLEMENTATION_STARTED']
    ];
    const suffixes = [
        ['PREFLIGHT_CLASSIFIED'],
        ['PREFLIGHT_CLASSIFIED', 'UNRELATED'],
        ['PREFLIGHT_CLASSIFIED', 'TASK_MODE_ENTERED', 'UNRELATED'],
        ['PREFLIGHT_CLASSIFIED', 'REVIEW_PHASE_STARTED', 'PREFLIGHT_CLASSIFIED', 'UNRELATED']
    ];
    let ordinaryAccepts = 0, pendingOnlyAccepts = 0;
    // Keep the independent original predicate visible across both prefix axes:
    // successful entry/pending refresh and later review/re-entry rejection.
    for (const history of histories) for (const suffix of suffixes) {
        const pass = beginVerifiedEventIndexPass();
        const types = [...history, ...suffix];
        for (const [sequence, event_type] of types.entries()) pass.accept(Object.freeze({ event_type,
            timestamp_utc: '2026-10-29T00:00:00Z', details: null,
            integrity: Object.freeze({ schema_version: 2, task_sequence: sequence + 1,
                event_sha256: 'a'.repeat(64), prev_event_sha256: null }) }), sequence);
        const index = pass.finish(true)!;
        const expected = (sequence: number, allow: boolean) => {
            const before = index.normalizedEvents.filter(event => event.sequence < sequence);
            const mode = [...before].reverse().find(event => event.event_type === 'TASK_MODE_ENTERED');
            if (!mode) return false;
            const pending = allow && [...before].reverse().find(event => event.event_type === 'COHERENT_CYCLE_RED_PENDING'
                && event.sequence > mode.sequence);
            const completed = pending && before.some(event => event.event_type === 'COHERENT_CYCLE_RESTARTED'
                && event.sequence > pending.sequence);
            const active = !!pending && !completed;
            const earlier = before.filter(event => boundaries.has(event.event_type) && (!active || event.sequence > mode.sequence));
            return (earlier.length > 0 || active) && earlier.every(event => event.event_type === 'IMPLEMENTATION_STARTED'
                && event.sequence > mode.sequence);
        };
        for (const sequence of [types.lastIndexOf('PREFLIGHT_CLASSIFIED'), types.length]) for (const allow of [false, true]) {
            const wanted = expected(sequence, allow);
            if (wanted && !allow) ordinaryAccepts++;
            if (wanted && allow && !expected(sequence, false)) pendingOnlyAccepts++;
            assert.equal(readVerifiedOriginalEntryRefresh(index, sequence, allow), wanted,
                JSON.stringify({ history, sequence, allow }));
        }
        assert.equal(readVerifiedOriginalEntryRefresh(index, types.length + 1), null, 'Unknown prefixes remain conservative.');
        const oldPreflight = types.indexOf('PREFLIGHT_CLASSIFIED');
        if (oldPreflight !== types.lastIndexOf('PREFLIGHT_CLASSIFIED'))
            assert.equal(readVerifiedOriginalEntryRefresh(index, oldPreflight), null, 'An older prefix remains conservative.');
        assert.equal(readVerifiedOriginalEntryRefresh({ ...index }, types.length), null, 'Copies are not native captures.');
        assert.equal(readVerifiedRecoverySequence({ ...index }, 'TASK_MODE_ENTERED'), null);
        assert.equal(readVerifiedRecoverySequence(index, 'UNKNOWN'), null);
        assert.equal(pass.finish(false), null, 'A failed verifier cannot publish optional facts.');
    }
    assert.ok(ordinaryAccepts > 0, 'The matrix must assert successful original-entry refresh.');
    assert.ok(pendingOnlyAccepts > 0, 'The matrix must assert successful pending refresh that ordinary mode rejects.');
    const legacy = beginVerifiedEventIndexPass();
    legacy.accept(Object.freeze({ event_type: 'TASK_MODE_ENTERED', timestamp_utc: '', details: null }), 0);
    const indexedLegacy = legacy.finish(true)!;
    assert.equal(readVerifiedOriginalEntryRefresh(indexedLegacy, 1), null);
    assert.equal(readVerifiedRecoverySequence(indexedLegacy, 'TASK_MODE_ENTERED'), null);
});

test('current evidence queries retain late-completion start witnesses and reject copied index tokens', t => {
    const f = fixture(t); f.append('TASK_MODE_ENTERED');
    f.append('INTERMEDIATE_COMMAND_STARTED', { execution_id: 'old' });
    f.append('REVIEW_GATE_FAILED');
    f.append('INTERMEDIATE_COMMAND_RUN', { execution_id: 'old' });
    f.append('INTERMEDIATE_COMMAND_STARTED', { execution_id: 'current' });
    f.append('INTERMEDIATE_COMMAND_RUN', { execution_id: 'current' });
    withInvocationReadObservation(() => {
        const indexed = readInvocationVerifiedEventIndex(f.file, f.taskId)!;
        assert.equal(readVerifiedExecutionEpochPosition(indexed), 2);
        const current = selectVerifiedEvents(indexed, ['INTERMEDIATE_COMMAND_RUN'], { fromPosition: 2 });
        assert.deepEqual(current.map(verifiedEventPosition), [3, 5]);
        const starts = readVerifiedIntermediateStarts(indexed, 'old')!;
        assert.equal(starts[0], indexed.events[1]);
        assert.ok(Object.isFrozen(starts));
        const copied = { ...indexed };
        assert.equal(readVerifiedExecutionEpochPosition(copied), null);
        assert.equal(readVerifiedIntermediateStarts(copied, 'old'), null);
        assert.equal(readVerifiedReviewWitnesses(copied, 'REVIEW_RECORDED', 'f'.repeat(64)), null);
    });
});

test('current compile discovery does not revisit historical compile records per consumer', t => {
    for (const cycles of [2, 16]) {
        const f = fixture(t); f.append('TASK_MODE_ENTERED');
        for (let cycle = 0; cycle < cycles; cycle++) {
            f.append('COMPILE_GATE_PASSED'); f.append('UNRELATED', { cycle });
        }
        f.append('COMPILE_GATE_PASSED');
        const native = readCompleteReviewTimelineEvidence(f.eventsRoot, f.taskId)!;
        assert.equal(native.latestCompileSequence, 2 * cycles + 2);
        let measured: NextStepMeasurement | undefined;
        withNextStepMeasurement(() => withInvocationReadObservation(() => {
            for (let lane = 0; lane < 5; lane++) {
                const current = readCompleteReviewTimelineEvidence(f.eventsRoot, f.taskId)!;
                assert.deepEqual(current, native);
            }
        }), value => { measured = value; });
        assert.equal(measured!.work.timeline_verify, 1);
        assert.equal(measured!.work.timeline_parse, 1);
        assert.equal(measured!.work['visit:verified_timeline_index_event'], 2 * cycles + 2);
        assert.ok((measured!.work['visit:review_evidence_compile_candidate'] || 0) <= 1,
            'Current consumers must not rescan the verified compile history.');
    }
});

test('retained review windows do not select historical type records outside their byte range', t => {
    const visits: number[] = [];
    for (const cycles of [2, 16]) {
        const f = fixture(t); f.append('TASK_MODE_ENTERED');
        for (let cycle = 0; cycle < cycles; cycle++) f.append('REVIEW_RECORDED', { cycle });
        f.append('UNRELATED', { padding: 'x'.repeat(2 * 1024 * 1024) });
        f.append('REVIEW_RECORDED', { current: true });
        const native = readTaskTimelineEventWindow(f.eventsRoot, f.taskId);
        assert.equal(native.truncated, true);
        assert.equal(native.events.length, 1);
        let measured: NextStepMeasurement | undefined;
        withNextStepMeasurement(() => withInvocationReadObservation(() => {
            const selected = readImmutableTaskTimelineEventLikes(f.eventsRoot, f.taskId, 'REVIEW_RECORDED');
            assert.deepEqual(selected, native.events);
        }), value => { measured = value; });
        assert.equal(measured!.work.timeline_verify, 1);
        // The shared selection view visits only the bounded suffix: the retained event and the boundary candidate.
        visits.push((measured!.work['visit:verified_timeline_selected_event'] || 0)
            + (measured!.work['visit:verified_timeline_range_candidate'] || 0));
    }
    assert.equal(visits[0], visits[1], 'Selection work must not grow with the historical type records.');
    assert.ok(visits[0] <= 2, 'Only the retained current event and its boundary are visited at either history size.');
});

test('complete review history keeps old proof while repeated consumers avoid full-history copies', t => {
    const f = fixture(t);
    f.append('TASK_MODE_ENTERED'); f.append('COMPILE_GATE_PASSED'); f.append('REVIEW_RECORDED');
    // The old proof and compile are outside the ordinary navigation tail.
    f.append('UNRELATED', { padding: 'x'.repeat(2 * 1024 * 1024) });
    f.append('REVIEW_RECORDED');
    const native = readCompleteReviewTimelineEvidence(f.eventsRoot, f.taskId);
    assert.equal(native!.events.length, 5);
    assert.equal(native!.latestCompileSequence, 2);
    assert.equal(readTaskTimelineEventWindow(f.eventsRoot, f.taskId).truncated, true);
    let measured: NextStepMeasurement | undefined;
    withNextStepMeasurement(() => withInvocationReadObservation(() => {
        const indexed = readInvocationVerifiedEventIndex(f.file, f.taskId)!;
        for (let consumer = 0; consumer < 8; consumer++) {
            const actual = readCompleteReviewTimelineEvidence(f.eventsRoot, f.taskId)!;
            assert.deepEqual(actual, native);
            assert.equal(actual.events, indexed.events);
        }
    }), value => { measured = value; });
    assert.equal(measured!.work.timeline_verify, 1);
    assert.equal(measured!.work.timeline_parse, 1);
    assert.equal(measured!.work['visit:next-step-review-evidence:63'] || 0, 0);
    assert.equal(measured!.work['visit:review_evidence_compile_candidate'] || 0, 0);
});

test('complete review history retains strict legacy compile boundaries and raw sequence values', t => {
    const f = fixture(t);
    fs.mkdirSync(f.eventsRoot, { recursive: true });
    fs.writeFileSync(f.file, [
        { task_id: f.taskId, event_type: 'COMPILE_GATE_PASSED', sequence: 90 },
        { task_id: f.taskId, event_type: ['COMPILE_GATE_PASSED'], sequence: 900 },
        { task_id: f.taskId, event_type: ' compile_gate_passed ', sequence: 901 },
        { task_id: f.taskId, event_type: 'COMPILE_GATE_PASSED', sequence: 12 }
    ].map(event => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 });
    f.append('TASK_MODE_ENTERED'); f.append('COMPILE_GATE_PASSED');
    const native = readCompleteReviewTimelineEvidence(f.eventsRoot, f.taskId);
    withInvocationReadObservation(() => {
        assert.ok(readInvocationVerifiedEventIndex(f.file, f.taskId));
        assert.deepEqual(readCompleteReviewTimelineEvidence(f.eventsRoot, f.taskId), native);
        assert.equal(readCompleteReviewTimelineEvidence(f.eventsRoot, f.taskId)!.events[0].sequence, 90);
    });
});

test('complete review history preserves fallback and invalidates changed observations', t => {
    const f = fixture(t); f.append('TASK_MODE_ENTERED');
    withInvocationReadObservation(() => {
        assert.equal(readCompleteReviewTimelineEvidence(f.eventsRoot, f.taskId)!.latestCompileSequence, null);
    });
    assert.throws(() => withInvocationReadObservation(() => {
        readCompleteReviewTimelineEvidence(f.eventsRoot, f.taskId);
        fs.appendFileSync(f.file, ' ');
    }), /changed|unavailable/i);
    f.append('COMPILE_GATE_PASSED');
    withInvocationReadObservation(() => {
        assert.equal(readCompleteReviewTimelineEvidence(f.eventsRoot, f.taskId)!.latestCompileSequence, 2);
    });
    fs.appendFileSync(f.file, '{invalid}\n');
    const native = readCompleteReviewTimelineEvidence(f.eventsRoot, f.taskId);
    assert.equal(native, null);
    withInvocationReadObservation(() => {
        assert.equal(readInvocationVerifiedEventIndex(f.file, f.taskId), null);
        assert.equal(readCompleteReviewTimelineEvidence(f.eventsRoot, f.taskId), native);
    });
});

test('real audit, quality-window and normalized navigation consumers share one frozen verified index', t => {
    const f = fixture(t);
    f.append('TASK_MODE_ENTERED'); f.append('PREFLIGHT_CLASSIFIED');
    f.append('QUALITY_CHECKLIST_ANSWERS_TEMPLATE_BINDING_RECORDED', { nested: { value: 'original' } });
    f.append('REVIEW_CYCLE_RESTARTED'); f.append('COMPILE_GATE_FAILED'); f.append('COMPILE_GATE_PASSED');
    const native = readTaskTimelineEventWindow(f.eventsRoot, f.taskId);
    let measured: NextStepMeasurement | undefined;
    withNextStepMeasurement(() => withInvocationReadObservation(() => {
        const indexed = readInvocationVerifiedEventIndex(f.file, f.taskId)!;
        assert.ok(indexed); assert.ok(Object.isFrozen(indexed)); assert.ok(Object.isFrozen(indexed.events[2].details));
        assert.ok(Object.isFrozen(indexed.normalizedEvents[2])); assert.ok(Object.isFrozen(indexed.normalizedEvents[2].integrity));
        assert.ok(Object.isFrozen(indexed.byType)); assert.ok(Object.isFrozen(indexed.byType.COMPILE_GATE_PASSED));
        assert.deepEqual(indexed.taskModeBoundaries, [0]); assert.deepEqual(indexed.reviewCycleBoundaries, [3]);
        assert.equal(indexed.lastIndexByType.COMPILE_GATE_FAILED, 4);
        for (let consumer = 0; consumer < 5; consumer++) {
            assert.equal(readInvocationVerifiedEventIndex(f.file, f.taskId), indexed);
            assert.equal(readNavigationOrderedTaskEvents(f.file, f.taskId).events, indexed.ordered);
            assert.deepEqual(readImmutableTaskTimelineEventWindow(f.eventsRoot, f.taskId), native);
            assert.equal(readImmutableTaskTimelineEventLikes(f.eventsRoot, f.taskId, 'QUALITY_CHECKLIST_ANSWERS_TEMPLATE_BINDING_RECORDED').length, 1);
            const normalized = collectImmutableTimelineEvents(f.file, []);
            assert.equal(normalized, indexed.normalizedEvents);
            assert.equal(findLatestTimelineEvent(normalized, 'COMPILE_GATE_FAILED')?.sequence, 4);
        }
    }), value => { measured = value; });
    assert.equal(measured!.work.timeline_verify, 1); assert.equal(measured!.work.timeline_parse, 1);
    assert.equal(measured!.work['visit:verified_timeline_index_event'], 6);
    for (const name of ['visit:timeline_cloned_event', 'visit:audit_ordered_event_copy']) assert.equal(measured!.work[name] || 0, 0, name);
    assert.equal(measured!.work['visit:next-step-timeline-readers:event:9'], 5);
});

test('public mutable windows cannot change the indexed event graph or audit array', t => {
    const f = fixture(t); f.append('TEST_EVENT', { nested: { value: 'original' } });
    withInvocationReadObservation(() => {
        const indexed = readInvocationVerifiedEventIndex(f.file, f.taskId)!;
        const mutable = readTaskTimelineEventWindow(f.eventsRoot, f.taskId);
        (mutable.events[0].details as { nested: { value: string } }).nested.value = 'changed';
        mutable.events.length = 0;
        const audit = readOrderedTaskEvents(f.file); audit.events.length = 0;
        assert.equal(indexed.events.length, 1);
        assert.equal((indexed.events[0].details as { nested: { value: string } }).nested.value, 'original');
    });
});

test('legacy prefixes retain native timestamp order and malformed histories never publish an index', t => {
    const f = fixture(t);
    fs.mkdirSync(f.eventsRoot, { recursive: true });
    fs.writeFileSync(f.file, JSON.stringify({ task_id: f.taskId, event_type: 'LEGACY', timestamp_utc: '2099-01-01T00:00:00Z' }) + '\n', { mode: 0o600 });
    f.append('TASK_MODE_ENTERED');
    const native = readOrderedTaskEvents(f.file);
    withInvocationReadObservation(() => {
        assert.equal(inspectTaskEventFile(f.file, f.taskId).status, 'PASS_WITH_LEGACY_PREFIX');
        assert.deepEqual(readNavigationOrderedTaskEvents(f.file, f.taskId), native);
        assert.equal(collectImmutableTimelineEvents(f.file, [])[0].event_type, 'LEGACY');
    });
    fs.appendFileSync(f.file, '{invalid}\n');
    withInvocationReadObservation(() => {
        assert.equal(readInvocationVerifiedEventIndex(f.file, f.taskId), null);
        assert.equal(inspectTaskEventFile(f.file, f.taskId).status, 'FAILED');
        const errors: string[] = []; collectImmutableTimelineEvents(f.file, errors); assert.equal(errors.length, 1);
    });
});

test('indexed bounded-tail selection retains native byte truncation and selected-type filtering', t => {
    const f = fixture(t); f.append('QUALITY_CHECKLIST_ANSWERS_TEMPLATE_BINDING_RECORDED', { payload: 'x'.repeat(2 * 1024 * 1024) });
    f.append('TASK_MODE_ENTERED');
    const native = readTaskTimelineEventWindow(f.eventsRoot, f.taskId);
    assert.equal(native.truncated, true); assert.equal(native.events.length, 1);
    withInvocationReadObservation(() => {
        assert.deepEqual(readImmutableTaskTimelineEventWindow(f.eventsRoot, f.taskId), native);
        assert.deepEqual(readImmutableTaskTimelineEventLikes(f.eventsRoot, f.taskId, 'QUALITY_CHECKLIST_ANSWERS_TEMPLATE_BINDING_RECORDED'), []);
    });
});

test('A1 still rejects mutation after several indexed consumers', t => {
    const f = fixture(t); f.append('TASK_MODE_ENTERED');
    assert.throws(() => withInvocationReadObservation(() => {
        readNavigationOrderedTaskEvents(f.file, f.taskId); collectImmutableTimelineEvents(f.file, []);
        fs.appendFileSync(f.file, ' ');
    }), /changed|unavailable/i);
});

test('verified coercion does not turn legacy array event types into strict validation boundaries', t => {
    const f = fixture(t); fs.mkdirSync(f.eventsRoot, { recursive: true });
    fs.writeFileSync(f.file, JSON.stringify({ task_id: f.taskId, event_type: ['TASK_MODE_ENTERED'],
        timestamp_utc: 'invalid timestamp' }) + '\n', { mode: 0o600 });
    f.append('PREFLIGHT_CLASSIFIED');
    const native = readOrderedTaskEvents(f.file);
    withInvocationReadObservation(() => {
        const indexed = readInvocationVerifiedEventIndex(f.file, f.taskId)!;
        assert.ok(indexed); assert.equal(indexed.lastIndexByType.TASK_MODE_ENTERED, undefined);
        assert.deepEqual(indexed.taskModeBoundaries, []);
        assert.deepEqual(readNavigationOrderedTaskEvents(f.file, f.taskId), native);
        assert.equal(findLatestTimelineEvent(collectImmutableTimelineEvents(f.file, []), 'TASK_MODE_ENTERED')?.sequence, 0);
    });
});

test('indexed windows ignore blank and whitespace rows exactly as the native bounded parser does', t => {
    const f = fixture(t); f.append('TASK_MODE_ENTERED'); f.append('QUALITY_CHECKLIST_RECORDED');
    const lines = fs.readFileSync(f.file, 'utf8').trimEnd().split('\n');
    fs.writeFileSync(f.file, '\r\n  \n' + lines.join('\n\n \r\n') + '\n \r\n   ');
    const native = readTaskTimelineEventWindow(f.eventsRoot, f.taskId);
    withInvocationReadObservation(() => {
        assert.ok(readInvocationVerifiedEventIndex(f.file, f.taskId));
        assert.deepEqual(readImmutableTaskTimelineEventWindow(f.eventsRoot, f.taskId), native);
    });
});

test('optional index wrappers do not tighten the canonical event depth budget', t => {
    const f = fixture(t); f.append('TASK_MODE_ENTERED');
    const original = JSON.parse(fs.readFileSync(f.file, 'utf8')) as Record<string, unknown>;
    for (const depth of [252, 253]) {
        let details: Record<string, unknown> = {};
        for (let level = 0; level < depth; level++) details = { nested: details };
        const event = { ...original, details, integrity: { ...original.integrity as Record<string, unknown> } };
        event.integrity.event_sha256 = buildEventIntegrityHash(event);
        fs.writeFileSync(f.file, JSON.stringify(event) + '\n');
        const native = inspectTaskEventFile(f.file, f.taskId);
        assert.equal(native.status, depth === 252 ? 'PASS' : 'FAILED');
        withInvocationReadObservation(() => {
            assert.equal(inspectTaskEventFile(f.file, f.taskId).status, native.status);
            const indexed = readInvocationVerifiedEventIndex(f.file, f.taskId);
            if (depth === 252) {
                assert.ok(indexed);
                assert.equal(readNavigationOrderedTaskEvents(f.file, f.taskId).events, indexed.ordered);
            } else assert.equal(indexed, null);
        });
    }
});


test('normalized bounded selectors preserve native coercion and original event identity', t => {
    const f = fixture(t); fs.mkdirSync(f.eventsRoot, { recursive: true });
    fs.writeFileSync(f.file, [
        { task_id: f.taskId, event_type: ' reviewer_invocation_attested ', details: { id: 1 } },
        { task_id: f.taskId, event_type: ['reviewer_invocation_attested'], details: { id: 2 } },
        { task_id: f.taskId, event_type: 'UNRELATED', details: { id: 3 } }
    ].map(event => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 });
    f.append('TASK_MODE_ENTERED');
    const native = readTaskTimelineEventWindow(f.eventsRoot, f.taskId).events
        .filter(event => String(event.event_type || '').trim().toUpperCase() === 'REVIEWER_INVOCATION_ATTESTED');
    withInvocationReadObservation(() => {
        const index = readInvocationVerifiedEventIndex(f.file, f.taskId)!;
        const selected = readImmutableTaskTimelineEventLikes(f.eventsRoot, f.taskId, 'REVIEWER_INVOCATION_ATTESTED', 'normalized');
        assert.deepEqual(selected, native);
        assert.equal(selected[0], index.events[0]); assert.equal(selected[1], index.events[1]);
        assert.equal(readImmutableTaskTimelineEventLikes(f.eventsRoot, f.taskId, 'REVIEWER_INVOCATION_ATTESTED').length, 0);
        assert.ok(Object.isFrozen(selected[0].details));
    });
});


test('timing consumers share verified events without cloning a full timeline per lane', t => {
    const f = fixture(t); f.append('TASK_MODE_ENTERED'); f.append('COMPILE_GATE_PASSED'); f.append('UNRELATED');
    let measured: NextStepMeasurement | undefined;
    const state = { reviewType: 'code', reusedExistingReview: false, reviewerProvenance: null } as ReviewArtifactState;
    withNextStepMeasurement(() => withInvocationReadObservation(() => {
        for (let lane = 0; lane < 5; lane++) assert.equal(getHiddenReviewTimingTrustRemediation(f.eventsRoot, f.taskId, state), null);
    }), value => { measured = value; });
    assert.equal(measured!.work.timeline_verify, 1);
    assert.equal(measured!.work['visit:verified_timeline_index_event'], 3);
    assert.equal(measured!.work['visit:timeline_cloned_event'] || 0, 0);
});


test('real startup readiness queries event types without revisiting unrelated history', t => {
    const samples: { output: ReturnType<typeof readStartupCycleReadiness>; visits: number }[] = [];
    for (const cycles of [2, 16]) {
        const f = fixture(t);
        f.append('TASK_MODE_ENTERED');
        f.append('RULE_PACK_LOADED', { stage: 'TASK_ENTRY' });
        f.append('TASK_MODE_ENTERED');
        f.append('RULE_PACK_LOADED', { stage: 'POST_PREFLIGHT' });
        for (let cycle = 0; cycle < cycles; cycle++) f.append('TEST_EVENT', { cycle });
        const taskModePath = path.join(f.root, 'missing-task-mode.json');
        const native = readStartupCycleReadiness(f.root, f.eventsRoot, f.taskId, taskModePath);
        assert.equal(native.nextGate, 'load-rule-pack');
        let measured: NextStepMeasurement | undefined;
        const output = withNextStepMeasurement(() => withInvocationReadObservation(() =>
            readStartupCycleReadiness(f.root, f.eventsRoot, f.taskId, taskModePath)
        ), value => { measured = value; });
        assert.deepEqual(output, native);
        assert.equal(measured!.work.timeline_verify, 1);
        assert.equal(measured!.work['visit:verified_timeline_index_event'], cycles + 4);
        samples.push({ output, visits: measured!.work['visit:next-step-timeline-readers:event:9'] || 0 });
    }
    assert.deepEqual(samples[0].output, samples[1].output);
    assert.equal(samples[0].visits, samples[1].visits);
});


test('ordered and normalized consumers reuse canonical type views and memoize merged selections', t => {
    const f = fixture(t); f.append('TASK_MODE_ENTERED'); f.append('PREFLIGHT_CLASSIFIED');
    let measured: NextStepMeasurement | undefined;
    withNextStepMeasurement(() => withInvocationReadObservation(() => {
        const index = readInvocationVerifiedEventIndex(f.file, f.taskId)!;
        assert.equal(selectVerifiedEvents(index, ['TASK_MODE_ENTERED', 'ABSENT'], { ordered: true }), index.byType.TASK_MODE_ENTERED);
        assert.deepEqual(selectVerifiedEvents(index, ['TASK_MODE_ENTERED'], { normalized: true, ordered: true }), index.byType.TASK_MODE_ENTERED);
        const merged = selectVerifiedEvents(index, ['PREFLIGHT_CLASSIFIED', 'TASK_MODE_ENTERED'], { ordered: true });
        assert.deepEqual(merged.map(event => event.event_type), ['TASK_MODE_ENTERED', 'PREFLIGHT_CLASSIFIED']);
        assert.ok(Object.isFrozen(merged));
        assert.equal(selectVerifiedEvents(index, ['TASK_MODE_ENTERED', 'PREFLIGHT_CLASSIFIED', 'TASK_MODE_ENTERED'], { ordered: true }), merged);
    }), value => { measured = value; });
    assert.equal(measured!.work.timeline_verify, 1);
    assert.equal(measured!.work['visit:verified_timeline_selected_event'], 2, 'Only the first merged view visits its selected events.');
});


test('native composed execution views are filled during the single verified pass', t => {
    const f = fixture(t); f.append('INTERMEDIATE_COMMAND_STARTED'); f.append('INTERMEDIATE_COMMAND_RUN');
    let measured: NextStepMeasurement | undefined;
    withNextStepMeasurement(() => withInvocationReadObservation(() => {
        const index = readInvocationVerifiedEventIndex(f.file, f.taskId)!;
        const attempts = selectVerifiedEvents(index, ['INTERMEDIATE_COMMAND_RUN', 'INTERMEDIATE_COMMAND_STARTED'], { ordered: true });
        const cases = selectVerifiedEvents(index, ['INTERMEDIATE_COMMAND_RUN', 'INTERMEDIATE_COMMAND_STARTED', 'TEST_FIRST_EXPECTED_FAILURE_RECORDED', 'REVIEW_RECORDED']);
        assert.deepEqual(attempts, index.events); assert.deepEqual(cases, index.events);
        assert.ok(Object.isFrozen(attempts)); assert.ok(Object.isFrozen(cases));
    }), value => { measured = value; });
    assert.equal(measured!.work.timeline_verify, 1); assert.equal(measured!.work.timeline_parse, 1);
    assert.equal(measured!.work['visit:verified_timeline_selected_event'] ?? 0, 0);
});
