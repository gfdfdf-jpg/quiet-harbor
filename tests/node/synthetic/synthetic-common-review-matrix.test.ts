import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { COMMON_REVIEW_MATRIX, MATRIX_MODES, commonReviewMatrixCells, matrixLaunchContract, reviewMatrixProblems, selectCommonReviewCells, type MatrixCellResult } from './engine/common-review-matrix';
import { STACK_MANIFESTS } from './engine/walk-stack-fixtures';
import { assertMatrixReuseReceipt, nativeReviewMatrixScenario, requireMatrixReuseOrigin } from './engine/review-matrix-native';

test('the five T-022-2 audit controls encode scope, changed intent, first review, structural repair and recovery rules', () => {
    const controls = COMMON_REVIEW_MATRIX.filter(row => row.id.startsWith('audit-'));
    assert.equal(controls.length, 5);
    const s1 = controls.find(row => row.id === 'audit-s1-config-expansion')!;
    assert.equal(s1.repairs[0].kind, 'new-config');
    assert.deepEqual(s1.launches, ['code:FULL', 'code:FULL', 'refactor:FULL', 'api:FULL', 'test:FULL']);
    const s2 = controls.find(row => row.id === 'audit-s2-changed-intent')!;
    assert.ok(s2.changeIntentAfterSecurityPass);
    assert.equal(s2.launches.filter(value => value === 'code:FULL').length, 2);
    assert.ok(s2.launches.every(value => value.endsWith(':FULL')));
    const s3 = controls.find(row => row.id === 'audit-s3-production-structural-fix')!;
    assert.deepEqual(s3.launches.slice(-4), ['code:DELTA', 'refactor:DELTA', 'performance:DELTA', 'test:FULL']);
    assert.equal(s3.launches.filter(value => value.startsWith('test:')).length, 1, 'No previous test review can serve as a DELTA base');
    const s4 = controls.find(row => row.id === 'audit-s4-structural-test-28')!;
    assert.equal(s4.repairs[0].lines, 28);
    assert.equal(s4.structuralTestThreshold, 20, 'The field input freezes a lower structural threshold before entry');
    assert.deepEqual(s4.launches.slice(7), ['refactor:DELTA', 'test:DELTA']);
    const recovery = controls.find(row => row.id === 'audit-recovery-no-fresh-review')!;
    assert.ok(recovery.exerciseCloseoutRecovery);
    assert.deepEqual(recovery.launches, ['code:FULL', 'refactor:FULL', 'api:FULL', 'test:FULL']);
    for (const entry of controls) {
        const cell = commonReviewMatrixCells().find(cell => cell.row === entry.id)!;
        const valid = { id: cell.id, outcome: 'done', launches: entry.launches, findings: [], nativeSteps: 50 };
        assert.deepEqual(reviewMatrixProblems([valid], [cell]), []);
        assert.ok(reviewMatrixProblems([{ ...valid, launches: [...entry.launches, 'code:FULL'] }], [cell])
            .some(problem => problem.startsWith('review-contract:')), entry.id + ': extra fresh review must fail');
    }
});

test('one common review matrix instantiates every row on every stack and all four dependency modes', () => {
    const cells = commonReviewMatrixCells();
    assert.equal(cells.length, COMMON_REVIEW_MATRIX.length * STACK_MANIFESTS.length * MATRIX_MODES.length);
    assert.equal(new Set(cells.map(cell => cell.id)).size, cells.length);
    for (const row of COMMON_REVIEW_MATRIX) for (const mode of MATRIX_MODES) {
        const contracts = STACK_MANIFESTS.map(stack => nativeReviewMatrixScenario(stack, row, mode));
        for (const scenario of contracts) {
            assert.deepEqual(scenario.expectedModes, row.launches);
            assert.deepEqual(scenario.expectedReviews, matrixLaunchContract(row).expectedReviews);
            assert.ok(scenario.fixture?.taskTestInvocations?.length);
            assert.ok(scenario.inspectResult);
            const directorySpellings = new Map<string, string>();
            for (const relative of Object.keys(scenario.fixture!.files)) {
                const components = relative.split('/');
                for (let depth = 1; depth < components.length; depth++) {
                    const directory = components.slice(0, depth).join('/');
                    const key = directory.toLowerCase(), previous = directorySpellings.get(key);
                    if (previous !== undefined) assert.equal(directory, previous,
                        scenario.id + ': fixture directories must keep one spelling on case-insensitive hosts');
                    directorySpellings.set(key, directory);
                }
            }
        }
    }
});

