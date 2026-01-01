import * as fs from 'node:fs';
import * as path from 'node:path';
import { splitCommandLine } from '../../../../src/core/command-line';
import { EVIDENCE_EDGE_WALK_SCENARIOS } from './walk-evidence-edge-scenarios';
import { NativeWalkOwner, waitForOwner, writeOwnerBlocker } from './walk-native-owner';
import type { WalkScenario } from './navigator-walk';
import { runGit } from '../../cli/commands/gate-test-helpers';
import { EXIT_GATE_FAILURE } from '../../../../src/cli/exit-codes';
import { legacySourceRoute } from './walk-legacy-task-contract';

const REVIEWS = 'garda-agent-orchestrator/runtime/reviews/';
// The active and dead owner decisions retain their distinct recovery routes after source lines moved.
const FULL_ACTIVE = legacySourceRoute('src/gates/next-step/next-step-full-suite-routing.ts', 'Wait for active task test validation run.');
const FULL_DEAD = legacySourceRoute('src/gates/next-step/next-step-full-suite-routing.ts', 'A previous task test validation run');
const RECIPE_ACTIVE = legacySourceRoute('src/gates/next-step/next-step-validation-routes.ts', 'await-project-validation');
const EDITS = [{ path: 'src/app.ts', append: '// owner coverage\n' }, { path: 'tests/app.test.ts', append: '// owner coverage\n' }];

function fullSuiteOwner(crash: boolean): WalkScenario {
    let owner: NativeWalkOwner | undefined;
    let observed = false;
    return {
        id: 'coverage-full-suite-owner-' + (crash ? 'crashed' : 'in-flight'), edits: EDITS,
        selectionTargets: ['tests/app.test.ts'],
        testSelectionCommand: 'node .git/walk-owner/block.cjs --test tests/app.test.ts',
        expectedReviews: crash ? {} : { code: 1, test: 1 }, expectedModes: crash ? [] : ['code:FULL', 'test:FULL'],
        ...(crash ? { expectedBlockedGate: 'full-suite-validation',
            expectedGuidance: /A previous task test validation run.*gate pid \d+ is no longer alive; child pid \d+ is no longer alive/isu } : {}),
        expectedRoutes: [crash ? FULL_DEAD : FULL_ACTIVE],
        disturbanceReason: crash ? 'Kill the real full-suite owner tree after its native marker and blocking test readiness exist.'
            : 'Hold the real fixture full-suite command on a release file while the navigator inspects its active owner.',
        configure: root => {
            writeOwnerBlocker(root);
        },
        execute: async (root, step) => {
            if (!crash && owner && step.routes?.includes(FULL_ACTIVE)) {
                observed = true;
                fs.writeFileSync(path.join(root, '.git/walk-owner/release'), 'release fixture test\n');
                await owner.finish();
                step.output = owner.output;
                step.exitCode = 0;
                return true;
            }
            if (owner || step.gate !== 'full-suite-validation') return false;
            const argv = splitCommandLine(step.command!);
            owner = new NativeWalkOwner(root, argv.slice(argv.indexOf('gate') + 1));
            let retainedMarker = '';
            await waitForOwner('full-suite child readiness and native bound child marker', () => {
                owner!.assertRunning();
                const marker = path.join(root, REVIEWS, 'T-WALK-full-suite-run-marker.json');
                if (!fs.existsSync(marker) || !fs.existsSync(path.join(root, '.git/walk-owner/ready'))) return false;
                retainedMarker = fs.readFileSync(marker, 'utf8');
                const value = JSON.parse(retainedMarker);
                return value.gate_pid === owner!.child.pid && Number.isSafeInteger(value.child_pid)
                    && value.child_pid === Number(fs.readFileSync(path.join(root, '.git/walk-owner/ready'), 'utf8'));
            });
            if (fs.existsSync(path.join(root, REVIEWS, 'T-WALK-full-suite-validation.json')))
                throw new Error('Owner published terminal evidence before concurrent inspection.');
            if (crash) await owner.killTree();
            step.output = (crash ? 'Killed native owner tree after its own marker and test readiness.'
                : 'Native full-suite owner is blocked in its fixture test.') + '\nNative run marker before inspection:\n' + retainedMarker;
            return true;
        },
        prepare: async (root, steps) => {
            if (!owner || observed || !steps.at(-1)?.routes?.includes(crash ? FULL_DEAD : FULL_ACTIVE)) return;
            observed = true;
            fs.writeFileSync(path.join(root, '.git/walk-owner/release'), 'release fixture test\n');
            if (!crash) await owner.finish();
            // A dead marker is cleaned only by the recovery command printed by the native navigator.
        },
        act: async (root, gate) => {
            if (crash || gate !== 'full-suite-validation' || !owner || observed) return false;
            observed = true;
            fs.writeFileSync(path.join(root, '.git/walk-owner/release'), 'release fixture test\n');
            await owner.finish();
            return true;
        },
        cleanup: async root => {
            try {
                if (owner && !owner.closed && !crash) {
                    fs.writeFileSync(path.join(root, '.git/walk-owner/release'), 'release for cleanup\n');
                    await owner.finish([0, 1, EXIT_GATE_FAILURE, 97]);
                }
            } finally { await owner?.killTree(); }
        }
    };
}

