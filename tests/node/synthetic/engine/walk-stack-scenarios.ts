import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readRecordedOutOfScopeFailures } from '../../../../src/gates/full-suite/recorded-out-of-scope-failures';
import { recordedOutOfScopeFollowUpViolations } from '../../../../src/gates/full-suite/recorded-out-of-scope-follow-ups';
import type { WalkEdit, WalkScenario } from './navigator-walk';
import { stackDecomposition } from './walk-stack-parent';
import { STACK_MANIFESTS, STACK_FIXTURE_ROOT, readStackExecutions, stackExecutionViolations, stackFixture,
    STACK_COUNTER_STATE_IDS, stackInvocations, stackSelectedCases, type StackManifest, type StackMode, type StackTaskPlan, type StackSuite } from './walk-stack-fixtures';

interface Archetype { id: number; name: string; criteria: string; route: string }
export const STACK_ARCHETYPES = (JSON.parse(fs.readFileSync(path.join(STACK_FIXTURE_ROOT, 'tasks.json'), 'utf8')) as { archetypes: Archetype[] }).archetypes;
const BUNDLE = 'garda-agent-orchestrator';

/** Runnable-language patches differ by behavior as well as task title; toolchains remain simulated. */
function behaviorPatch(suite: StackSuite, archetype: number, test: boolean, repair = false, suffix = ''): string {
    const component = suite.id.replace(/[^a-z0-9]/giu, '');
    const behavior = archetype === 2 ? 'total' : 'standBehaviorA' + archetype + component;
    const name = test ? 'standCaseA' + archetype + component + suffix : behavior;
    const value = archetype === 2 || archetype === 5 && !test && !repair ? 0 : archetype * 10 + 2;
    switch (path.extname(test ? suite.target : suite.source)) {
        case '.java': return test ? `class ${name} { void taskBoundary() { assert new ${archetype === 2 ? path.basename(suite.source, '.java') : behavior}().${archetype === 2 ? 'total(0)' : 'evaluate()'} == ${value}; } }\n`
            : `class ${name} { int evaluate() { return ${value}; } }\n`;
        case '.kt': return test ? `fun ${name}() { check(${archetype === 2 ? path.basename(suite.source, '.kt') + '().total' : behavior}(0) == ${value}) }\n`
            : `fun ${name}(value: Int): Int = value + ${value}\n`;
        case '.cs': return test ? `internal static class ${name} { internal static void TaskBoundary() { System.Diagnostics.Debug.Assert(${archetype === 2 ? 'new Service().Total' : behavior + '.Evaluate'}(0) == ${value}); } }\n`
            : `internal static class ${name} { internal static int Evaluate(int value) => value + ${value}; }\n`;
        case '.go': return test ? `func Test${name}(t *testing.T) { if ${archetype === 2 ? 'Total' : behavior}(0) != ${value} { t.Fatal("task boundary") } }\n`
            : `func ${name}(value int) int { return value + ${value} }\n`;
        case '.rs': return test ? `#[test]\nfn ${name}() { assert_eq!(${suite.source.split('/')[0]}::${behavior}(0), ${value}); }\n`
            : `pub fn ${name}(value: i32) -> i32 { value + ${value} }\n`;
        case '.py': return test ? `from ${suite.source.replace(/\.py$/u, '').replaceAll('/', '.')} import ${behavior}\ndef test_${name}():\n    assert ${behavior}(0) == ${value}\n`
            : `def ${name}(value):\n    return value + ${value}\n`;
        case '.php': return test ? `function ${name}() { assert(${archetype === 2 ? '(new ' + path.basename(suite.source, '.php') + '())->total' : behavior}(0) === ${value}); }\n`
            : `function ${name}($value = 0) { return $value + ${value}; }\n`;
        case '.ts': case '.tsx': {
            const relative = path.posix.relative(path.posix.dirname(suite.target), suite.source);
            return test ? `import { ${behavior} } from "${relative.startsWith('.') ? relative : './' + relative}";\nexport function ${name}() { if (${behavior}(0) !== ${value}) throw new Error("task boundary"); }\n`
                : `export function ${name}(value = 0) { return value + ${value}; }\n`;
        }
        case '.rb': return test ? `RSpec.describe "${name}" do\n  it("guards task boundary") { expect(${behavior}(0)).to eq(${value}) }\nend\n`
            : `def ${name}(value)\n  value + ${value}\nend\n`;
        case '.ex': case '.exs': return test ? `defmodule StandA${archetype}${component}Test do\n  use ExUnit.Case\n  test "task boundary" do\n    assert StandA${archetype}${component}.evaluate(0) == ${value}\n  end\nend\n`
            : `defmodule StandA${archetype}${component}${repair ? 'Repair' : ''} do\n  def evaluate(value), do: value + ${value}\nend\n`;
        case '.swift': return test ? `func ${name}() { XCTAssertEqual(${behavior}(0), ${value}) }\n`
            : `public func ${name}(_ value: Int) -> Int { value + ${value} }\n`;
        case '.cpp': return test ? `int ${behavior}(int);\nvoid ${name}() { assert(${behavior}(0) == ${value}); }\n`
            : `int ${name}(int value) { return value + ${value}; }\n`;
        default: return test ? `case ${name}\n  given partner-1\n  expect ${behavior}(0) equals ${value}\n`
            : `fn ${name}(value) yields value + ${value}\n`;
    }
}

