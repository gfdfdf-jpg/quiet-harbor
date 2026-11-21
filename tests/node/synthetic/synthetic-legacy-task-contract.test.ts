import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { legacyRepairFixture, legacySourceRoute } from './engine/walk-legacy-task-contract';
import { buildTaskValidationPlan } from '../../../src/core/task-validation-plan';
import { WALK_SCENARIOS } from './engine/walk-scenarios';
import { readRouteInventory } from './engine/walk-routes';
import { ROUTE_CLOSURE_WALK_SCENARIOS } from './engine/walk-route-closure-scenarios';
import { OWNER_COVERAGE_WALK_SCENARIOS } from './engine/walk-owner-coverage-scenarios';

test('legacy recovery routes stay unique after source lines move and reject missing or ambiguous decisions', () => {
    const file = 'src/gates/next-step/next-step.ts';
    const source = fs.readFileSync(path.resolve(file), 'utf8');
    const signature = 'Restart the coherent cycle: the review stage already passed.';
    const original = legacySourceRoute(file, signature, source);
    const shifted = legacySourceRoute(file, signature, '\n\n' + source);
    const coordinates = (id: string) => id.slice(file.length + 1).split(':').map(Number);
    assert.deepEqual(coordinates(shifted), [coordinates(original)[0] + 2, coordinates(original)[1]]);
    assert.throws(() => legacySourceRoute(file, 'removed decision', source), /found 0/u);
    assert.throws(() => legacySourceRoute(file, signature, source + '\n' + source), /found 2/u);
});

test('legacy source expectations name actual current navigator decisions', () => {
    const inventory = new Set(readRouteInventory(path.resolve('.')).points.map(point => point.id));
    const scenarios = [...ROUTE_CLOSURE_WALK_SCENARIOS, ...OWNER_COVERAGE_WALK_SCENARIOS].filter(scenario => scenario.expectedRoutes?.length);
    assert.ok(scenarios.length >= 12);
    for (const scenario of scenarios) for (const route of scenario.expectedRoutes!) {
        assert.ok(inventory.has(route), scenario.id + ': absent route ' + route);
    }
});

test('repair child cases execute under the same shared contract as their selected task targets', () => {
    for (const [source, target, caseId] of [
        ['src/module-boundary.cjs', 'tests/module-boundary.test.cjs', 'module boundary repair'],
        ['scripts/full-suite-check.cjs', 'tests/timeout-repair.test.cjs', 'timeout repair terminates']
    ]) {
        const fixture = legacyRepairFixture(source, target, caseId);
        const plan = buildTaskValidationPlan(fixture.taskTestCommand, [{ path: target, sha256: 'a'.repeat(64) }]);
        assert.equal(plan.requires_semantic_review, false);
        assert.deepEqual(fixture.cases.map(item => item.source), plan.targets.map(item => item.path));
        assert.ok(plan.descriptor.invocations[0].argv.includes('--test-name-pattern=' + fixture.cases[0].selector));
    }
});

test('RED and native owner fixtures select their actual executable task targets', () => {
    for (const id of ['coverage-test-first-current-green', 'coverage-test-first-red-stale']) {
        const scenario = WALK_SCENARIOS.find(entry => entry.id === id)!;
        assert.deepEqual(scenario.selectionTargets, ['tests/status.test.cjs']);
        assert.ok(scenario.fixture!.caseCommand.includes('tests/status.test.cjs'));
        assert.deepEqual(scenario.fixture!.cases.map(item => item.source), scenario.selectionTargets);
        assert.ok(scenario.execute, 'Executable RED must retain its scenario case binding.');
        assert.ok(scenario.expectedBlockedGate, 'The declared RED/GREEN handoff must remain a handoff.');
    }
    for (const id of ['coverage-full-suite-owner-in-flight', 'coverage-full-suite-owner-crashed']) {
        const scenario = WALK_SCENARIOS.find(entry => entry.id === id)!;
        assert.match(scenario.testSelectionCommand!, /\.git\/walk-owner\/block\.cjs --test tests\/app\.test\.ts/u);
        assert.deepEqual(scenario.selectionTargets, ['tests/app.test.ts']);
    }
    const conflict = WALK_SCENARIOS.find(entry => entry.id === 'coverage-docs-only-validation-conflict')!;
    assert.equal(conflict.expectedBlockedGate, 'project-validation-evidence');
    assert.ok(conflict.selectionTargets!.every(target => conflict.edits.some(edit => edit.path === target)),
        'The docs-only handoff must concern the task\'s own changed recipe test.');
});
