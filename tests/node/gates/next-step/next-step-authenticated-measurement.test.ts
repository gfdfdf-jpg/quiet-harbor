import '../../../../src/bin/garda/derivation-source-receipts';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectAuthenticatedHistorySamples, type HistorySample } from './next-step-authenticated-samples-fixture';
import { assertStableAuthenticatedArtifactWork, comparableHistoryCounters, measureHistoryRoute } from './next-step-authenticated-budget-fixture';
import { createAuthenticatedNextStepHistoryFixture } from './next-step-authenticated-history-fixture';
import { buildTaskAuditSummary } from '../../../../src/gates/task-audit/task-audit-summary';
import { readReviewCycleGuardEvaluation } from '../../../../src/gates/next-step/next-step-review-cycle-guard-evaluation';
import { verifiedIndexForEvents } from '../../../../src/gate-runtime/timeline/task-verified-event-index';

interface CounterDifference { mode: HistorySample['mode']; route: string; counter: string; short: number; long: number; }
function differences(short: HistorySample, long: HistorySample): CounterDifference[] {
    assert.equal(short.mode, long.mode);
    return short.routes.flatMap((route, index) => {
        assert.equal(long.routes[index].route, route.route);
        assert.equal(long.routes[index].nextGate, route.nextGate);
        assert.equal(long.routes[index].status, route.status);
        assert.equal(long.routes[index].auditStatus, route.auditStatus);
        const a = comparableHistoryCounters(route), b = comparableHistoryCounters(long.routes[index]);
        return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap(counter =>
            (a[counter] || 0) === (b[counter] || 0) ? [] : [{ mode: short.mode, route: route.route, counter,
                short: a[counter] || 0, long: b[counter] || 0 }]);
    });
}

const samples: HistorySample[] = [];
const reportPath = process.env.GARDA_Q1_REPORT_PATH || path.join(os.tmpdir(), 'garda-q1-history-' + process.pid + '.json');
function retainSample(sample: HistorySample): void {
    samples.push(sample);
    fs.writeFileSync(reportPath, JSON.stringify({ schema_version: 1, samples }, null, 2) + '\n');
}

// Recovery authenticates each restart classification on the current routes. The
// per-restart allowance covers eight JSON decodes on that authentication
// path; all other parsing must remain constant. Two extra fixed parses
// tolerate a prefix witness becoming distinct, never another pass per restart.
const RESTART_CLASSIFICATION_PARSES = 8;
const RESTART_PARSE_TOLERANCE = 2;
function assertLinearRecoveryParses(short: { cycles: number; parses: number },
    long: { cycles: number; parses: number }, route: string): void {
    const constant = short.parses - RESTART_CLASSIFICATION_PARSES * short.cycles;
    assert.ok(constant >= 0, route + ': invalid constant parsing work');
    const budget = constant + RESTART_CLASSIFICATION_PARSES * long.cycles + RESTART_PARSE_TOLERANCE;
    assert.ok(long.parses <= budget,
        `${route}:json_parse_outside_verified_timeline ${long.parses} > ${budget} (constant ${constant} + ${RESTART_CLASSIFICATION_PARSES}/restart + ${RESTART_PARSE_TOLERANCE})`);
}

test('T-451-2-2 linear recovery parse budget rejects one extra parse per restart', () => {
    const sample = (cycles: number, extra = 0) => ({ cycles,
        parses: 37 + (RESTART_CLASSIFICATION_PARSES + extra) * cycles });
    assertLinearRecoveryParses(sample(2), sample(16), 'control');
    assertLinearRecoveryParses(sample(2), { ...sample(16), parses: sample(16).parses + 2 }, 'fixed tolerance');
    assert.throws(() => assertLinearRecoveryParses(sample(2, 1), sample(16, 1), 'extra per restart'),
        /json_parse_outside_verified_timeline/u);
    assert.throws(() => assertLinearRecoveryParses(sample(2), { ...sample(16), parses: sample(16).parses + 3 }, 'excess tolerance'),
        /json_parse_outside_verified_timeline/u);
});

