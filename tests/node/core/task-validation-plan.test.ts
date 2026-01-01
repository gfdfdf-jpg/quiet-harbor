import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskValidationPlan, declaredValidationCommandTargets, literalValidationValues, taskValidationProcessViolations,
    taskValidationLiteralAssociation, taskValidationRequiresSemanticReview, taskValidationSemanticReviewViolations,
    reusableTaskValidationPlan, type TaskValidationProcessEvidence } from '../../../src/core/task-validation-plan';
import { validationDigest } from '../../../src/core/project-validation-identity';

const sources = ['a/checks/Boundary.java', 'b/checks/Purchase.case'].map(path => ({ path, sha256: 'a'.repeat(64) }));

test('an unexecuted generic declaration binds exact targets without granting execution evidence', () => {
    const targets = sources.map(source => source.path);
    assert.deepEqual(declaredValidationCommandTargets('opaque-check --cases=Boundary,Purchase', targets), targets);
    assert.deepEqual(declaredValidationCommandTargets('opaque-check --cases=OtherBoundary,PurchaseExtra', targets), []);
    assert.deepEqual(declaredValidationCommandTargets('opaque-check Boundary && unrelated Purchase', targets), []);
});

test('literal association is exact across paths, stems, selectors and comma list members', () => {
    assert.deepEqual(literalValidationValues(['-Dtest=Boundary,Purchase']), ['-Dtest=Boundary,Purchase', 'Boundary,Purchase', 'Boundary', 'Purchase']);
    for (const token of ['a/checks/Boundary.java', 'Boundary', '-Dtest=Boundary,Other'])
        assert.ok(taskValidationLiteralAssociation([token], sources[0].path), token);
    for (const token of ['BoundaryExtra', '-Dtest=OtherBoundary', 'prefix/a/checks/Boundary.java.suffix'])
        assert.equal(taskValidationLiteralAssociation([token], sources[0].path), null, token);
});

test('polyglot plan binds each command and cannot omit one target or introduce an unbound invocation', () => {
    const command = 'jvm-check Boundary && unfamiliar-check Purchase';
    const plan = buildTaskValidationPlan(command, sources);
    assert.deepEqual(plan.targets.map(target => target.invocation), [0, 1]);
    assert.throws(() => buildTaskValidationPlan('jvm-check Boundary', sources), /Purchase.*exact argv association/u);
    assert.throws(() => buildTaskValidationPlan(command + ' && unrelated-check', sources), /Every declared command/u);
    assert.throws(() => buildTaskValidationPlan('echo Boundary | hidden-check', sources), /argument syntax/u);
    const repeated = buildTaskValidationPlan('jvm-check Boundary && isolated-jvm-check Boundary', [sources[0]]);
    assert.deepEqual(repeated.targets.map(target => target.invocation), [0, 1]);
});

test('symbolic entrypoint and helper bindings are explicit review claims', () => {
    const inputs = [...sources, { path: 'data/seed.bin', sha256: 'b'.repeat(64) }];
    const plan = buildTaskValidationPlan('project-check local-behavior', inputs, {
        targets: sources.map(source => ({ path: source.path, entrypoint: 'project-check', reason: 'Runs this task behavior.' })),
        support: [{ path: 'data/seed.bin', role: 'fixture', targets: sources.map(source => source.path) }] });
    assert.equal(plan.requires_semantic_review, true);
    assert.equal(plan.support.length, 1);
    assert.throws(() => buildTaskValidationPlan('other-check', inputs, {
        targets: sources.map(source => ({ path: source.path, entrypoint: 'project-check', reason: 'Runs behavior.' })) }), /exact argv association/u);
});

test('only symbolic mappings or changed test-like support add mandatory test review', () => {
    const paths = ['tests/a.test.js', 'tests/b.test.js', 'qa/seed.blob'];
    const inputs = paths.map(path => ({ path, sha256: 'a'.repeat(64) }));
    const regexes = ['(^|/)tests/'];
    for (const role of ['helper', 'fixture', 'runner', 'config'] as const) {
        const plan = buildTaskValidationPlan('own-runner tests/a.test.js', inputs, { support: [
            { path: paths[1], role, targets: [paths[0]] }, { path: paths[2], role, targets: [paths[0]] }] });
        assert.equal(plan.requires_semantic_review, false);
        assert.equal(taskValidationRequiresSemanticReview(plan, ['src/engine.js', paths[1]], regexes), true, role);
        assert.equal(taskValidationRequiresSemanticReview(plan, [paths[2]], regexes), false, role);
        assert.equal(taskValidationRequiresSemanticReview(plan, ['src/engine.js'], regexes), false, role);
        assert.match(taskValidationSemanticReviewViolations(plan, [paths[1]], regexes, { code: true }).join(' '), /mandatory test review/u);
        assert.deepEqual(taskValidationSemanticReviewViolations(plan, [paths[1]], regexes, { test: true }), []);
        assert.equal(taskValidationSemanticReviewViolations(plan, [paths[1]], regexes, { test: true }, ['test']).length, 1);
    }
    const literal = buildTaskValidationPlan('own-runner tests/a.test.js', [inputs[0]]);
    assert.equal(taskValidationRequiresSemanticReview(literal, ['src/engine.js'], regexes), false);
    const symbolic = buildTaskValidationPlan('make check', [inputs[0]], { targets: [{ path: paths[0], entrypoint: 'check', reason: 'Runs task behavior.' }] });
    assert.equal(taskValidationRequiresSemanticReview(symbolic, ['src/engine.js'], regexes), true);
});

