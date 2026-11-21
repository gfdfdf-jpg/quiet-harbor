import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runGit } from '../../../src/core/git-helpers';
import { classifyGitChanges } from '../../../src/core/git-change-classification';
import { loadPathsConfig } from '../../../src/policy/profile-resolver';
import { migrateLegacyManagedPathRegexes } from '../../../src/policy/default-path-regexes';
import { collectUntrackedBuildOutputExclusions, filterBuildOutputScopePaths } from '../../../src/core/build-output-paths';
import { captureWorkspacePlannedFiles, clearWorkspacePlannedFiles, publishWorkspacePlannedFiles } from '../../../src/core/workspace-planned-files';
import { getWorkspaceSnapshot } from '../../../src/gates/compile/compile-gate';
import { runClassifyChangeCommand } from '../../../src/cli/commands/gate-flows/compile/compile-flow-classify';
import { buildPostDoneWorkspaceDriftBlocker } from '../../../src/gates/task-audit/task-audit-summary-drift';

const OUTPUTS = ['target', 'bin', 'obj', 'build', 'dist', 'out', '__pycache__', '.venv', 'venv',
    'node_modules', '.gradle', '.pytest_cache', '.mypy_cache', 'coverage', '_build', '.build', '.dart_tool',
    '.zig-cache', 'zig-out'];

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-paths-'));
    runGit(root, ['init']);
    runGit(root, ['config', 'core.autocrlf', 'false']);
    runGit(root, ['config', 'user.name', 'Garda Tests']);
    runGit(root, ['config', 'user.email', 'tests@example.com']);
    const write = (file: string, text = 'new\n') => {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), text);
    };
    write('target/tracked.ts', 'old\n');
    runGit(root, ['add', '.']);
    runGit(root, ['commit', '-m', 'seed']);
    return { root, write, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// Planned visibility follows the 1.4.4 native-entry contract (exact canonical paths, invocation-retained);
// these cases keep the 2.0 excluded-output diagnostics on top of it.
test('T-428 protects exact planned paths and reports only the remaining excluded output', () => {
    const f = fixture();
    try {
        const scripts = ['bin/release.sh', 'nested/build/generate.py', 'out/handwritten.ts', 'dist/publish.sh'];
        const generated = ['bin/Debug/app.dll', 'target/bin/hidden.rs', 'bin/node_modules/hidden.js',
            'build/__pycache__/main.pyc', 'bin/generated.pyc', '.gradle/out/hidden.class'];
        for (const file of [...scripts, ...generated]) f.write(file);
        publishWorkspacePlannedFiles(f.root, 'T-928', scripts);
        assert.deepEqual(classifyGitChanges(f.root).untrackedFiles, [...scripts].sort());
        assert.deepEqual(filterBuildOutputScopePaths(f.root, [...scripts, ...generated]), scripts);
        assert.deepEqual(collectUntrackedBuildOutputExclusions(f.root), { count: generated.length, files: [...generated].sort() });
        assert.deepEqual(classifyGitChanges(f.root, { explicitUntrackedPaths: ['bin/Debug/app.dll'] }).untrackedFiles,
            [...scripts].sort(), 'ordinary explicit inputs must not create planned protection');
    } finally { clearWorkspacePlannedFiles(f.root); f.clean(); }
});

for (const layout of ['directory', 'worktree'] as const) {
    test(`T-428 retains nested-project planned source with ${layout} Git metadata`, () => {
        const f = fixture();
        const gitRoot = layout === 'directory' ? f.root : path.join(f.root, 'linked');
        const projectRoot = path.join(gitRoot, 'project');
        try {
            if (layout === 'worktree') runGit(f.root, ['worktree', 'add', '--detach', gitRoot, 'HEAD']);
            fs.mkdirSync(path.join(projectRoot, 'bin/Debug'), { recursive: true });
            fs.writeFileSync(path.join(projectRoot, 'bin/release.sh'), 'echo release\n');
            fs.writeFileSync(path.join(projectRoot, 'bin/Debug/app.dll'), 'generated\n');
            publishWorkspacePlannedFiles(projectRoot, 'T-928', ['bin/release.sh']);
            assert.deepEqual(captureWorkspacePlannedFiles(projectRoot).paths, ['bin/release.sh']);
            assert.deepEqual(filterBuildOutputScopePaths(projectRoot, ['bin/release.sh', 'bin/Debug/app.dll']),
                ['bin/release.sh']);
            assert.deepEqual(collectUntrackedBuildOutputExclusions(projectRoot),
                { count: 1, files: ['bin/Debug/app.dll'] });
            assert.deepEqual(captureWorkspacePlannedFiles(gitRoot).paths, [], 'enclosing workspace must not inherit project protection');
        } finally { clearWorkspacePlannedFiles(projectRoot); f.clean(); }
    });
}

test('T-428 rejects unsafe planned paths instead of silently hiding source', () => {
    const f = fixture();
    try {
        publishWorkspacePlannedFiles(f.root, 'T-928', ['bin/release.sh']);
        for (const unsafe of ['../outside.sh', '/outside.sh', 'C:/outside.sh', './bin/release.sh', 'bin\\release.sh']) {
            assert.throws(() => publishWorkspacePlannedFiles(f.root, 'T-928', [unsafe]), /Invalid native planned-source visibility/u);
            assert.deepEqual(captureWorkspacePlannedFiles(f.root).paths, ['bin/release.sh']);
        }
    } finally { clearWorkspacePlannedFiles(f.root); f.clean(); }
});

test('T-428 bounds build-output diagnostics without counting protected source', () => {
    const f = fixture();
    try {
        publishWorkspacePlannedFiles(f.root, 'T-928', ['bin/release.sh']);
        f.write('bin/release.sh');
        const outputFiles = Array.from({ length: 25 }, (_, index) => `bin/Debug/result-${String(index).padStart(2, '0')}.dll`);
        for (const file of outputFiles) f.write(file);
        assert.deepEqual(collectUntrackedBuildOutputExclusions(f.root), { count: 25, files: outputFiles.slice(0, 20) });
    } finally { clearWorkspacePlannedFiles(f.root); f.clean(); }
});

test('T-428 preflight and task-audit observe the same planned source and exclude real output', () => {
    const f = fixture();
    try {
        fs.mkdirSync(path.join(f.root, 'garda-agent-orchestrator'));
        f.write('.git/info/exclude', 'garda-agent-orchestrator/runtime/\n');
        publishWorkspacePlannedFiles(f.root, 'T-928', ['bin/release.sh']);
        f.write('bin/release.sh'); f.write('bin/Debug/app.dll');
        const preflight = JSON.parse(runClassifyChangeCommand({ repoRoot: f.root, includeUntracked: true,
            taskIntent: 'Write a release script', emitMetrics: false }).outputText);
        assert.deepEqual(preflight.changed_files, ['bin/release.sh']);
        assert.equal(preflight.build_output_excluded_untracked_count, 1);
        assert.deepEqual(preflight.build_output_excluded_untracked_files, ['bin/Debug/app.dll']);
        const compiledScope = getWorkspaceSnapshot(f.root, preflight.detection_source, true, []);
        assert.deepEqual(compiledScope.changed_files, preflight.changed_files);
        const blocker = buildPostDoneWorkspaceDriftBlocker(f.root, [], [], null,
            path.join(f.root, 'garda-agent-orchestrator/runtime/reviews/missing-closeout.json'));
        assert.match(blocker?.reason ?? '', /bin\/release\.sh/, 'audit must detect the planned source if it was never accepted');
        assert.doesNotMatch(blocker?.reason ?? '', /app\.dll/);
    } finally { clearWorkspacePlannedFiles(f.root); f.clean(); }
});

test('T-404 ignores only untracked build output while retaining tracked and ordinary untracked files', () => {
    const f = fixture();
    try {
        for (const directory of OUTPUTS) f.write(`nested/${directory}/результат.dat`);
        for (const file of ['module.pyc', 'nested/module.pyo', 'src/new.ts', 'Cargo.lock', 'build.config.ts', 'target.txt']) f.write(file);
        f.write('target/tracked.ts');
        const result = classifyGitChanges(f.root);
        assert.deepEqual(result.effectiveChangedFiles, ['Cargo.lock', 'build.config.ts', 'src/new.ts', 'target.txt', 'target/tracked.ts']);
        runGit(f.root, ['add', 'nested/bin/результат.dat']);
        assert.ok(classifyGitChanges(f.root).stagedFiles.includes('nested/bin/результат.dat'));
        assert.ok(!classifyGitChanges(f.root, { explicitUntrackedPaths: ['nested/target/результат.dat'] })
            .effectiveChangedFiles.includes('nested/target/результат.dat'));
    } finally { f.clean(); }
});

test('T-404 configured untracked build patterns replace defaults and preserve explicit empty configuration', () => {
    const f = fixture();
    try {
        const config = 'garda-agent-orchestrator/live/config/paths.json';
        f.write(config, JSON.stringify({ untracked_build_output_regexes: ['(^|/)generated/'] }));
        runGit(f.root, ['add', config]);
        runGit(f.root, ['commit', '-m', 'config']);
        f.write('generated/result.dat'); f.write('target/output.dat');
        assert.deepEqual(classifyGitChanges(f.root).untrackedFiles, ['target/output.dat']);
        const loaded = loadPathsConfig(path.join(f.root, config)) as unknown as Record<string, unknown>;
        assert.deepEqual(loaded.untracked_build_output_regexes, ['(^|/)generated/']);
        f.write(config, JSON.stringify({ untracked_build_output_regexes: [] }));
        assert.deepEqual(classifyGitChanges(f.root).untrackedFiles, ['generated/result.dat', 'target/output.dat']);
    } finally { f.clean(); }
});

test('T-419 keeps ignored explicit Garda executable runtime in scope while filtering ordinary build output', () => {
    const f = fixture();
    try {
        f.write('package.json', JSON.stringify({ name: 'garda-agent-orchestrator' }));
        runGit(f.root, ['add', 'package.json']);
        runGit(f.root, ['commit', '-m', 'source checkout']);
        f.write('.git/info/exclude', 'dist/\n');
        const runtime = 'dist/src/gates/next-step/next-step.js';
        const paths = [runtime, 'dist/assets/result.js', 'dist/src-copy/result.js',
            'nested/dist/src/result.js', 'target/tracked.ts'];
        for (const file of paths) f.write(file);

        assert.deepEqual(filterBuildOutputScopePaths(f.root, paths), [runtime, 'target/tracked.ts']);
        assert.deepEqual(classifyGitChanges(f.root, { explicitUntrackedPaths: paths }).untrackedFiles, [runtime]);
        assert.deepEqual(classifyGitChanges(f.root, { explicitUntrackedPaths: paths }).stagedFiles, []);
        assert.ok(classifyGitChanges(f.root, { explicitUntrackedPaths: paths })
            .effectiveChangedFiles.includes('target/tracked.ts'));

        f.write('package.json', JSON.stringify({ name: 'ordinary-project' }));
        assert.deepEqual(filterBuildOutputScopePaths(f.root, paths), ['target/tracked.ts']);
        assert.deepEqual(classifyGitChanges(f.root, { explicitUntrackedPaths: paths }).untrackedFiles, []);
    } finally { f.clean(); }
});

for (const [label, packageContents] of [
    ['missing', undefined], ['unrelated', '{"name":"ordinary-project"}'],
    ['lookalike', '{"name":"garda-agent-orchestrator-fork"}'], ['malformed', '{"name":']
] as const) {
    test(`T-419 retains build filtering for ${label} Garda package identity`, () => {
        const f = fixture();
        try {
            if (packageContents !== undefined) {
                f.write('package.json', packageContents);
                runGit(f.root, ['add', 'package.json']);
                runGit(f.root, ['commit', '-m', 'ordinary project']);
            }
            const runtime = 'dist/src/gates/next-step/next-step.js';
            f.write(runtime);
            assert.deepEqual(filterBuildOutputScopePaths(f.root, [runtime]), []);
            assert.deepEqual(classifyGitChanges(f.root, { explicitUntrackedPaths: [runtime] }).untrackedFiles, []);
        } finally { f.clean(); }
    });
}

test('T-404 legacy paths migration adds missing build defaults without rewriting project customization', () => {
    const defaults = { untracked_build_output_regexes: ['(^|/)target/', '\\.py[co]$'] };
    const legacy: Record<string, unknown> = { runtime_roots: ['custom/'] };
    assert.ok(migrateLegacyManagedPathRegexes(legacy, defaults).includes('untracked_build_output_regexes'));
    assert.deepEqual(legacy.untracked_build_output_regexes, defaults.untracked_build_output_regexes);
    for (const custom of [[], ['custom/']]) {
        const configured = { untracked_build_output_regexes: custom };
        assert.deepEqual(migrateLegacyManagedPathRegexes(configured, defaults), []);
        assert.deepEqual(configured.untracked_build_output_regexes, custom);
    }
});

for (const [label, patterns, expected] of [
    ['default', undefined, ['generated/output.ts', 'src/explicit.ts', 'target/tracked.ts']],
    ['custom', ['(^|/)generated/'], ['src/explicit.ts', 'target/generated.ts', 'target/tracked.ts']],
    ['empty', [], ['generated/output.ts', 'src/explicit.ts', 'target/generated.ts', 'target/tracked.ts']]
] as const) {
    test(`T-404 normalizes explicit path aliases before ${label} build policy`, () => {
        const f = fixture();
        try {
            if (patterns !== undefined) {
                const config = 'garda-agent-orchestrator/live/config/paths.json';
                f.write(config, JSON.stringify({ untracked_build_output_regexes: patterns }));
                runGit(f.root, ['add', config]);
                runGit(f.root, ['commit', '-m', 'configure build policy']);
            }
            f.write('.git/info/exclude', 'src/explicit.ts\n');
            f.write('src/explicit.ts');
            f.write('target/generated.ts');
            f.write('generated/output.ts');
            f.write('target/tracked.ts');
            const explicitUntrackedPaths = [
                '.\\target\\generated.ts', './src/../target//generated.ts',
                'generated\\output.ts', 'src\\explicit.ts', 'target\\tracked.ts'
            ];
            assert.deepEqual(classifyGitChanges(f.root, { explicitUntrackedPaths }).effectiveChangedFiles, expected);
        } finally { f.clean(); }
    });
}