test('T-451-2-2 checkpoint hints share the authenticated timeline parse', { timeout: 600_000 }, async () => {
    await createAuthenticatedNextStepHistoryFixture(1, 3, active => {
        const { withInvocationReadObservation } = require('../../../../src/core/invocation-read-observation') as typeof import('../../../../src/core/invocation-read-observation');
        const { withTaskTimelineFileReadSnapshot } = require('../../../../src/gate-runtime/timeline/task-timeline-read-snapshot') as typeof import('../../../../src/gate-runtime/timeline/task-timeline-read-snapshot');
        const { readInvocationVerifiedTaskEventTimeline } = require('../../../../src/gate-runtime/timeline/task-events-integrity') as typeof import('../../../../src/gate-runtime/timeline/task-events-integrity');
        const { readReviewValidationCheckpoint, readCoherentRedCheckpoint } = require('../../../../src/cli/commands/gate-flows/recovery/recovery-flow-validation-checkpoint') as typeof import('../../../../src/cli/commands/gate-flows/recovery/recovery-flow-validation-checkpoint');
        const timeline = path.join(active.repoRoot, 'garda-agent-orchestrator/runtime/task-events', active.taskId + '.jsonl');
        const lines = new Set(fs.readFileSync(timeline, 'utf8').split(/\r?\n/u).filter(Boolean));
        withInvocationReadObservation(() => withTaskTimelineFileReadSnapshot(timeline, () => {
            const verified = readInvocationVerifiedTaskEventTimeline(timeline, active.taskId);
            assert.equal(verified?.result.status, 'PASS');
            const original = JSON.parse;
            let decodedTimelineLines = 0;
            JSON.parse = (text, reviver) => {
                if (lines.has(text)) decodedTimelineLines++;
                return original(text, reviver);
            };
            try {
                readReviewValidationCheckpoint(active.repoRoot, active.taskId);
                readCoherentRedCheckpoint(active.repoRoot, active.taskId);
            } finally { JSON.parse = original; }
            assert.equal(decodedTimelineLines, 0,
                'checkpoint hints must borrow authenticated parsed events, not decode the complete history again');
        }));
    });
});

test('T-451-2-2 current navigation never copies the complete verified history', { timeout: 600_000 }, async () => {
    await createAuthenticatedNextStepHistoryFixture(1, 3, active => {
        const json = require('../../../../src/core/immutable-json') as typeof import('../../../../src/core/immutable-json');
        const originalCopy = json.cloneJson, originalFreeze = json.cloneFrozenJson;
        const copies: string[] = [];
        const origins = new Map<string, number>();
        const trace = (original: typeof originalCopy): typeof originalCopy => value => {
            const location = (new Error().stack ?? '').split('\n').slice(2, 5).join(' ');
            let count = 0;
            const pending: unknown[] = [value], seen = new Set<object>();
            while (pending.length) {
                const item = pending.pop();
                if (!item || typeof item !== 'object' || seen.has(item)) continue;
                seen.add(item); count++;
                if (Array.isArray(item) && verifiedIndexForEvents(item)) copies.push(location);
                for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(item)))
                    if ('value' in descriptor) pending.push(descriptor.value);
            }
            origins.set(location, (origins.get(location) ?? 0) + count);
            return original(value);
        };
        json.cloneJson = trace(originalCopy); json.cloneFrozenJson = trace(originalFreeze);
        try {
            const route = measureHistoryRoute(active, 'current-history-acquisition');
            assert.equal(route.nextGate, 'record-review-result');
        } finally { json.cloneJson = originalCopy; json.cloneFrozenJson = originalFreeze; }
        console.log('Current acquisition clone owners: ' + JSON.stringify([...origins].sort((a, b) => b[1] - a[1]).slice(0, 8)));
        assert.deepEqual(copies, [], 'current navigation must borrow the canonical complete history instead of copying it');
    });
});

function assertCurrentQualityWork(sample: HistorySample): void {
    assert.ok(sample.routes.some(route => (route.counters.cadence_fast_path || 0) > 0),
        'The real native fixture must exercise the existing authenticated cadence producer.');
    for (const route of sample.routes) for (const counter of ['cadence_legacy_fallback',
        'visit:next-step-quality-checklist-readiness:337', 'visit:next-step-quality-checklist-readiness:467',
        'visit:next-step-quality-checklist-readiness:210', 'visit:next-step-quality-checklist-readiness:239'])
        assert.equal(route.counters[counter] || 0, 0, route.route + ':' + counter);
}

for (const lanes of [1, 5]) test('Q1 scope observation at ' + lanes + ' lanes', { timeout: 600_000 }, async context => {
    for (const sample of await collectAuthenticatedHistorySamples(1, lanes)) {
        retainSample(sample);
        assertCurrentQualityWork(sample);
        const route = sample.routes.find(route => route.route === 'required-reviews-check')!;
        const checks = route.counters['scope_path_state:scope'] || 0, hashes = route.counters['file_hash:scope'] || 0;
        await context.test(sample.mode + ': scope checks and hashes equal 64 files', () => { assert.equal(checks, 64); assert.equal(hashes, 64); });
    }
});

