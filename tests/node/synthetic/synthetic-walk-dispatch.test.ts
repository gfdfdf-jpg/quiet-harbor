import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendMandatoryTaskEvent } from '../../../src/gate-runtime/task-events';
import { fileSha256 } from '../../../src/gate-runtime/hash';
import { buildResult } from '../gates/next-step/next-step-presentation-fixture';
import { assertRemediationBeforeValidation } from './engine/walk-navigation-invariants';
import { WalkDispatchGuard, canonicalEvidenceText, normalizeDispatchedArgv, semanticEvidenceState } from './engine/walk-dispatch-guard';

// Backfill group 2: the walk fails a repeated dispatch (same gate, same argv, same semantic state) on its second
// dispatch, whatever metadata grows between the attempts. Unit controls here; the walks apply it to every dispatch.

const BUNDLE = 'garda-agent-orchestrator';
const COMMAND = 'node garda-agent-orchestrator/bin/garda.js gate run-intermediate-command --task-id "T-WALK" --repo-root "."';
const dispatch = (state: string, command = COMMAND) => ({ taskId: 'T-WALK', gate: 'run-intermediate-command', lane: '', command, state });

function repository(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-dispatch-'));
    fs.mkdirSync(path.join(root, BUNDLE, 'runtime', 'reviews'), { recursive: true });
    fs.mkdirSync(path.join(root, BUNDLE, 'runtime', 'task-events'), { recursive: true });
    return root;
}
const artifact = (root: string) => path.join(root, BUNDLE, 'runtime', 'reviews', 'T-WALK-intermediate.json');

test('a repeated dispatch at an unchanged semantic state fails on the second dispatch', () => {
    const guard = new WalkDispatchGuard();
    assert.equal(guard.observe(dispatch('state-a'), { retries: [], previousFailed: false }), null);
    const violation = guard.observe(dispatch('state-a'), { retries: [], previousFailed: true });
    assert.match(violation ?? '', /Dispatch 2 of run-intermediate-command repeats the same argv at an unchanged semantic state/u);
    // A changed argv or a changed semantic state is a different dispatch.
    assert.equal(guard.observe(dispatch('state-b'), { retries: [], previousFailed: true }), null);
    assert.equal(guard.observe(dispatch('state-a', COMMAND + ' --selected-case "x"'), { retries: [], previousFailed: true }), null);
});

test('a declared bounded retry needs an observable failed attempt and never exceeds its bound', () => {
    const retries = [{ gate: 'run-intermediate-command', attempts: 1 }];
    const guard = new WalkDispatchGuard();
    assert.equal(guard.observe(dispatch('s'), { retries, previousFailed: false }), null);
    assert.equal(guard.observe(dispatch('s'), { retries, previousFailed: true }), null, 'one retry after a failed attempt');
    assert.match(guard.observe(dispatch('s'), { retries, previousFailed: true }) ?? '', /beyond its declared bounded retry/u);
    const silent = new WalkDispatchGuard();
    silent.observe(dispatch('s'), { retries, previousFailed: false });
    assert.ok(silent.observe(dispatch('s'), { retries, previousFailed: false }), 'a passed attempt is not a retry');
    const undeclared = new WalkDispatchGuard();
    undeclared.observe(dispatch('s'), { retries: [{ gate: 'compile-gate', attempts: 3 }], previousFailed: false });
    assert.ok(undeclared.observe(dispatch('s'), { retries: [{ gate: 'compile-gate', attempts: 3 }], previousFailed: true }), 'only the declared gate may retry');
});

test('timestamp-like selected cases are semantic and approval timestamp flags are volatile', () => {
    const guard = new WalkDispatchGuard();
    const context = { retries: [], previousFailed: false };
    for (const stamp of ['2026-11-22T10:00:00Z', '2026-11-22T10:05:00Z']) {
        assert.equal(guard.observe(dispatch('same', COMMAND + ' --selected-case ' + stamp), context), null);
    }
    assert.deepEqual(normalizeDispatchedArgv('node g.js gate x --operator-confirmed-at-utc 2026-11-22T10:00:00Z --a 1'),
        ['node', 'g.js', 'gate', 'x', '--operator-confirmed-at-utc', '<volatile>', '--a', '1']);
    assert.deepEqual(normalizeDispatchedArgv('node g.js gate x --operator-confirmed-at-utc=2026-11-22T10:00:00Z'),
        ['node', 'g.js', 'gate', 'x', '--operator-confirmed-at-utc', '<volatile>']);
});

test('a repeated multi-event failure cannot hide a loop, while an authenticated repair makes progress', () => {
    const root = repository();
    const bundle = path.join(root, BUNDLE);
    const record = (status: 'PASS' | 'FAIL', time: string) => {
        fs.writeFileSync(artifact(root), JSON.stringify({ status, recorded_at_utc: time, command: 'x' }));
        appendMandatoryTaskEvent(bundle, 'T-WALK', 'INTERMEDIATE_COMMAND_RECORDED', status, 'attempt',
            { artifact_path: artifact(root), artifact_sha256: fileSha256(artifact(root)) });
        appendMandatoryTaskEvent(bundle, 'T-WALK', 'COMPILE_GATE_FAILED', 'FAIL', 'follow-up refusal', {});
    };
    try {
        record('FAIL', '2026-11-22T10:00:00Z');
        const first = semanticEvidenceState(root, 'T-WALK', 'workspace');
        record('FAIL', '2026-11-22T10:05:00Z');
        fs.writeFileSync(path.join(path.dirname(artifact(root)), 'unrelated.json'), '{"status":"PASS"}');
        appendMandatoryTaskEvent(bundle, 'T-OTHER', 'COMPILE_GATE_PASSED', 'PASS', 'unrelated', {});
        assert.equal(semanticEvidenceState(root, 'T-WALK', 'workspace'), first);
        const guard = new WalkDispatchGuard();
        assert.equal(guard.observe(dispatch(first), { retries: [], previousFailed: true }), null);
        assert.match(guard.observe(dispatch(semanticEvidenceState(root, 'T-WALK', 'workspace')), { retries: [], previousFailed: true }) ?? '',
            /unchanged semantic state/u);
        assert.notEqual(semanticEvidenceState(root, 'T-WALK', 'edited workspace'), first);
        record('PASS', '2026-11-22T10:06:00Z');
        const repaired = semanticEvidenceState(root, 'T-WALK', 'workspace');
        assert.notEqual(repaired, first);
        assert.equal(guard.observe(dispatch(repaired), { retries: [], previousFailed: false }), null);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
    assert.equal(canonicalEvidenceText({ b: 1, a: { finished_at: 'x', value: '2026-11-22T10:00:00Z', keep: 2 } }),
        '{"a":{"keep":2,"value":"2026-11-22T10:00:00Z"},"b":1}');
});

test('after an attested fix_now failure on the unchanged tree a validation route is refused until the fix is applied (OP-045)', () => {
    const route = (nextGate: string) => buildResult({ next_gate: nextGate });
    for (const gate of ['compile-gate', 'quality-checklist', 'task-test-selection', 'full-suite-validation', 'run-intermediate-command']) {
        assert.throws(() => assertRemediationBeforeValidation(route(gate), true), /OP-045/u, gate);
        assertRemediationBeforeValidation(route(gate), false);
    }
    // Remediation routes and the other lane's review bookkeeping stay legal while the fix is pending.
    for (const gate of ['restart-review-cycle', 'implementation', 'record-review-result', 'materialize-review-follow-up-tasks']) {
        assertRemediationBeforeValidation(route(gate), true);
    }
});