export function stackTestEdit(suite: StackSuite, archetype: number, suffix = ''): WalkEdit {
    return { path: suite.target, append: suite.comment + ' STAND_CASE_A' + archetype + suffix + ': '
        + STACK_ARCHETYPES.find(task => task.id === archetype)!.criteria + '\n' + behaviorPatch(suite, archetype, true, false, suffix ? 'Focused' : '') };
}
export function stackSourceEdit(suite: StackSuite, archetype: number, repair = false): WalkEdit {
    return { path: suite.source, append: suite.comment + ' STAND_' + (repair ? 'REPAIRED' : 'IMPLEMENT') + '_A' + archetype
        + ': ' + STACK_ARCHETYPES.find(task => task.id === archetype)!.criteria + '\n' + (repair ? '' : behaviorPatch(suite, archetype, false)),
        ...(repair ? { replace: { before: behaviorPatch(suite, archetype, false), after: behaviorPatch(suite, archetype, false, true) } } : {}) };
}
export function applyStackEdits(root: string, edits: WalkEdit[]): void {
    for (const edit of edits) {
        const file = path.join(root, edit.path);
        if (edit.replace) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(edit.replace.before, edit.replace.after));
        fs.appendFileSync(file, edit.append);
    }
}

export function stackScenario(manifest: StackManifest, archetype: number, mode: StackMode, gateTour = false): WalkScenario {
    const task = STACK_ARCHETYPES.find(task => task.id === archetype)!;
    const invocations = stackInvocations(manifest, gateTour ? 8 : archetype);
    const targets = invocations.flatMap(run => run.targets);
    const suites = manifest.suites.filter(suite => targets.includes(suite.target));
    const fixture = stackFixture(manifest, mode, invocations);
    const plan: StackTaskPlan = { archetype, mode, invocations };
    let narrow = false, repaired = false, implementedAfterRed = false;
    const sourceEdits = suites.map(suite => stackSourceEdit(suite, archetype));
    const testEdits = suites.map(suite => stackTestEdit(suite, archetype));
    const ordinaryModes = archetype === 4 ? [] : archetype === 2 ? ['test:FULL'] : archetype === 8 || gateTour
        ? ['code:FULL', 'security:FULL', 'refactor:FULL', 'test:FULL'] : ['code:FULL', 'test:FULL'];
    const ordinary: WalkScenario = {
        id: `stack-${manifest.id}-a${archetype}-${mode}`, fixture, taskTitle: task.criteria,
        ...([1, 6].includes(archetype) && STACK_COUNTER_STATE_IDS.has('stack-fixture-' + manifest.id + '-a1-a6')
            ? { counterState: 'stack-fixture-' + manifest.id + '-a1-a6' } : {}),
        taskNotes: `Acceptance: ${task.criteria}${archetype === 7 ? ' Test-first: expected-red.' : ''}`,
        edits: archetype === 4 ? [{ path: 'docs/guide.md', append: 'Partner identity is checked before order totals are exposed.\n' }]
            : archetype === 2 || archetype === 7 ? testEdits : [...sourceEdits, ...testEdits],
        profile: archetype === 4 ? 'docs-only' : 'balanced',
        ...(archetype === 8 || gateTour ? { requiredLanes: ['security', 'refactor'] } : {}),
        get selectionTargets() { return targets; },
        get testSelectionCommand() {
            // A6 deliberately models a mistaken/legacy first selection. It is the only broad test attempt.
            return archetype === 6 && !narrow ? fixture.projectTestCommand : invocations.map(run => run.command).join(' && ');
        },
        fullSuitePlacement: 'after_compile_before_reviews',
        expectedGates: archetype === 4 ? [] : ['task-test-selection', 'full-suite-validation',
            ...(archetype === 6 ? ['materialize-review-follow-up-tasks'] : []),
            ...(archetype === 7 ? ['test-first-expected-failure'] : [])],
        expectedReviews: Object.fromEntries(ordinaryModes.map(value => [value.split(':')[0], 1])), expectedModes: ordinaryModes,
        ...([5, 6].includes(archetype) ? { expectedFailingGates: ['full-suite-validation'] } : {}),
        ...(archetype === 6 ? { expectedDoneGuidance: /completed with recorded out-of-scope failures/iu } : {}),
        configure: root => {
            narrow = false; repaired = false; implementedAfterRed = false;
            fs.writeFileSync(path.join(root, '.git/stand-task.json'), JSON.stringify({ ...plan, repoRoot: root }));
        },
        prepare: async (_root, steps) => {
            if (archetype === 6 && steps.at(-1)?.gate === 'full-suite-validation' && steps.at(-1)?.exitCode) narrow = true;
        },
        act: async (root, gate, steps, run) => {
            if (archetype === 5 && gate === 'implementation' && !repaired
                && readStackExecutions(root).some(record => record.purpose === 'own' && record.exitCode !== 0)) {
                applyStackEdits(root, suites.map(suite => stackSourceEdit(suite, 5, true))); repaired = true; return true;
            }
            if (archetype === 7 && gate === 'test-first-expected-failure') {
                for (const invocation of invocations) await run(['run-intermediate-command', '--task-id', 'T-WALK',
                    '--command-source', 'targeted-test', '--command', invocation.command, '--expect-failure',
                    ...stackSelectedCases(invocation).flatMap(claim => ['--selected-case', JSON.stringify(claim)]),
                    '--preflight-path', BUNDLE + '/runtime/reviews/T-WALK-preflight.json', '--repo-root', '.']);
                return true;
            }
            if (archetype === 7 && gate === 'implementation' && !implementedAfterRed
                && steps.some(step => step.gate === 'test-first-expected-failure')) {
                assert.ok(readStackExecutions(root).some(record => record.exitCode !== 0 && record.purpose === 'own'));
                applyStackEdits(root, sourceEdits); implementedAfterRed = true; return true;
            }
            return false;
        },
        execute: async (root, step) => {
            if (archetype !== 5 || repaired || step.gate !== 'implementation'
                || !readStackExecutions(root).some(record => record.purpose === 'own' && record.exitCode !== 0)) return false;
            applyStackEdits(root, suites.map(suite => stackSourceEdit(suite, 5, true))); repaired = true;
            step.exitCode = 0; step.output = 'Agent repaired only the task implementation; native selection and execution must be refreshed.';
            return true;
        },
        inspectResult: (root, result) => {
            if (result.outcome !== 'done') return;
            const executions = readStackExecutions(root);
            assert.deepEqual(stackExecutionViolations(root, plan, executions), [], 'Task source/target execution oracle');
            if (archetype === 4) assert.equal(executions.length, 0, 'Docs-only has no compile or test subprocess');
            else {
                assert.ok(executions.some(record => record.purpose === 'compile'), 'Compile applicability must be real');
                assert.equal(executions.filter(record => record.purpose === 'broad').length, archetype === 6 ? 1 : 0, 'Only A6 has one deliberate broad attempt');
            }
            if (archetype === 5 || archetype === 7) {
                for (const invocation of invocations) {
                    const own = executions.filter(record => record.purpose === 'own' && record.technology === invocation.technology);
                    assert.ok(own.findIndex(record => record.exitCode !== 0) >= 0);
                    assert.ok(own.findIndex(record => record.exitCode === 0) > own.findIndex(record => record.exitCode !== 0), 'FAILED/RED precedes GREEN');
                    if (archetype === 7) assert.notEqual(own[0].checks[0].sourceSha256, own.at(-1)!.checks[0].sourceSha256, 'RED is bound to pre-implementation source');
                }
            }
            if (archetype === 6) {
                const retained = readRecordedOutOfScopeFailures(root, 'T-WALK');
                assert.equal(retained.length, 1); assert.equal(retained[0].command, fixture.projectTestCommand);
                assert.deepEqual(recordedOutOfScopeFollowUpViolations(root, 'T-WALK'), []);
                assert.match(fs.readFileSync(path.join(root, 'TASK.md'), 'utf8'), /Resolve recorded out-of-scope test failures/u);
            }
        }
    };
    return archetype === 9 ? stackDecomposition(manifest, mode, ordinary, plan) : ordinary;
}