test('Q1 authenticated history budget uses real navigation routes', { timeout: 3_600_000 }, async context => {
    for (const cycles of process.env.GARDA_Q1_INCLUDE_MIDPOINT === '1' ? [2, 8, 16] : [2, 16]) {
        const completedCycles: number[] = [];
        const measuredSamples = await collectAuthenticatedHistorySamples(cycles, 3, cycles === 2, completed => {
            completedCycles.push(completed);
            // Emit real fixture progress: test-context diagnostics are buffered until this long test finishes.
            console.log(`Q1 history fixture: completed cycle ${completed}/${cycles}`);
        });
        assert.deepEqual(completedCycles, Array.from({ length: cycles }, (_, index) => index + 1));
        for (const sample of measuredSamples) {
            retainSample(sample);
            context.diagnostic(JSON.stringify({ cycles, lanes: 3, mode: sample.mode, routes: sample.routes.map(route => ({ route: route.route,
                elapsed_ms: route.elapsedMs, phases_ms: route.phasesMs })) }));
        }
    }
    const mode = 'navigation';
    const short = samples.find(sample => sample.cycles === 2 && sample.mode === mode)!;
    const long = samples.find(sample => sample.cycles === 16 && sample.mode === mode)!;
    await context.test('T-451-2-2 preserved claims and closed observations stay bounded on actual current routes', () => {
        for (const route of ['active-review', 'current-quality-repair', 'required-reviews-check']) {
            const a = short.routes.find(item => item.route === route)!;
            const b = long.routes.find(item => item.route === route)!;
            for (const measured of [a, b]) {
                assert.ok(measured.counters['derive:accepted-review-claims'] > 0, route + ': exercise original preserved claims');
                assert.ok(measured.counters['closed-review-summary:accepted'] > 0, route + ': authenticate closed observations');
                assert.equal(measured.counters['visit:closed-review-capture:producer-bootstrap-event'] || 0, 0,
                    route + ': navigation must not audit unrelated closed artifacts');
            }
            for (const counter of ['derive:accepted-review-claims', 'derive:test-only-review-preservation',
                'visit:closed-review-capture:current-lane', 'visit:closed-review-capture:unclosed-review'])
                assert.equal(b.counters[counter] || 0, a.counters[counter] || 0, route + ':' + counter);
            const parseSample = (sample: HistorySample, measured: typeof a) => ({ cycles: sample.cycles,
                parses: measured.counters.json_parse_outside_verified_timeline || 0 });
            assertLinearRecoveryParses(parseSample(short, a), parseSample(long, b), route);
            // One parse per restart beyond the derived cost must fail even on
            // routes whose actual classification work is cheaper than the budget.
            const redundant = { cycles: long.cycles, parses: parseSample(short, a).parses
                + (RESTART_CLASSIFICATION_PARSES + 1) * (long.cycles - short.cycles) };
            assert.throws(() => assertLinearRecoveryParses(parseSample(short, a), redundant, route),
                /json_parse_outside_verified_timeline/u);

            // At two cycles the earliest global anchor can alias a current prefix slot.
            // At sixteen it is distinct. Each required witness copies one details object;
            // count those fixed packets exactly, rather than permitting arbitrary slack.
            const packets = (entry: typeof a) => entry.counters['visit:route_query_ordered_witness'] || 0;
            const copies = (entry: typeof a) => entry.counters['visit:derivation_json_cloned_object'] || 0;
            assert.ok(packets(a) <= 74 && packets(b) <= 74, route + ': two projections of at most 37 fixed slots');
            assert.equal(copies(b) - packets(b), copies(a) - packets(a),
                route + ': only required fixed witness packets may add clone objects');
        }
    });
    await context.test('T-451-2-1-2 current quality facts avoid historical cadence and binding work', () => {
        assertCurrentQualityWork(short);
        assertCurrentQualityWork(long);
        for (const sample of [short, long]) {
            const repaired = sample.routes.find(route => route.route === 'current-quality-repair');
            assert.ok(repaired, 'Real history must include the authenticated current repair readiness route.');
            assert.ok(repaired.counters.verified_quality_repair_lookup > 0);
            assert.ok(repaired.counters.verified_quality_binding_lookup > 0);
        }
        for (let index = 0; index < short.routes.length; index++) {
            const a = short.routes[index], b = long.routes[index];
            for (const key of ['cadence_fast_path', 'cadence_head_hmac_verify',
                'visit:cadence_window_search_slot', 'visit:cadence_window_row', 'verified_quality_binding_lookup',
                'verified_quality_repair_lookup'])
                assert.equal(b.counters[key] || 0, a.counters[key] || 0, b.route + ':' + key);
        }
    });
    await context.test('T-451-1 current evidence selections are flat at two and sixteen native cycles', () => {
        const required = short.routes.find(route => route.route === 'required-reviews-check')!;
        assert.ok(required.counters.verified_review_witness_lookup > 0, 'The fixture must exercise strict receipt/invocation lookup.');
        assert.ok(required.counters['visit:native_case_attempt_candidate'] > 0, 'The fixture must exercise native case attempt selection.');
        for (let index = 0; index < short.routes.length; index++) {
            const a = short.routes[index], b = long.routes[index];
            for (const key of ['visit:next-step-review-evidence:63', 'visit:review_evidence_compile_candidate',
                'visit:focused_intermediate_task_mode_event']) {
                assert.equal(a.counters[key] || 0, 0, a.route + ':' + key);
                assert.equal(b.counters[key] || 0, 0, b.route + ':' + key);
            }
            for (const key of ['visit:review-reuse-telemetry-strict:event:238',
                'visit:review-reuse-telemetry-strict:event:317', 'visit:review-reuse-telemetry-strict:event:442',
                'visit:focused_intermediate_event', 'visit:native_case_attempt_candidate',
                'verified_review_witness_lookup', 'verified_intermediate_start_lookup'])
                assert.equal(b.counters[key] || 0, a.counters[key] || 0, b.route + ':' + key);
        }
    });
    await context.test('T-451-2-1-1 current recovery facts are flat at two and sixteen native cycles', () => {
        const active = short.routes.find(route => route.route === 'active-review')!;
        assert.ok(active.counters.verified_recovery_sequence_lookup > 0, 'Exercise actual current sequence lookup.');
        assert.ok(active.counters.verified_original_entry_refresh_lookup > 0, 'Exercise actual current recovery prefix lookup.');
        for (let index = 0; index < short.routes.length; index++) {
            const a = short.routes[index], b = long.routes[index];
            for (const key of ['visit:next-step-preflight-recovery:event:1163',
                'visit:next-step-preflight-recovery:event:826']) {
                assert.equal(a.counters[key] || 0, 0, a.route + ':' + key);
                assert.equal(b.counters[key] || 0, 0, b.route + ':' + key);
            }
            for (const key of ['verified_recovery_sequence_lookup', 'verified_original_entry_refresh_lookup'])
                assert.equal(b.counters[key] || 0, a.counters[key] || 0, b.route + ':' + key);
        }
    });
    await context.test(mode + ': indexed route selectors retain constant work on real authenticated history', () => {
        for (let index = 0; index < short.routes.length; index++) {
            const a = short.routes[index], b = long.routes[index];
            for (const key of ['visit:next-step-reviewer-launch-evidence-shared:35',
                'visit:next-step-review-invocation-evidence:50', 'visit:next-step-review-evidence:187',
                'visit:next-step-review-evidence:632', 'visit:next-step-reviewer-launch-evidence:event:1181']) {
                assert.equal(a.counters[key] || 0, 0, a.route + ':' + key);
                assert.equal(b.counters[key] || 0, 0, b.route + ':' + key);
            }
            for (const key of ['visit:route_query_preflight_witness', 'visit:route_query_preflight_prefix_witness',
                'visit:route_query_witness_comparison', 'visit:route_query_attestation_candidate'])
                assert.equal(b.counters[key] || 0, a.counters[key] || 0, b.route + ':' + key);
        }
    });
    await context.test(mode + ': Q7 terminal report object projections are flat on the existing 2/16-cycle fixtures', () => {
        for (const route of ['DONE', 'post-done-drift']) {
            const a = short.routes.find(sample => sample.route === route)!;
            const b = long.routes.find(sample => sample.route === route)!;
            assert.equal(b.counters['visit:terminal-materialized:parsed-value'], a.counters['visit:terminal-materialized:parsed-value'], route);
            context.diagnostic(JSON.stringify({ route, samples: [short, long].map(sample => ({
                cycles: sample.cycles, file_bytes: sample.materializedBytes,
                bytes_hashed: sample.routes.find(value => value.route === route)!.counters.terminal_materialized_bytes_hashed,
                parsed_values: sample.routes.find(value => value.route === route)!.counters['visit:terminal-materialized:parsed-value']
            })) }));
        }
    });
    // Retain every measured difference, including mandatory current-file byte work.
    // The operator prioritizes correct navigation and removal of redundant work over literal zero differences.
    const changed = differences(short, long);
    const growing = [...new Set(changed.filter(entry => entry.long > entry.short).map(entry => entry.counter))];
    context.diagnostic('Q1 ' + mode + ' growing counters: ' + JSON.stringify(growing));
    context.diagnostic('Q1 ' + mode + ' remaining counter differences: ' + JSON.stringify(changed));
    await context.test(mode + ': consumers share one verified index without duplicate timeline parsing or copies', () => {
        for (const sample of samples) for (const route of sample.routes) {
            assert.equal(route.counters.timeline_verify, 1, route.route + ': full integrity verification remains live');
            assert.ok(route.counters.timeline_events > 0, route.route + ': real history was visited');
            assert.equal(route.counters['visit:verified_timeline_index_event'], route.counters.timeline_events,
                route.route + ': canonical fixture events enter the shared index exactly once');
            for (const key of ['visit:validation_timeline_parse_event', 'visit:timeline_cloned_event',
                'visit:audit_ordered_event_copy']) assert.equal(route.counters[key] || 0, 0, route.route + ':' + key);
        }
    });
    await context.test(mode + ': authenticated artifact reads and parsing do not multiply with closed cycles', () => {
        for (let index = 0; index < short.routes.length; index++)
            assertStableAuthenticatedArtifactWork(short.routes[index], long.routes[index]);
        for (const sample of samples.filter(sample => sample.mode === mode)) for (const route of sample.routes) {
            assert.equal(route.counters['timeline_payload_read:task'], 1);
            assert.equal(route.counters.timeline_parse, 1);
        }
    });
    context.diagnostic('Full per-path/per-cycle counters: ' + reportPath);
});


