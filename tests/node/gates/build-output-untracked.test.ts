import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runGit } from '../../../src/core/git-helpers';
import { getWorkspaceSnapshot } from '../../../src/gates/compile/compile-gate';
import { buildScopedDiff } from '../../../src/gates/preflight/build-scoped-diff';
import { buildGitDiffSummary } from '../../../src/gates/review-context/review-context-diff';
import { assertReviewTreeStateFresh, buildReviewTreeState } from '../../../src/gates/review/review-tree-state';
import { DEFAULT_BUNDLE_NAME } from '../../../src/core/constants';
import { saveTaskPlan } from '../../../src/core/task-plan-save';
import { runEnterTaskModeCommand } from '../../../src/cli/commands/gate-flows/task-mode/task-mode-flow';
import { initializeGitRepo, seedInitAnswers, seedTaskQueue } from '../cli/commands/gate-test-seed-helpers';

for (const authoringSignal of ['entry', 'approved plan'] as const) {
    test(`T-428 planned bin source stays visible across workspace and review consumers (${authoringSignal})`, t => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-planned-output-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const write = (file: string, text: string) => {
            fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
            fs.writeFileSync(path.join(root, file), text);
        };
        const taskId = 'T-928';
        write('package.json', JSON.stringify({ name: 'planned-source-fixture' }));
        write('AGENTS.md', '# Rules\n');
        write('src/main.ts', 'export const baseline = true;\n');
        write('.gitignore', `${DEFAULT_BUNDLE_NAME}/runtime/\n`);
        for (const name of ['00-core.md', '15-project-memory.md', '40-commands.md', '80-task-workflow.md', '90-skill-catalog.md']) {
            write(`${DEFAULT_BUNDLE_NAME}/live/docs/agent-rules/${name}`, `# ${name}\n`);
        }
        seedInitAnswers(root);
        seedTaskQueue(root, taskId);
        initializeGitRepo(root);
        if (authoringSignal === 'approved plan') {
            const inputFile = `${DEFAULT_BUNDLE_NAME}/runtime/plan-input.json`;
            write(inputFile, JSON.stringify({
                schema_version: 1, task_id: taskId, status: 'approved', goal: 'Write the release script',
                scope_files: ['bin/release.sh'], risk_level: 'low', steps: [{ id: 'one', title: 'Write script' }],
                acceptance_criteria: ['Review the script'], verification_expectations: ['Focused scope test'],
                out_of_scope: ['Generated files']
            }));
            saveTaskPlan(root, taskId, path.join(root, inputFile));
        }
        const entered = runEnterTaskModeCommand({
            repoRoot: root, taskId, entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: 2,
            taskSummary: 'Write the release script', provider: 'Codex', emitMetrics: false,
            plannedChangedFiles: authoringSignal === 'entry' ? ['bin/release.sh'] : []
        });
        assert.equal(entered.exitCode, 0);
        write('bin/release.sh', '#!/bin/sh\nprintf release\n');
        write('bin/Debug/app.dll', 'generated binary\n');
        const snapshot = getWorkspaceSnapshot(root, 'git_auto', true, []);
        assert.ok(snapshot.changed_files.includes('bin/release.sh'), 'native task-planned source must remain visible');
        assert.ok(!snapshot.changed_files.includes('bin/Debug/app.dll'), 'unplanned output must remain excluded');
        const files = ['bin/release.sh', 'bin/Debug/app.dll'];
        const preflight = { task_id: taskId, detection_source: 'git_auto', changed_files: files };
        const preflightPath = path.join(root, DEFAULT_BUNDLE_NAME, 'runtime', 'scope.json');
        const pathsConfigPath = path.join(root, DEFAULT_BUNDLE_NAME, 'runtime', 'scope-paths.json');
        fs.writeFileSync(preflightPath, JSON.stringify(preflight));
        fs.writeFileSync(pathsConfigPath, JSON.stringify({ triggers: { code: ['.'] } }));
        const diff = buildGitDiffSummary(root, files, preflight, preflightPath);
        assert.match(diff.diff!, /bin\/release\.sh/);
        assert.doesNotMatch(diff.diff!, /app\.dll|generated binary/);
        const outputPath = path.join(root, DEFAULT_BUNDLE_NAME, 'runtime', 'scope.diff');
        buildScopedDiff({ repoRoot: root, preflightPath, pathsConfigPath, reviewType: 'code', outputPath,
            metadataPath: `${outputPath}.json` });
        assert.match(fs.readFileSync(outputPath, 'utf8'), /bin\/release\.sh/);
        assert.doesNotMatch(fs.readFileSync(outputPath, 'utf8'), /app\.dll|generated binary/);
        const tree = buildReviewTreeState({ repoRoot: root, detectionSource: 'git_auto', includeUntracked: true,
            changedFiles: files });
        assert.deepEqual(tree.changed_files, ['bin/release.sh']);
    });
}