test('review matrix refuses missing cells, duplicate cells, foreign cells and absent native traces', () => {
    const cells = commonReviewMatrixCells().slice(0, 2);
    const valid: MatrixCellResult[] = cells.map(cell => ({ id: cell.id, outcome: 'done',
        launches: [...COMMON_REVIEW_MATRIX.find(row => row.id === cell.row)!.launches], findings: [], nativeSteps: 50 }));
    assert.deepEqual(reviewMatrixProblems(valid, cells), []);
    assert.ok(reviewMatrixProblems(valid.slice(0, 1), cells).some(problem => problem.startsWith('missing-cell:')));
    assert.ok(reviewMatrixProblems([...valid, valid[0]], cells).some(problem => problem.startsWith('duplicate-cell:')));
    assert.ok(reviewMatrixProblems([...valid, { ...valid[0], id: 'foreign' }], cells).some(problem => problem.startsWith('foreign-cell:')));
    assert.ok(reviewMatrixProblems([{ ...valid[0], nativeSteps: 0 }, valid[1]], cells).some(problem => problem.startsWith('missing-native-trace:')));
});

test('review matrix refuses an extra review, a missing review and FULL instead of allowed DELTA', () => {
    const cell = commonReviewMatrixCells().find(item => item.row === 'passed-delta-then-test')!;
    const row = COMMON_REVIEW_MATRIX.find(item => item.id === cell.row)!;
    const valid: MatrixCellResult = { id: cell.id, outcome: 'done', launches: [...row.launches], findings: [], nativeSteps: 70 };
    assert.deepEqual(reviewMatrixProblems([valid], [cell]), []);
    for (const launches of [[...row.launches, 'code:FULL'], row.launches.slice(0, -1),
        row.launches.map(mode => mode === 'code:DELTA' ? 'code:FULL' : mode)]) {
        assert.ok(reviewMatrixProblems([{ ...valid, launches }], [cell]).some(problem => problem.startsWith('review-contract:')));
    }
    assert.ok(reviewMatrixProblems([{ ...valid, findings: ['reuse accepted forged receipt'] }], [cell]).length);
});

test('reuse oracle refuses missing reuse telemetry, a foreign preflight, changed report bytes and a substituted origin', () => {
    const origin = { preflight_sha256: 'old', review_artifact_sha256: 'report', review_context_sha256: 'context',
        review_tree_state_sha256: 'tree', review_scope_sha256: 'scope', code_scope_sha256: 'code' };
    const receipt = { preflight_sha256: 'current', review_artifact_sha256: 'report', reused_existing_review: true,
        reused_from_review_context_sha256: 'context', reused_from_review_tree_state_sha256: 'tree',
        reused_from_review_scope_sha256: 'scope', reused_from_code_scope_sha256: 'code' };
    const bytes = { original: 'report', current: 'report' };
    assert.doesNotThrow(() => assertMatrixReuseReceipt(origin, receipt, 'current', bytes));
    for (const changed of [{ reused_existing_review: false }, { preflight_sha256: 'foreign' }, { review_artifact_sha256: 'different' },
        { reused_from_review_context_sha256: 'different' }, { reused_from_review_tree_state_sha256: 'different' },
        { reused_from_review_scope_sha256: 'different' }, { reused_from_code_scope_sha256: 'different' }])
        assert.throws(() => assertMatrixReuseReceipt(origin, { ...receipt, ...changed }, 'current', bytes));
    assert.throws(() => assertMatrixReuseReceipt(origin, receipt, 'current', { ...bytes, current: 'changed bytes' }));
    assert.throws(() => requireMatrixReuseOrigin(new Map(), 'code', 10, 20));
    assert.throws(() => requireMatrixReuseOrigin(new Map([['code', { step: 11, receipt: origin, reportSha256: 'report' }]]), 'code', 10, 20));
    const validOrigin = { step: 11, receipt: { ...origin, review_findings_disposition: { blocking_count: 0 } }, reportSha256: 'report' };
    assert.doesNotThrow(() => requireMatrixReuseOrigin(new Map([['code', validOrigin]]), 'code', 10, 20));
    assert.throws(() => requireMatrixReuseOrigin(new Map([['code', validOrigin]]), 'code', 12, 20));
});

test('matrix guard boundaries include equality, overflow and multiple histories rather than a single repair kind', () => {
    for (const id of ['source-line-limit-239', 'source-line-limit-240', 'source-line-limit-241',
        'source-file-limit-3', 'source-file-limit-4', 'source-file-limit-5', 'test-refactor-49', 'test-refactor-50', 'test-refactor-51',
        'consecutive-delta-cap', 'passed-delta-then-test', 'source-then-two-test-repairs'])
        assert.ok(COMMON_REVIEW_MATRIX.some(row => row.id === id), id);
    assert.equal(COMMON_REVIEW_MATRIX.find(row => row.id === 'consecutive-delta-cap')!.repairs.length, 5);
});

