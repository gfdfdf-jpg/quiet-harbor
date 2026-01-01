import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GATE_COMMANDS } from '../../../src/compat/shim-registry';
import { WALK_SCENARIOS } from './engine/walk-scenarios';
import { inspectStandProperties, propertyTrace, readStandProperties, declaredTests, type TraceInventory } from './engine/stand-properties';
import { standCheckPlan } from './engine/stand-check-plan';
import { buildStandSummary, renderStandSummary } from './engine/stand-summary';

const root = path.resolve('.');
const manifest = readStandProperties(root);
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const inventory: TraceInventory = { root, level: 'short', scenarioIds: WALK_SCENARIOS.map(item => item.id) };

test('every concept rule and registry gate has live checks at every requested stand level', () => {
    for (const level of ['short', 'full', 'sweep'] as const)
        assert.deepEqual(inspectStandProperties(manifest, { ...inventory, level }), [], level);
});
test('traceability rejects missing checks, new gates and unmapped concept rules', () => {
    const missing = structuredClone(manifest); missing.properties[0].checks = [];
    assert.ok(inspectStandProperties(missing, inventory).some(problem => problem.includes('Property has no check')));
    assert.ok(inspectStandProperties(manifest, { ...inventory, gates: [...GATE_COMMANDS, 'new-validation-gate'] })
        .includes('Unmapped registry gate: new-validation-gate'));
    assert.ok(inspectStandProperties(manifest, { ...inventory, conceptText: read(manifest.concept_source) + '\n- [C7.NEW] A new binding rule.\n' })
        .includes('Unmapped concept rule: C7.NEW'));
    assert.ok(inspectStandProperties(manifest, { ...inventory, level: 'full', scenarioIds: [...inventory.scenarioIds, 'field-new-regression'] })
        .includes('Unmapped scenario family member: field-new-regression'));
});
test('traceability detects a dropped schedule, filtered case, skipped registration and disconnected oracle', () => {
    const schedule = standCheckPlan('short', read('tests/node/policy/stack-universal-gates-contract.test.ts'));
    assert.ok(inspectStandProperties(manifest, { ...inventory, schedule: schedule.filter(item => item.id !== 'fixture-contract') })
        .some(problem => problem.includes('no longer scheduled')));
    const filtered = schedule.map(item => item.id === 'fixture-contract' ? { ...item, pattern: '^nothing$' } : item);
    assert.ok(inspectStandProperties(manifest, { ...inventory, schedule: filtered }).some(problem => problem.includes('filtered out')));
    assert.ok(inspectStandProperties(manifest, { ...inventory, read: file => file.endsWith('synthetic-stack-fixtures.test.ts')
        ? read(file).replaceAll("test('", "test.skip('") : read(file) }).some(problem => problem.includes('missing/skipped')));
    assert.ok(inspectStandProperties(manifest, { ...inventory, read: file => file.endsWith('synthetic-navigator-walk.test.ts')
        ? read(file).replaceAll('compareWalk(', 'disconnected(') : read(file) }).some(problem => problem.includes('Oracle no longer called')));
});
test('traceability detects a removed short scenario and an unregistered contract case', () => {
    assert.ok(inspectStandProperties(manifest, { ...inventory, scenarioIds: inventory.scenarioIds.filter(id => id !== 'stack-polyglot-maven-ts-a3-generic') })
        .some(problem => problem.includes('Scenario no longer runs')));
    assert.ok(inspectStandProperties(manifest, { ...inventory, read: file => file.endsWith('stack-universal-gates-contract.test.ts')
        ? read(file) + '\ntest("new contract case", () => {});\n' : read(file) }).some(problem => problem.includes('Unmapped/inactive contract')));
    assert.ok(inspectStandProperties(manifest, { ...inventory, read: file => file.endsWith('stack-universal-gates-contract.test.ts')
        ? read(file).replace("'hash', 'execution-binding', 'chronology'", "'hash', 'execution-binding'") : read(file) })
        .some(problem => problem.includes('Generated case no longer registered')));
    assert.deepEqual(declaredTests("// test('comment', () => {});\ntest.skip('disabled', () => {});\ntest('active', () => {});"),
        [{ name: 'disabled', template: false, active: false }, { name: 'active', template: false, active: true }]);
});
test('summary retains traceability failures, actual execution evidence and honest external limits', () => {
    const rows = propertyTrace(manifest, { level: 'short', final: true, partial: false, checks: [], timingRequested: false });
    assert.ok(rows.some(row => row.status === 'FAIL'));
    const summary = buildStandSummary({ level: 'short', final: true, partial: false, checks: [], baselineProblems: [],
        timingRequested: false, traceability: rows, traceProblems: ['Unmapped registry gate: injected'], limits: manifest.limits });
    assert.equal(summary.verdict, 'FAIL');
    const markdown = renderStandSummary(summary);
    for (const expected of ['Property traceability', 'injected', 'three OS', 'T-406/T-408', 'real-project acceptance']) assert.ok(markdown.includes(expected), expected);
    const checks = manifest.checks.filter(check => check.tests?.length && check.levels.includes('short'));
    const observed = propertyTrace(manifest, { level: 'short', final: true, partial: false, timingRequested: false,
        checks: checks.map(check => ({ id: check.run, status: 'PASS', log: 'fake.log', executed_tests: ['different test'] })) });
    assert.ok(observed.some(row => row.checks.some(check => check.detail.startsWith('Test did not execute'))));
    const unobserved = propertyTrace(manifest, { level: 'short', final: true, partial: false, timingRequested: false,
        checks: [{ id: 'walk', status: 'PASS', log: 'walk.log' }] });
    assert.ok(unobserved.some(row => row.checks.some(check => check.detail.startsWith('Oracle did not execute'))));
    const levelScoped = propertyTrace({ ...manifest, checks: [
        { id: 'short-proof', kind: 'suite', run: 'short-proof', levels: ['short'] },
        { id: 'full-proof', kind: 'suite', run: 'full-proof', levels: ['full', 'sweep'] }
    ], properties: [{ id: 'scoped', statement: 'The check for the requested level ran.', concept: [], gates: [], checks: ['short-proof', 'full-proof'] }] },
    { level: 'short', final: true, partial: false, timingRequested: false, checks: [{ id: 'short-proof', status: 'PASS', log: 'short.log' }] });
    assert.equal(levelScoped[0].status, 'PASS', 'A proof assigned only to another level is not a missing requested check');
});