test('T-404 build output does not alter scope fingerprints, scoped diff, review diff or tree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-output-scope-'));
    const control = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-output-control-'));
    const write = (file: string, text: string) => {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), text);
    };
    try {
        runGit(root, ['init']);
        for (const [key, value] of [['user.name', 'Garda Tests'], ['user.email', 'tests@example.com'], ['core.autocrlf', 'false']])
            runGit(root, ['config', key, value]);
        write('bin/tracked.ts', 'before\n'); runGit(root, ['add', '.']); runGit(root, ['commit', '-m', 'seed']);
        write('bin/tracked.ts', 'after\n'); write('new.ts', 'new\n');
        const files = ['bin/tracked.ts', 'new.ts'];
        const snapshot = getWorkspaceSnapshot(root, 'git_auto', true, []);
        const tree = buildReviewTreeState({ repoRoot: root, detectionSource: 'git_auto', includeUntracked: true, changedFiles: files });
        for (const file of ['target/result.xml', '__pycache__/main.pyc', 'bin/new.dll']) write(file, 'generated\n');
        const after = getWorkspaceSnapshot(root, 'git_auto', true, []);
        assert.deepEqual(after, snapshot, 'ordinary snapshot serialization must stay identical');
        assert.deepEqual(buildReviewTreeState({ repoRoot: root, detectionSource: 'git_auto', includeUntracked: true,
            changedFiles: [...files, 'target/result.xml', '__pycache__/main.pyc', 'bin/new.dll'] }), tree);
        const preflightPath = path.join(control, 'preflight.json'), pathsConfigPath = path.join(control, 'paths.json');
        const preflight = { detection_source: 'git_auto', changed_files: [...files, 'target/result.xml', 'bin/new.dll'] };
        fs.writeFileSync(preflightPath, JSON.stringify(preflight));
        fs.writeFileSync(pathsConfigPath, JSON.stringify({ triggers: { code: ['.'] } }));
        const diff = buildGitDiffSummary(root, preflight.changed_files, preflight, preflightPath);
        assert.match(diff.diff!, /new.ts/); assert.match(diff.diff!, /bin\/tracked.ts/);
        assert.doesNotMatch(diff.diff!, /generated|result.xml|new.dll/);
        const outputPath = path.join(control, 'scope.diff');
        buildScopedDiff({ repoRoot: root, preflightPath, pathsConfigPath, reviewType: 'code', outputPath,
            metadataPath: path.join(control, 'scope.json') });
        const scoped = fs.readFileSync(outputPath, 'utf8');
        assert.match(scoped, /new.ts/); assert.match(scoped, /bin\/tracked.ts/);
        assert.doesNotMatch(scoped, /generated|result.xml|new.dll/);
        write('Cargo.lock', 'new dependency\n');
        assert.ok(getWorkspaceSnapshot(root, 'git_auto', true, []).changed_files.includes('Cargo.lock'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(control, { recursive: true, force: true }); }
});