test('Q1 archived receipt corruption preserves navigation but blocks full audit', { timeout: 600_000 }, async context => {
    const fixture = await createAuthenticatedNextStepHistoryFixture(2, 3);
    const before = measureHistoryRoute(fixture, 'required-reviews-check');
    assert.equal(before.nextGate, 'required-reviews-check', before.reason);
    const eventsRoot = path.join(fixture.repoRoot, 'garda-agent-orchestrator/runtime/task-events');
    const beforeGuard = readReviewCycleGuardEvaluation(fixture.repoRoot, eventsRoot, fixture.taskId);
    assert.equal(beforeGuard.evaluation.should_block, false);
    const oldReceiptPath = fixture.historicalArtifacts[0];
    assert.equal(fixture.artifactCycles[path.resolve(oldReceiptPath)], 0);
    const original = fs.readFileSync(oldReceiptPath);
    const currentReceiptPath = path.join(fixture.repoRoot, 'garda-agent-orchestrator/runtime/reviews',
        fixture.taskId + '-code-receipt.json');
    assert.equal(original.equals(fs.readFileSync(currentReceiptPath)), false,
        'The changed receipt belongs to an earlier cycle, not the accepted current code review.');
    try {
        fs.appendFileSync(oldReceiptPath, ' ');
        const guard = readReviewCycleGuardEvaluation(fixture.repoRoot, eventsRoot, fixture.taskId);
        assert.equal(guard.evaluation.should_block, false,
            'A superseded receipt does not block active-task navigation; full audit still verifies it below.');
        assert.deepEqual(guard.lostCurrentResultReviewTypes, []);
        const changed = measureHistoryRoute(fixture, 'tampered-closed-receipt');
        assert.equal(changed.nextGate, before.nextGate,
            'Unused closed archive corruption is rejected by the full audit under A8.');
        assert.equal(changed.auditStatus, before.auditStatus);
        const audit = buildTaskAuditSummary(fixture);
        assert.equal(audit.status, 'BLOCKED');
        assert.ok(audit.blockers.some(blocker => /history integrity|committed receipt|snapshot/iu.test(blocker.reason)));
        context.diagnostic(JSON.stringify({ before: { nextGate: before.nextGate, auditStatus: before.auditStatus },
            tampered: { nextGate: changed.nextGate, status: changed.status, auditStatus: changed.auditStatus,
                reason: changed.reason }, violations: guard.evaluation.violations }));
    } finally { fs.writeFileSync(oldReceiptPath, original); }
    assert.equal(measureHistoryRoute(fixture, 'restored').nextGate, before.nextGate);
});
