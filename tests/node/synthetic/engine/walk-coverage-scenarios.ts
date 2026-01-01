import * as fs from 'node:fs';
import * as path from 'node:path';
import { serializeTaskPlan, validateTaskPlan } from '../../../../src/schemas/task-plan';
import { runGit } from '../../cli/commands/gate-test-helpers';
import type { WalkScenario } from './navigator-walk';

const TASK = 'T-WALK';
const BUNDLE = 'garda-agent-orchestrator';
const EDITS = [{ path: 'src/app.ts', append: '// coverage family\n' }, { path: 'tests/app.test.ts', append: '// coverage family\n' }];

function write(root: string, relative: string, text: string): void {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

function queue(root: string, transform: (text: string) => string): void {
    const file = path.join(root, 'TASK.md');
    fs.writeFileSync(file, transform(fs.readFileSync(file, 'utf8')));
}

function plan(root: string): void {
    write(root, BUNDLE + '/runtime/reviews/' + TASK + '-task-plan.json', serializeTaskPlan(validateTaskPlan({
        schema_version: 1, task_id: TASK, status: 'approved', goal: 'Preserve the focused status behavior',
        scope_files: EDITS.map(edit => edit.path), risk_level: 'low',
        steps: [{ id: 'one', title: 'Implement and verify the focused status behavior' }],
        acceptance_criteria: ['The status behavior remains covered'],
        verification_expectations: ['Focused status tests'], out_of_scope: ['Other behavior']
    })));
}

function handoff(id: string, gate: string | null, guidance: RegExp, options: Partial<WalkScenario> = {}): WalkScenario {
    return { id: 'coverage-' + id, edits: EDITS, expectedReviews: {}, expectedModes: [],
        expectedBlockedGate: gate, expectedGuidance: guidance, ...options };
}

function configureSuiteTimeout(root: string): void {
    const file = path.join(root, BUNDLE, 'live/config/workflow-config.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    Object.assign(config.full_suite_validation, { timeout_ms: 1000, timeout_retry_count: 0 });
    fs.writeFileSync(file, JSON.stringify(config));
    write(root, 'scripts/full-suite-check.cjs', 'setTimeout(() => {}, 60000);\n');
    runGit(root, ['add', 'scripts/full-suite-check.cjs']);
    runGit(root, ['commit', '-qm', 'Seed timeout command in disposable stand fixture']);
}

/** Operator declarations and real gate admissions, grouped by route family. No lifecycle artifacts are seeded. */
export const COVERAGE_WALK_SCENARIOS: readonly WalkScenario[] = [
    handoff('source-runtime', 'source-runtime-remediation', /forced rebuild command/iu, {
        disturbanceReason: 'A source checkout has generated JavaScript older than its TypeScript source.',
        prepare: async (root, steps) => {
            if (steps.at(-1)?.gate !== 'shell-smoke-preflight') return;
            write(root, 'bin/garda.js', '#!/usr/bin/env node\n');
            write(root, 'src/index.ts', 'export {};\n');
            write(root, 'dist/src/index.js', 'module.exports = {};\n');
            write(root, 'dist/src/app.js', 'exports.value = 1;\n');
            const stale = new Date(fs.statSync(path.join(root, 'src/app.ts')).mtimeMs - 5000);
            fs.utimesSync(path.join(root, 'dist/src/app.js'), stale, stale);
        }
    }),
    handoff('operator-maintenance', 'operator-maintenance', /Garda|protected/iu, {
        disturbanceReason: 'Change a protected installed rule after task-mode entry under deny_agent_entry.',
        expectedFailingGates: ['classify-change'],
        prepare: async (root, steps) => {
            if (steps.at(-1)?.gate === 'enter-task-mode' && steps.at(-1)?.exitCode === 0) {
                fs.appendFileSync(path.join(root, BUNDLE, 'live/docs/agent-rules/00-core.md'), '\nUnauthorized rule change.\n');
            }
        }
    }),
    handoff('protected-manifest-recovery', 'recover-task-mode-protected-manifest', /Explicit operator confirmation/iu, {
        disturbanceReason: 'Delete the protected manifest before real task-mode entry.',
        expectedFailingGates: ['enter-task-mode'],
        setup: root => fs.unlinkSync(path.join(root, BUNDLE, 'runtime/protected-control-plane-manifest.json'))
    }),
    handoff('no-op', 'record-no-op', /no-op/iu, {
        edits: [], setup: root => queue(root, text => text.replace('Change the status renderer', 'Audit-only: inspect status behavior'))
    }),
    handoff('review-follow-ups', 'materialize-review-follow-up-tasks', /follow-up/iu, {
        failures: { code: 1 }, findingSeverity: 'low',
        expectedReviews: { code: 1, test: 1 }, expectedModes: ['code:FULL', 'test:FULL'],
        expectedBlockedGate: undefined, expectedGates: ['materialize-review-follow-up-tasks']
    }),
    handoff('post-review-source-mutation', 'post-review-source-mutation-guard', /Restore the workspace|follow-up task/iu, {
        failures: { code: 1 }, findingSeverity: 'low', expectedReviews: { code: 1 }, expectedModes: ['code:FULL'],
        disturbanceReason: 'Change source after accepted deferred review findings without an implementation transition.',
        prepare: async (root, steps) => {
            const last = steps.at(-1);
            if (last?.gate === 'record-review-result' && last.exitCode === 0) fs.appendFileSync(path.join(root, 'src/app.ts'), '// unauthorized deferred fix\n');
        }
    }),
    ...[
        // Current JSON findings keep their configured fix_now disposition. Legacy Markdown prose classifiers
        // cannot turn an authenticated HIGH finding into evidence-only or launch-only recovery.
        { id: 'json-evidence-finding', description: 'Missing attached manual-validation evidence; evidence-only failure.' },
        { id: 'json-launch-finding', description: 'Reviewer launch package failure: launch_binding_sha256 does not match.' }
    ].map((entry): WalkScenario => ({ id: 'coverage-' + entry.id, edits: EDITS,
        ...(entry.id === 'json-evidence-finding' ? { counterState: 'failed-review-path-candidate' } : {}),
        failures: { code: 1 }, findingDescription: entry.description, fix: [{ path: 'src/app.ts', append: '// fixed\n' }],
        expectedReviews: { code: 2, test: 1 }, expectedModes: ['code:FULL', 'code:DELTA', 'test:FULL'] })),
    ...([false, true] as const).map(installed => handoff('optional-skill-' + (installed ? 'activation' : 'remediation'),
        installed ? 'activate-optional-skill' : 'optional-skill-remediation', installed ? /Activate|activation/iu : /skill|pack/iu, {
            ...(installed ? { counterState: 'optional-skill-activation' } : {}),
            configure: root => {
                write(root, BUNDLE + '/live/config/optional-skill-selection-policy.json', JSON.stringify({ version: 1, mode: 'mandatory' }));
                if (installed) fs.cpSync(path.join(root, BUNDLE, 'template/skill-packs/node-backend/skills/node-backend'),
                    path.join(root, BUNDLE, 'live/skills/node-backend'), { recursive: true });
            },
            setup: root => queue(root, text => text.replace('Change the status renderer', 'Implement Node.js backend endpoint middleware request validation')
                .replace('Synthetic navigator walk.', 'Node backend route handler and controller request validation.')),
            ...(installed ? { expectedBlockedGate: undefined, expectedGates: ['activate-optional-skill'],
                expectedReviews: { code: 1, api: 1, test: 1 }, expectedModes: ['code:FULL', 'api:FULL', 'test:FULL'] } : {})
        })),
    handoff('full-suite-timeout', 'full-suite-timeout-repair-task', /one meaningful linked (?:repair|child) task/iu, {
        expectedFailingGates: ['full-suite-validation'],
        configure: configureSuiteTimeout
    }),
    ...(['singular', 'unmaterialized', 'changed-scope'] as const).map(kind => handoff('repair-child-' + kind,
        kind === 'changed-scope' ? 'full-suite-repair-child-scope' : 'full-suite-repair-child-handoff',
        kind === 'changed-scope' ? /scope declarations changed/iu : /parent materializes the validated handoff/iu, {
            configure: configureSuiteTimeout, expectedFailingGates: ['full-suite-validation'],
            disturbanceReason: 'Inspect an unadmitted timeout repair child: ' + kind,
            inspectTask: steps => steps.some(step => step.gate === 'full-suite-validation' && step.exitCode !== 0) ? TASK + '-F1' : TASK,
            prepare: async (root, steps, run) => {
                if (steps.at(-1)?.gate !== 'full-suite-validation' || steps.at(-1)?.exitCode === 0) return;
                const children = kind === 'singular' ? [1] : [1, 2];
                queue(root, text => text.replace('Synthetic navigator walk.',
                    'Decomposition source: orchestrator (2026-11-01); child tasks: ' + children.map(id => '`' + TASK + '-F' + id + '`').join(', ') + '.')
                    + children.map(id => `| ${TASK}-F${id} | TODO | P1 | workflow/timeout-${id} | ${id === 1 ? 'Diagnose' : 'Repair'} full suite timeout | synthetic | 2026-11-01 | strict | Child of \`${TASK}\`. Repair scope paths: \`src/repair-child-${id}.ts\`; |\n`).join(''));
                if (kind === 'changed-scope') {
                    await run(['materialize-full-suite-repair-task', '--task-id', TASK,
                        '--preflight-path', BUNDLE + '/runtime/reviews/' + TASK + '-preflight.json',
                        '--full-suite-artifact-path', BUNDLE + '/runtime/reviews/' + TASK + '-full-suite-validation.json', '--repo-root', '.']);
                    queue(root, text => text.replace('src/repair-child-1.ts', 'src/unapproved.ts'));
                }
            }
        })),
    handoff('planned-scope', 'materialize-planned-scope', /Implement or create the planned files/iu, {
        setup: plan, expectedBlockedGate: undefined, expectedGates: ['materialize-planned-scope'],
        expectedReviews: { code: 1, test: 1 }, expectedModes: ['code:FULL', 'test:FULL']
    }),
    handoff('false-done', 'task-reset', /task-reset\/reopen/iu, {
        disturbanceReason: 'Replace IN_PROGRESS with unauthenticated DONE after real task-mode entry.',
        prepare: async (root, steps) => {
            if (steps.at(-1)?.gate === 'enter-task-mode' && steps.at(-1)?.exitCode === 0) {
                queue(root, text => text.replace(/🟨 IN_PROGRESS|IN_PROGRESS/u, 'DONE'));
            }
        }
    }),
    ...(['missing', 'corrupt'] as const).map(mode => handoff('plan-' + mode, 'task-plan-integrity', /Restore its original approved bytes/iu, {
        setup: plan, disturbanceReason: mode + ' frozen approved task plan after real task-mode entry',
        prepare: async (root, steps) => {
            if (steps.at(-1)?.gate !== 'enter-task-mode' || steps.at(-1)?.exitCode !== 0) return;
            const file = path.join(root, BUNDLE, 'runtime/reviews/' + TASK + '-task-plan.json');
            if (mode === 'missing') fs.unlinkSync(file);
            else fs.writeFileSync(file, '{broken');
        }
    })),
    handoff('decomposed-child', 'child-task', /next unfinished child/iu, {
        expectedTerminalStatus: 'DECOMPOSED',
        setup: root => queue(root, text => text.replace('🟦 TODO', 'DECOMPOSED')
            .replace('Synthetic navigator walk.', 'Decomposition source: orchestrator (2026-11-01); child tasks: `T-WALK-1`, `T-WALK-2`.')
            + [1, 2].map(id => `| T-WALK-${id} | TODO | P1 | app | Implement status part ${id} | synthetic | 2026-11-01 | balanced | Child of \`T-WALK\`. |\n`).join(''))
    }),
    ...([false, true] as const).map(corrupt => handoff(corrupt ? 'decomposed-corrupt-decision' : 'decomposed-missing-contract', null,
        corrupt ? /Cannot read.*strict-decomposition-decision.*Restore its original authenticated bytes/iu : /restore its native split evidence/iu, {
        ...(corrupt ? { disturbanceReason: 'Corrupt the retained parent strict-decomposition decision before native navigation.' } : {}),
        setup: root => {
            queue(root, text => text.replace('🟦 TODO', 'DECOMPOSED')
            .replace('Synthetic navigator walk.', 'Decomposition source: orchestrator (2026-11-01); child tasks: `T-WALK-1`, `T-WALK-2`.')
            + [1, 2].map(id => `| T-WALK-${id} | DONE | P1 | app | Implement status part ${id} | synthetic | 2026-11-01 | balanced | Child of \`T-WALK\`. |\n`).join(''));
            if (corrupt) write(root, BUNDLE + '/runtime/reviews/' + TASK + '-strict-decomposition-decision.json', '{broken');
        }
    })),
    handoff('test-first-red', 'test-first-expected-failure', /actual project --command/iu, {
        edits: [{ path: 'tests/app.test.ts', append: '// expected red case\n' }],
        setup: root => queue(root, text => text.replace('Synthetic navigator walk.', 'Test-first: expected-red.'))
    }),
    ...([false, true] as const).map(stale => handoff(stale ? 'test-first-red-stale' : 'test-first-current-green',
        stale ? 'test-first-expected-red-stale' : 'test-first-current-green', stale ? /fresh RED|current test bytes/iu : /current passing focused tests/iu, {
        counterState: 'test-first-recorded-red',
        edits: [{ path: 'tests/status.test.cjs', append: [
            'const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs");',
            'test("status implementation", () => assert.match(fs.readFileSync("src/app.ts", "utf8"), /improved/));', ''
        ].join('\n') }],
        setup: root => queue(root, text => text.replace('Synthetic navigator walk.', 'Test-first: expected-red.')),
        act: async (root, gate, steps, run) => {
            if (gate === 'test-first-expected-failure') {
                await run(['run-intermediate-command', '--task-id', TASK, '--command-source', 'targeted-test',
                    '--command', 'node --test --test-reporter=tap tests/status.test.cjs', '--expect-failure',
                    '--selected-case', JSON.stringify({ source: 'tests/status.test.cjs', case_id: 'status implementation', selector: 'tests/status.test.cjs' }),
                    '--preflight-path', BUNDLE + '/runtime/reviews/' + TASK + '-preflight.json', '--repo-root', '.']);
                return true;
            }
            if (gate === 'implementation' && steps.some(step => step.gate === 'test-first-expected-failure')) {
                fs.appendFileSync(path.join(root, 'src/app.ts'), 'export const improved = true;\n');
                if (stale) fs.appendFileSync(path.join(root, 'tests/status.test.cjs'), '// changed after RED\n');
                return true;
            }
            return false;
        }
    })),
    ...([false, true] as const).map(unsafeWip => handoff(unsafeWip ? 'strict-split-unsafe-wip' : 'strict-split',
        unsafeWip ? 'strict-decomposition-wip-capture' : 'strict-decomposition-split-routing',
        unsafeWip ? /unrelated untracked files.*repair the reported scope/iu : /Create and link parent-derived/iu, {
        ...(unsafeWip ? { disturbanceReason: 'An unrelated untracked file appears after the native split decision, before WIP capture.' }
            : { counterState: 'strict-split-decision' }),
        profile: 'strict',
        prepare: async (root, steps, run) => {
            // Submit an explicit agent decision after the implemented scope's rule pack is loaded.
            if (steps.at(-1)?.gate !== 'load-rule-pack' || steps.at(-1)?.exitCode !== 0
                || !steps.some(step => step.gate === 'implementation')) return;
            const contract = BUNDLE + '/runtime/tmp/walk-work-packages.json';
            write(root, contract, JSON.stringify({ schema_version: 1, finding_obligations: [],
                work_packages: [1, 2].map(id => ({ task_id: TASK + '-' + id, profile: 'strict',
                    root_cause_area: 'status-part-' + id, objective: 'Implement independent status behavior part ' + id,
                    scope_obligations: ['Preserve status part ' + id], validation_contract: ['Test status part ' + id],
                    finding_obligation_ids: [], required_review_types: ['code', 'security', 'performance', 'test'] })) }));
            await run(['record-strict-decomposition-decision', '--task-id', TASK, '--task-profile', 'strict',
                '--decision', 'split-required', '--task-summary', 'Change the status renderer',
                '--reason', 'Two independent status contracts require separately executable changes.',
                '--scope-risk', 'Independent source and test obligations require code and test review.',
                '--expected-review-type', 'code', '--expected-review-type', 'security',
                '--expected-review-type', 'performance', '--expected-review-type', 'test',
                '--atomicity-constraint', 'none',
                '--work-package-contract-path', contract, '--repo-root', '.']);
            if (unsafeWip) write(root, 'unrelated.txt', 'Unrelated work must remain outside the parent capture.\n');
        }
    }))
];