for (const operation of ['deletion', 'rename'] as const) {
    test(`T-404 preserves committed build-directory ${operation} across checkpoint review consumers`, async t => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-output-checkpoint-'));
        const control = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-output-checkpoint-control-'));
        try {
            runGit(root, ['init']);
            runGit(root, ['config', 'user.name', 'Garda Tests']);
            runGit(root, ['config', 'user.email', 'tests@example.com']);
            runGit(root, ['config', 'core.autocrlf', 'false']);
            fs.mkdirSync(path.join(root, 'bin'));
            fs.writeFileSync(path.join(root, 'bin/old.ts'), 'export const tracked = true;\n');
            runGit(root, ['add', '.']); runGit(root, ['commit', '-m', 'baseline']);
            const base = runGit(root, ['rev-parse', 'HEAD']).trim();
            runGit(root, operation === 'deletion' ? ['rm', 'bin/old.ts'] : ['mv', 'bin/old.ts', 'bin/new.ts']);
            runGit(root, ['commit', '-m', 'checkpoint(split): preserve T-902 dirty diff before decomposition']);
            const checkpoint = runGit(root, ['rev-parse', 'HEAD']).trim();
            const files = operation === 'deletion' ? ['bin/old.ts'] : ['bin/new.ts', 'bin/old.ts'];
            const detectionSource = `git_split_checkpoint:${base}:${checkpoint}`;
            fs.writeFileSync(path.join(root, 'TASK.md'), [
                '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                '|---|---|---|---|---|---|---|---|---|',
                `| T-902 | DECOMPOSED | P1 | workflow | Parent | tests | 2026-10-20 | balanced | Split checkpoint \`${checkpoint}\`. Child tasks: \`T-902-1\`. |`,
                `| T-902-1 | TODO | P1 | workflow | Child | tests | 2026-10-20 | balanced | Child of \`T-902\`. Checkpoint: \`${checkpoint}\`. Checkpoint files: ${files.map(file => '\`' + file + '\`').join(', ')}. |`
            ].join('\n'));
            const preflight = { task_id: 'T-902-1', detection_source: detectionSource, changed_files: files };
            const preflightPath = path.join(control, 'preflight.json'), pathsConfigPath = path.join(control, 'paths.json');
            fs.writeFileSync(preflightPath, JSON.stringify(preflight));
            fs.writeFileSync(pathsConfigPath, JSON.stringify({ triggers: { code: ['.'] } }));
            await t.test('scoped diff retains the historical tracked endpoint', () => {
                const outputPath = path.join(control, 'scope.diff');
                buildScopedDiff({ repoRoot: root, preflightPath, pathsConfigPath, reviewType: 'code', outputPath,
                    metadataPath: path.join(control, 'scope.json') });
                assert.match(fs.readFileSync(outputPath, 'utf8'), /bin\/old.ts/);
            });
            await t.test('review diff retains the historical tracked endpoint and authenticates scope', () => {
                assert.match(buildGitDiffSummary(root, files, preflight, preflightPath).diff!, /bin\/old.ts/);
                assert.throws(() => buildGitDiffSummary(root, files, {
                    ...preflight, detection_source: `git_split_checkpoint:${checkpoint}:${checkpoint}`
                }, preflightPath), /does not match the authenticated task checkpoint scope/);
            });
            await t.test('review tree keeps every checkpoint path and remains fresh', () => {
                const snapshot = getWorkspaceSnapshot(root, detectionSource, false, files);
                const tree = buildReviewTreeState({ repoRoot: root, detectionSource, includeUntracked: false,
                    changedFiles: files, metrics: snapshot });
                assert.deepEqual(tree.changed_files, files);
                assert.doesNotThrow(() => assertReviewTreeStateFresh({ repoRoot: root, reviewContext: { tree_state: tree },
                    contextPath: path.join(control, 'review.json'), gateName: 'record-review-routing' }));
            });
        } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(control, { recursive: true, force: true }); }
    });
}

