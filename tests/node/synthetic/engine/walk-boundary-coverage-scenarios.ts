import * as fs from 'node:fs';
import * as path from 'node:path';
import { runCompileGateCommand } from '../../../../src/cli/commands/gate-flows/compile/compile-flow';
import { runEnterTaskModeCommand } from '../../../../src/cli/commands/gate-flows/task-mode/task-mode-flow';
import { writeProtectedControlPlaneManifest } from '../../../../src/gates/protected-control-plane/protected-control-plane';
import { runGit } from '../../cli/commands/gate-test-helpers';
import type { WalkScenario } from './navigator-walk';

const REVIEWS = 'garda-agent-orchestrator/runtime/reviews';


function staleCompletionAfterDocsReentry(): WalkScenario {
    let reentered = false;
    return {
        id: 'coverage-stale-completion-after-docs-reentry', profile: 'docs-only',
        edits: [{ path: 'docs/guide.md', append: 'Clarify the existing behavior.\n' }],
        expectedReviews: {}, expectedModes: [],
        disturbanceReason: 'Explicit native re-entry after docs-only completion, followed by an ordinary docs-only scope extension.',
        expectedBlockedGate: 'completion-gate', expectedGuidance: /previous completion gate pass exists, but it is older than the latest task-mode entry/u,
        prepare: async (root, steps) => {
            if (!steps.length) reentered = false;
            const last = steps.at(-1);
            if (reentered || last?.gate !== 'completion-gate' || last.exitCode !== 0) return;
            reentered = true;
            const result = runEnterTaskModeCommand({ repoRoot: root, taskId: 'T-WALK', provider: 'Codex',
                entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: 2, taskSummary: 'Change the status renderer',
                plannedChangedFiles: ['docs/guide.md', 'docs/extra.md'], emitMetrics: false });
            if (result.exitCode !== 0) throw new Error('Native docs re-entry refused: ' + result.outputLines.join('\n'));
            fs.writeFileSync(path.join(root, 'docs/extra.md'), 'Additional ordinary documentation.\n');
        }
    };
}

// A Garda source checkout starts the task with committed protected drift, which preflight accepts as inherited
// source-checkout drift. While native compile runs, the inherited file temporarily matches its trusted manifest again,
// so the current manifest is no longer drifted and only the preflight's recorded drift remains. Compile refuses it as
// drift that predates the task; next-step then asks for a protected task-mode restart with fresh operator confirmation.
// (In a consumer repository classify-change already refuses committed protected drift, before compile.)
function compileRevertedProtectedDrift(): WalkScenario {
    let compiled = false;
    return {
        id: 'coverage-compile-reverted-protected-drift',
        edits: [{ path: 'docs/guide.md', append: 'Document the existing behavior.\n' }],
        expectedReviews: {}, expectedModes: [],
        disturbanceReason: 'Revert inherited source-checkout protected drift to its trusted manifest content only while native compile runs.',
        expectedBlockedGate: 'enter-task-mode',
        expectedGuidance: /Compile gate requires a protected task-mode restart.*fresh operator confirmation/isu,
        configure: root => {
            const file = path.join(root, 'package.json');
            const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
            manifest.name = 'garda-agent-orchestrator';
            fs.writeFileSync(file, JSON.stringify(manifest));
            fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
            fs.writeFileSync(path.join(root, 'bin/garda.js'), 'require("../garda-agent-orchestrator/bin/garda.js");\n');
            fs.mkdirSync(path.join(root, 'src/gates'), { recursive: true });
            fs.writeFileSync(path.join(root, 'src/gates/inherited.ts'), 'export {};\n');
            if (runGit(root, ['add', 'package.json', 'bin/garda.js', 'src/gates']).status !== 0
                || runGit(root, ['commit', '-qm', 'Seed disposable source checkout']).status !== 0) throw new Error('Cannot seed source fixture.');
        },
        setup: root => {
            writeProtectedControlPlaneManifest(root);
            fs.appendFileSync(path.join(root, 'src/gates/inherited.ts'), '// inherited committed source drift\n');
            if (runGit(root, ['add', 'src/gates/inherited.ts']).status !== 0
                || runGit(root, ['commit', '-qm', 'Retain inherited source drift in disposable fixture']).status !== 0) throw new Error('Cannot retain inherited drift.');
        },
        prepare: async (root, steps) => {
            if (!steps.length) compiled = false;
            const last = steps.at(-1);
            // The executed quality checklist is the last gate before next-step routes to compile-gate.
            if (compiled || last?.gate !== 'quality-checklist' || last.exitCode !== 0
                || !steps.some(step => step.gate === 'implementation')) return;
            compiled = true;
            const file = path.join(root, 'src/gates/inherited.ts'), drifted = fs.readFileSync(file);
            fs.writeFileSync(file, 'export {};\n');
            try {
                const result = await runCompileGateCommand({ repoRoot: root, taskId: 'T-WALK',
                    preflightPath: REVIEWS + '/T-WALK-preflight.json', emitMetrics: false });
                if (result.exitCode === 0 || !result.outputLines.join('\n').includes('Trusted protected control-plane manifest was already drifted before task start:')) {
                    throw new Error('Expected native protected-baseline compile refusal: ' + result.outputLines.join('\n'));
                }
            } finally { fs.writeFileSync(file, drifted); }
        }
    };
}

export const BOUNDARY_COVERAGE_WALK_SCENARIOS: readonly WalkScenario[] = [
    staleCompletionAfterDocsReentry(),
    compileRevertedProtectedDrift()
];