test('a 5000-target plan replays captured declarations with zero filesystem or subprocess observations', t => {
    const nativeFs = require('node:fs') as Record<string, unknown>;
    const nativeProcess = require('node:child_process') as Record<string, unknown>;
    const replaced: Array<{ module: Record<string, unknown>; name: string; value: unknown }> = [];
    let probes = 0;
    const targets = Array.from({ length: 5000 }, (_, index) => ({ path: `opaque/check-${index}.case`, sha256: 'a'.repeat(64) }));
    for (const [module, names] of [[nativeFs, ['readFileSync', 'existsSync', 'statSync', 'lstatSync', 'realpathSync']],
        [nativeProcess, ['spawnSync', 'execFileSync']]] as Array<[Record<string, unknown>, string[]]>) {
        for (const name of names) {
            replaced.push({ module, name, value: module[name] });
            module[name] = () => { probes++; throw new Error('Plan projection must use captured facts.'); };
        }
    }
    try {
        const started = performance.now();
        const plan = buildTaskValidationPlan('opaque-runner task-behavior', targets, { targets: targets.map(target => ({
            path: target.path, entrypoint: 'opaque-runner', reason: 'Runs this declared task behavior.' })) });
        assert.equal(plan.targets.length, targets.length);
        assert.equal(probes, 0);
        t.diagnostic(`5000 target declarations: ${(performance.now() - started).toFixed(1)} ms; filesystem/subprocess observations=${probes}`);
    } finally { for (const { module, name, value } of replaced) module[name] = value; }
});

test('process contract rejects partial execution, altered bindings, scope mutations and reversed chronology', () => {
    const plan = buildTaskValidationPlan('jvm-check Boundary && unfamiliar-check Purchase', sources);
    const evidence: TaskValidationProcessEvidence = { schema_version: 1, selection_sha256: validationDigest(plan),
        invocations: plan.descriptor.invocations.map((invocation, index) => ({ ...invocation, invocation: index,
            execution_id: `native-${index}`, cwd: '/workspace', started_at: `2026-11-06T10:00:0${index * 2}.000Z`,
            completed_at: `2026-11-06T10:00:0${index * 2 + 1}.000Z`, exit_code: 0, timed_out: false, cancelled: false,
            output_sha256: 'c'.repeat(64), scope_before: 'd'.repeat(64), scope_after: 'd'.repeat(64) })) };
    assert.deepEqual(taskValidationProcessViolations(plan, evidence), []);
    assert.match(taskValidationProcessViolations(plan, evidence, 'failure').join(' '), /expected RED/u);
    const red = structuredClone(evidence); red.invocations[0].exit_code = 1;
    assert.deepEqual(taskValidationProcessViolations(plan, red, 'failure'), []);
    const malformed = structuredClone(evidence) as unknown as { invocations: Array<{ argv?: unknown }> };
    delete malformed.invocations[0].argv;
    assert.match(taskValidationProcessViolations(plan, malformed).join(' '), /integrity/u);
    for (const mutate of [
        (value: TaskValidationProcessEvidence) => { value.invocations.pop(); },
        (value: TaskValidationProcessEvidence) => { value.selection_sha256 = 'e'.repeat(64); },
        (value: TaskValidationProcessEvidence) => { value.invocations[0].argv.push('other'); },
        (value: TaskValidationProcessEvidence) => { value.invocations[0].scope_after = 'e'.repeat(64); },
        (value: TaskValidationProcessEvidence) => { value.invocations[0].completed_at = '1970-01-01T00:00:00.000Z'; },
        (value: TaskValidationProcessEvidence) => { value.invocations[1].started_at = value.invocations[0].started_at; },
        (value: TaskValidationProcessEvidence) => { value.invocations[1].exit_code = 1; }
    ]) {
        const broken = structuredClone(evidence); mutate(broken);
        assert.match(taskValidationProcessViolations(plan, broken).join(' '), /process integrity/u);
    }
});

test('equivalent reselection retains the original execution chronology but rejects changed inputs and scope', () => {
    const retained = buildTaskValidationPlan('opaque-check Boundary', [sources[0]]);
    retained.binding = { task_id: 'T-1', workspace_root: '/workspace', task_mode_entry_sha256: 'a'.repeat(64),
        preflight_sha256: 'b'.repeat(64), scope_sha256: 'c'.repeat(64), scope_content_sha256: 'd'.repeat(64),
        selected_at: '2026-11-06T10:00:00.000Z' };
    const current = structuredClone(retained);
    current.binding!.selected_at = '2026-11-06T11:00:00.000Z';
    current.binding!.preflight_sha256 = 'e'.repeat(64);
    assert.equal(reusableTaskValidationPlan(current, retained), retained);
    const rebound = structuredClone(current);
    rebound.binding!.task_mode_entry_sha256 = 'f'.repeat(64);
    assert.equal(reusableTaskValidationPlan(rebound, retained), undefined);
    assert.equal(reusableTaskValidationPlan(rebound, retained, true), retained);
    rebound.binding!.scope_content_sha256 = 'f'.repeat(64);
    assert.equal(reusableTaskValidationPlan(rebound, retained, true), undefined);

    for (const mutate of [
        (value: typeof current) => { value.binding!.scope_content_sha256 = 'f'.repeat(64); },
        (value: typeof current) => { value.binding!.task_mode_entry_sha256 = 'f'.repeat(64); },
        (value: typeof current) => { value.binding!.workspace_root = '/other'; },
        (value: typeof current) => { value.targets[0].sha256 = 'f'.repeat(64); },
        (value: typeof current) => { value.descriptor.invocations[0].argv.push('other'); },
        (value: typeof current) => { value.inputs.push({ path: 'runner', sha256: 'f'.repeat(64) }); }
    ]) {
        const changed = structuredClone(current); mutate(changed);
        assert.equal(reusableTaskValidationPlan(changed, retained), undefined);
    }
});