for (const policy of [[], ['^generated/']]) {
    test(`T-404 nested project scoped diff uses its own ${policy.length ? 'custom' : 'empty'} build policy`, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-output-nested-'));
        const project = path.join(root, 'project'), control = path.join(root, 'control');
        const write = (file: string, text: string) => {
            fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
        };
        try {
            fs.mkdirSync(project); fs.mkdirSync(control);
            runGit(root, ['init']); runGit(root, ['config', 'user.name', 'Garda Tests']);
            runGit(root, ['config', 'user.email', 'tests@example.com']);
            runGit(root, ['config', 'core.autocrlf', 'false']);
            write(path.join(project, 'source.ts'), 'tracked\n');
            runGit(root, ['add', '.']); runGit(root, ['commit', '-m', 'baseline']);
            write(path.join(root, 'garda-agent-orchestrator/live/config/paths.json'),
                JSON.stringify({ untracked_build_output_regexes: ['.'] }));
            write(path.join(project, 'garda-agent-orchestrator/live/config/paths.json'),
                JSON.stringify({ untracked_build_output_regexes: policy }));
            write(path.join(project, 'target/new.ts'), 'authorized target content\n');
            write(path.join(project, 'generated/new.ts'), 'generated content\n');
            const preflightPath = path.join(control, 'preflight.json'), pathsConfigPath = path.join(control, 'paths.json');
            fs.writeFileSync(preflightPath, JSON.stringify({ detection_source: 'git_auto',
                changed_files: ['target/new.ts', 'generated/new.ts'] }));
            for (const trigger of ['.', '^no-match/']) {
                fs.writeFileSync(pathsConfigPath, JSON.stringify({ triggers: { code: [trigger] } }));
                const outputPath = path.join(control, 'scope.diff');
                const metadata = buildScopedDiff({ repoRoot: project, preflightPath, pathsConfigPath,
                    reviewType: 'code', outputPath, metadataPath: path.join(control, 'scope.json') });
                const output = fs.readFileSync(outputPath, 'utf8');
                assert.match(output, /authorized target content/);
                assert.equal(metadata.fallback_to_full_diff, trigger !== '.');
                if (policy.length) assert.doesNotMatch(output, /generated content/);
                else assert.match(output, /generated content/);
            }
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
}

for (const operation of ['deletion', 'rename'] as const) {
    test(`T-404 nested project preserves staged build-directory ${operation} endpoints`, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-output-nested-staged-'));
        const project = path.join(root, 'project'), control = path.join(root, 'control');
        try {
            fs.mkdirSync(path.join(project, 'bin'), { recursive: true }); fs.mkdirSync(control);
            runGit(root, ['init']); runGit(root, ['config', 'user.name', 'Garda Tests']);
            runGit(root, ['config', 'user.email', 'tests@example.com']);
            runGit(root, ['config', 'core.autocrlf', 'false']);
            runGit(root, ['config', 'diff.renames', 'true']);
            fs.writeFileSync(path.join(project, 'source.ts'), 'project source\n');
            fs.writeFileSync(path.join(project, 'bin/old.ts'), 'tracked endpoint\n');
            runGit(root, ['add', '.']); runGit(root, ['commit', '-m', 'baseline']);
            runGit(project, operation === 'deletion' ? ['rm', 'bin/old.ts'] : ['mv', 'bin/old.ts', 'bin/new.ts']);
            const files = operation === 'deletion' ? ['bin/old.ts'] : ['bin/new.ts', 'bin/old.ts'];
            assert.deepEqual(getWorkspaceSnapshot(project, 'explicit_changed_files', false, files).authorized_files, files);
            const preflight = { detection_source: 'git_staged_only', changed_files: files };
            const preflightPath = path.join(control, 'preflight.json'), pathsConfigPath = path.join(control, 'paths.json');
            fs.writeFileSync(preflightPath, JSON.stringify(preflight));
            fs.writeFileSync(pathsConfigPath, JSON.stringify({ triggers: { code: ['.'] } }));
            const outputPath = path.join(control, 'scope.diff');
            const metadata = buildScopedDiff({ repoRoot: project, preflightPath, pathsConfigPath,
                reviewType: 'code', outputPath, metadataPath: path.join(control, 'scope.json') });
            assert.deepEqual(metadata.changed_files, files);
            assert.match(fs.readFileSync(outputPath, 'utf8'), /bin\/old.ts/);
            assert.match(buildGitDiffSummary(project, files, preflight, preflightPath).diff!, /bin\/old.ts/);
            assert.deepEqual(buildReviewTreeState({ repoRoot: project, detectionSource: 'git_staged_only',
                includeUntracked: false, changedFiles: files }).changed_files, files);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
}

test('T-404 excluded-only scope never expands to unrelated tracked or untracked changes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-output-empty-'));
    const control = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-output-empty-control-'));
    try {
        runGit(root, ['init']); runGit(root, ['config', 'user.name', 'Garda Tests']);
        runGit(root, ['config', 'user.email', 'tests@example.com']);
        runGit(root, ['config', 'core.autocrlf', 'false']);
        fs.writeFileSync(path.join(root, 'tracked.ts'), 'before\n');
        runGit(root, ['add', '.']); runGit(root, ['commit', '-m', 'baseline']);
        fs.writeFileSync(path.join(root, 'tracked.ts'), 'unrelated tracked change\n');
        runGit(root, ['add', 'tracked.ts']);
        fs.writeFileSync(path.join(root, 'outside.ts'), 'unrelated untracked change\n');
        fs.mkdirSync(path.join(root, 'target')); fs.writeFileSync(path.join(root, 'target/result.xml'), 'generated\n');
        const preflightPath = path.join(control, 'preflight.json'), pathsConfigPath = path.join(control, 'paths.json');
        fs.writeFileSync(preflightPath, JSON.stringify({ detection_source: 'git_auto', changed_files: ['target/result.xml'] }));
        fs.writeFileSync(pathsConfigPath, JSON.stringify({ triggers: { code: ['.'] } }));
        const artifactPath = path.join(control, 'full.diff');
        fs.writeFileSync(artifactPath, runGit(root, ['diff', '--cached']));
        for (const useStaged of [false, true]) for (const fullDiffPath of [undefined, artifactPath]) {
            const outputPath = path.join(control, 'scope.diff');
            const metadata = buildScopedDiff({ repoRoot: root, preflightPath, pathsConfigPath,
                reviewType: 'code', outputPath, metadataPath: path.join(control, 'scope.json'), useStaged, fullDiffPath });
            assert.equal(fs.readFileSync(outputPath, 'utf8'), '');
            assert.deepEqual(metadata.changed_files, []);
            assert.deepEqual(metadata.untracked_files, []);
            assert.equal(metadata.output_diff_line_count, 0);
            assert.equal(metadata.full_diff_source, 'none');
            assert.equal(metadata.fallback_to_full_diff, false);
        }
    } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(control, { recursive: true, force: true }); }
});