function recipeOwner(): WalkScenario {
    const original = EVIDENCE_EDGE_WALK_SCENARIOS.find(scenario => scenario.id === 'coverage-declared-recipe')!;
    let owner: NativeWalkOwner | undefined;
    return {
        ...original, id: 'coverage-declared-recipe-in-flight', expectedGates: ['await-project-validation'],
        expectedRoutes: [RECIPE_ACTIVE],
        disturbanceReason: 'Hold a real admitted recipe child on a release file while inspecting its authenticated pending attempt.',
        prepare: async (root, steps, run) => {
            if (!steps.length) await original.prepare!(root, steps, run);
        },
        configure: root => {
            original.configure!(root);
            writeOwnerBlocker(root);
            const file = path.join(root, 'recipes.json');
            const declaration = JSON.parse(fs.readFileSync(file, 'utf8'));
            declaration.recipes[0].argv.unshift('.git/walk-owner/block.cjs');
            declaration.recipes[0].timeout_ms = 120_000;
            fs.writeFileSync(file, JSON.stringify(declaration));
            if (runGit(root, ['add', 'recipes.json']).status !== 0
                || runGit(root, ['commit', '-qm', 'Block the disposable recipe on a release file']).status !== 0)
                throw new Error('Cannot retain blocked recipe declaration.');
        },
        execute: async (root, step) => {
            if (owner || step.gate !== 'run-intermediate-command' || !step.command?.includes('--recipe-id')) return false;
            const argv = splitCommandLine(step.command);
            owner = new NativeWalkOwner(root, argv.slice(argv.indexOf('gate') + 1));
            await waitForOwner('declared recipe test readiness', () => {
                owner!.assertRunning();
                return fs.existsSync(path.join(root, '.git/walk-owner/ready'));
            });
            step.output = 'Native declared recipe owner is blocked in its fixture test.';
            return true;
        },
        act: async (root, gate) => {
            if (gate !== 'await-project-validation') return false;
            if (!owner) throw new Error('Await route without the native executing owner.');
            fs.writeFileSync(path.join(root, '.git/walk-owner/release'), 'release fixture test\n');
            await owner.finish(); // Process PASS still requires independent per-case semantics.
            if (!/PROJECT_VALIDATION_PROCESS_PASSED[\s\S]*ResultStatus: UNRESOLVED[\s\S]*ExitCode: 0/u.test(owner.output))
                throw new Error('Recipe did not retain a successful native result: ' + owner.output);
            return true;
        },
        cleanup: async root => {
            try {
                if (owner && !owner.closed) {
                    fs.writeFileSync(path.join(root, '.git/walk-owner/release'), 'release for cleanup\n');
                    await owner.finish([0, 1, EXIT_GATE_FAILURE, 97]);
                }
            } finally { await owner?.killTree(); }
        }
    };
}

export const OWNER_COVERAGE_WALK_SCENARIOS: readonly WalkScenario[] = [fullSuiteOwner(false), fullSuiteOwner(true), recipeOwner()];