test('matrix graph rows invalidate accepted downstream reviews and distinguish a chain from a fanout', () => {
    const launches = (id: string) => COMMON_REVIEW_MATRIX.find(row => row.id === id)!.launches;
    assert.notDeepEqual(launches('dependency-independent'), launches('dependency-chain'));
    assert.notDeepEqual(launches('dependency-helper-chain'), launches('dependency-helper-fanout'));
    assert.equal(launches('dependency-helper-chain').filter(lane => lane === 'api:DELTA').length, 1);
    assert.equal(launches('dependency-helper-fanout').filter(lane => lane.startsWith('code:')).length, 1);
    for (const stack of STACK_MANIFESTS) {
        const scenario = nativeReviewMatrixScenario(stack, COMMON_REVIEW_MATRIX.find(row => row.id === 'dependency-helper-chain')!, 'strict_sequential');
        const helper = scenario.remediationSequence![0].edits[0].path;
        assert.ok(scenario.edits.some(edit => edit.path === helper), 'The helper must belong to the original reviewed scope');
        assert.ok(scenario.fixture!.taskTestSupport?.some(support => support.path === helper && support.role === 'helper'),
            'The helper must have a real declared relation to selected tests');
    }
});

test('matrix entry builds current source before loading any stale compiled oracle', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-matrix-bootstrap-'));
    try {
        const entry = path.join(root, 'tests/node/synthetic/review-matrix.cjs');
        const oracle = path.join(root, '.node-build/tests/node/synthetic/engine/common-review-matrix.js');
        const driver = path.join(root, 'scripts/node-foundation/build-scripts.cjs');
        for (const file of [entry, oracle, driver]) fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.copyFileSync('tests/node/synthetic/review-matrix.cjs', entry);
        fs.writeFileSync(oracle, 'throw new Error("STALE compiled oracle must never be executed");\n');
        fs.writeFileSync(driver, 'const fs=require("node:fs");\n'
            + 'if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(["build.js","node-foundation"]))process.exit(2);\n'
            + 'fs.writeFileSync(' + JSON.stringify(oracle) + ',"module.exports={COMMON_REVIEW_MATRIX:[{id:\\"current-source\\"}],commonReviewMatrixCells:()=>[]};");\n');
        const result = spawnSync(process.execPath, [entry, 'inventory'], { cwd: root, encoding: 'utf8', windowsHide: true });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).rows[0].id, 'current-source');
    } finally {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('parallel matrix partitions run every native cell once without changing coverage or its review contract', () => {
    const cells = commonReviewMatrixCells(), observed = [];
    for (let shard = 1; shard <= 128; shard++) for (let worker = 1; worker <= 2; worker++)
        observed.push(...selectCommonReviewCells(cells, { index: shard, total: 128 }, { index: worker, total: 2 }));
    assert.equal(observed.length, cells.length);
    assert.deepEqual(observed.map(cell => cell.id).sort(), cells.map(cell => cell.id).sort());
    assert.equal(new Set(observed.map(cell => cell.id)).size, cells.length);
    for (const invalid of [{ index: 0, total: 2 }, { index: 3, total: 2 }, { index: 1, total: 129 }, { index: 1.5, total: 2 }])
        assert.throws(() => selectCommonReviewCells(cells, invalid));
    assert.throws(() => selectCommonReviewCells(cells, { index: 1, total: 2 }, { index: 1, total: 25 }));
});

for (const failedTarget of ['publish-runtime', 'node-foundation']) test('native matrix runtime bootstrap fails closed: ' + failedTarget, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-matrix-runtime-'));
    try {
        const entry = path.join(root, 'tests/node/synthetic/review-matrix.cjs');
        const oracle = path.join(root, '.node-build/tests/node/synthetic/engine/common-review-matrix.js');
        const driver = path.join(root, 'scripts/node-foundation/build-scripts.cjs');
        for (const file of [entry, oracle, driver]) fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.copyFileSync('tests/node/synthetic/review-matrix.cjs', entry);
        fs.writeFileSync(oracle, 'throw new Error("STALE_ORACLE_EXECUTED");');
        fs.writeFileSync(driver, 'const target=process.argv[3];if(target===' + JSON.stringify(failedTarget) + ')process.exit(63);');
        const result = spawnSync(process.execPath, [entry, 'run', '--report', path.join(root, 'report')],
            { cwd: root, encoding: 'utf8', windowsHide: true });
        assert.notEqual(result.status, 0);
        assert.ok(result.stderr.includes('Current source compilation failed (' + failedTarget + '): 63'), result.stderr);
        assert.ok(!result.stderr.includes('STALE_ORACLE_EXECUTED'), 'Failed preparation must never load an older compiled oracle');
    } finally {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        fs.rmSync(root, { recursive: true, force: true });
    }
});