export const STACK_WALK_SCENARIOS: readonly WalkScenario[] = STACK_MANIFESTS.flatMap(manifest =>
    (manifest.adapter ? ['generic', 'auto'] as const : ['generic'] as const).flatMap(mode =>
        STACK_ARCHETYPES.map(task => stackScenario(manifest, task.id, mode))));

/** Adapter parity compares complete routes and semantic outcomes; absence of either result is incomplete coverage. */
export function stackAdapterRegressions(results: readonly { scenarioId: string; outcome: string; reviews: Array<{ lane: string; mode: string }> }[]): string[] {
    return results.filter(result => /-auto(?:-|$)/u.test(result.scenarioId)).flatMap(adapter => {
        const generic = results.find(result => result.scenarioId === adapter.scenarioId.replace(/-auto(?=-|$)/u, '-generic'));
        if (!generic) return ['missing-generic-peer:' + adapter.scenarioId];
        return generic.outcome === 'done' && (adapter.outcome !== 'done'
            || JSON.stringify(adapter.reviews.map(review => review.lane + ':' + review.mode)) !== JSON.stringify(generic.reviews.map(review => review.lane + ':' + review.mode)))
            ? ['adapter-weaker:' + adapter.scenarioId] : [];
    });
}

// Explicit small sample; full/sweep include every ordinary stack/task/mode row.
export const STACK_SAMPLE_IDS = ['stack-unknown-quartz-a1-generic', 'stack-polyglot-maven-ts-a3-generic'];

