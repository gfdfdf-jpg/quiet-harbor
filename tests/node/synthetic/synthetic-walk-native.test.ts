import './engine/walk-route-observer';
import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetWalkResults, buildWalkReport, loadedCodePathReport } from './engine/walk-report';
import { verdictResult } from './engine/walk-metrics';
import type { WalkResult } from './engine/navigator-walk';
import { retryWalkNavigation } from './engine/navigator-walk';
import { nativeEffectNeedsReinspection, nativeWalkPathFindings } from './engine/walk-native';

test('navigation follows one structured retry and exposes a repeated refusal without retrying integrity errors', () => {
    const command = 'node garda-agent-orchestrator/bin/garda.js next-step "T-WALK" --repo-root "."';
    const result = { status: 'BLOCKED' as const, next_gate: 'git-observation', retryable: true as const,
        reason: 'Workspace planned-source scope changed during the retained generation; retry the invocation.',
        navigator_command: command, commands: [{ label: 'Retry next-step', command }] };
    assert.equal(retryWalkNavigation(result, 'task-test-selection'), true);
    assert.throws(() => retryWalkNavigation(result, 'git-observation'), /refusal repeated: Workspace planned-source scope changed/u);
    assert.equal(retryWalkNavigation({ ...result, retryable: undefined }), false);
    assert.equal(retryWalkNavigation({ ...result, next_gate: 'task-reset' }), false);
    assert.equal(retryWalkNavigation({ ...result, status: 'READY' }), false);
    assert.throws(() => retryWalkNavigation({ ...result, commands: [] }), /Invalid retryable/u);
    assert.throws(() => retryWalkNavigation({ ...result, navigator_command: command + ' --execute-effects',
        commands: [{ label: 'Retry', command: command + ' --execute-effects' }] }), /Invalid retryable/u);
});

test('native effect errors follow explicit reinspection guidance without hiding integrity refusals', () => {
    assert.equal(nativeEffectNeedsReinspection('FAIL\nNext-step effect plan is stale: expected abc, found def. Rerun next-step inspection.\n'), true);
    assert.equal(nativeEffectNeedsReinspection('Review-context recovery evidence changed. Rerun next-step inspection.'), true);
    assert.equal(nativeEffectNeedsReinspection('Loaded code differs from current executable bytes.'), false);
    assert.equal(nativeEffectNeedsReinspection('Rerun next-step inspection.'), false);
});

test('a DONE field fallback cannot masquerade as native-summary acceptance', () => {
    const result = { scenarioId: 'field-onlinestore-t022-1-closeout', outcome: 'done', steps: [{ measurement: { work: {
        loaded_code_receipts_unavailable: 1, 'closed-review-summary:rejected:capture': 1
    } } }] } as unknown as WalkResult;
    assert.equal(nativeWalkPathFindings(result).length, 2);
    assert.equal(result.steps[0].measurement!.work['closed-review-summary:accepted'], undefined);
    assert.equal(nativeWalkPathFindings({ ...result, steps: [] }).length, 1, 'Missing work is not acceptance either');
});

test('paired reduction judges native work and retains the separate coverage refusal through merge', () => {
    const native = { scenarioId: 'paired', elapsedMs: 1234, steps: [{ diagnostic: {},
        measurement: { phases_ms: { 'code.capture': 23 }, work: {
            'closed-review-summary:accepted': 1, 'code.capture': 1, 'visit:loaded_code_initial_file': 7,
            'file_hash:C:\\fixture\\garda-agent-orchestrator\\dist\\src\\core\\loaded-code-identity.js': 1
        } } }] } as unknown as WalkResult;
    const coverage = { scenarioId: 'paired', nativeBudget: native, steps: [{ routes: ['source-point'],
        measurement: { work: { loaded_code_receipts_unavailable: 1, 'closed-review-summary:rejected:capture': 1 } } }] } as unknown as WalkResult;
    assert.equal(budgetWalkResults([coverage])[0], native);
    assert.deepEqual(coverage.steps[0].routes, ['source-point']);
    const rows = loadedCodePathReport([coverage]);
    assert.equal(rows[0].summaryCaptureRejected, 1);
    assert.equal(rows[0].summaryAccepted, 0);
    assert.equal(rows[1].path, 'native');
    assert.equal(rows[1].receiptsUnavailable, 0);
    assert.equal(rows[1].summaryAccepted, 1);
    assert.deepEqual(rows[1].codeCaptureMs, { total: 23, median: 23, max: 23 });
    assert.equal(rows[1].loadedCodeFiles.max, 7);
    assert.equal(rows[1].runtimeFileHashes.max, 1);
    assert.deepEqual(loadedCodePathReport([verdictResult(coverage)]), rows);
    assert.equal(budgetWalkResults([verdictResult(coverage)])[0].steps[0].measurement!.work['closed-review-summary:accepted'], 1);
});

test('report coverage follows the instrumented replay while the counter verdict follows the native replay', () => {
    const result = (gate: string, hashes: number): WalkResult => ({ scenarioId: 'paired-report', outcome: 'done', detail: '',
        events: [], reviews: [], reviewsByLane: {}, steps: [{ index: 0, gate, status: 'BLOCKED', route: 'BLOCKED/' + gate,
            command: null, navigatorMs: 1, commandMs: 0, exitCode: null, output: '', reason: '', taskEvents: 0, workspaceSha256: '',
            measurement: { phases_ms: { total: 1 }, work: { 'file_hash:C:\\fixture\\dist\\runtime.js': hashes } } }] });
    const coverage = result('enter-task-mode', 1);
    coverage.nativeBudget = result('completion-gate', 100_000);
    const report = buildWalkReport([coverage], []);
    assert.equal(report.coverage.gates.find(row => row.id === 'gate:enter-task-mode')?.steps, 1);
    assert.equal(report.coverage.gates.find(row => row.id === 'gate:completion-gate')?.steps, 0);
    assert.equal(report.metrics[0].route, 'BLOCKED/completion-gate');
    assert.ok(report.anomalies.some(row => row.kind === 'counter-budget' && row.metric === 'file_hash:file'
        && row.observed === 100_000), 'An expensive native path must fail even when instrumented work was cheap');
});