/** Economy controls on representative opaque/JVM/polyglot shapes. */
export const STACK_REVIEW_VARIANTS: readonly WalkScenario[] = STACK_MANIFESTS.filter(manifest =>
    ['unknown-quartz', 'spring-maven', 'polyglot-maven-ts'].includes(manifest.id)).flatMap(manifest =>
    (manifest.adapter ? ['generic', 'auto'] as const : ['generic'] as const).flatMap(mode => {
        const base = stackScenario(manifest, 8, mode);
        const initial = ['code:FULL', 'security:FULL', 'refactor:FULL', 'test:FULL'];
        const suite = manifest.suites[0];
        return [
            { ...base, id: base.id + '-test-fix', failures: { test: 1 },
                fix: [stackTestEdit(suite, 8, ' focused foreign-partner case')],
                expectedReviews: { code: 1, security: 1, refactor: 1, test: 2 }, expectedModes: [...initial, 'test:DELTA'] },
            { ...base, id: base.id + '-protected-fix', failures: { test: 1 },
                edits: [...base.edits, { path: 'security/partner-guard' + path.extname(suite.source), append: suite.comment + ' Partner authorization boundary\n' }],
                fix: [{ path: 'security/partner-guard' + path.extname(suite.source), append: suite.comment + ' Reject replaced partner authority\n' }],
                expectedReviews: { code: 2, security: 2, refactor: 2, test: 2 },
                expectedModes: [...initial, 'code:DELTA', 'security:FULL', 'refactor:DELTA', 'test:DELTA'] },
            { ...base, id: base.id + '-scope-expansion', failures: { test: 1 },
                fix: [{ path: 'components/new-partner/guard' + path.extname(suite.source), append: suite.comment + ' New partner guard source\n' }],
                expectedReviews: { code: 2, security: 2, refactor: 2, test: 2 }, expectedModes: [...initial, ...initial] }
        ];
    }));

for (const scenario of STACK_REVIEW_VARIANTS.filter(scenario => scenario.id.endsWith('-test-fix'))) {
    const configure = scenario.configure, prepare = scenario.prepare;
    let focused = false;
    scenario.configure = root => { focused = false; configure?.(root); };
    scenario.prepare = async (root, steps, run) => {
        await prepare?.(root, steps, run);
        if (focused || steps.at(-1)?.gate !== 'load-rule-pack' || !steps.at(-1)?.command?.includes('POST_PREFLIGHT')
            || !steps.some(step => step.gate === 'record-review-result' && /--review-type\s+"test"/u.test(step.command ?? ''))
            || !fs.readFileSync(path.join(root, scenario.fixture!.primaryTest), 'utf8').includes('focused foreign-partner case')) return;
        const plan = JSON.parse(fs.readFileSync(path.join(root, '.git/stand-task.json'), 'utf8')) as StackTaskPlan;
        for (const invocation of plan.invocations) await run(['run-intermediate-command', '--task-id', 'T-WALK',
            '--command-source', 'targeted-test', '--command', invocation.command,
            ...stackSelectedCases(invocation).flatMap(claim => ['--selected-case', JSON.stringify(claim)]),
            '--preflight-path', BUNDLE + '/runtime/reviews/T-WALK-preflight.json', '--repo-root', '.']);
        focused = true;
    };
}
