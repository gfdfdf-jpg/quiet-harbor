import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_UNTRACKED_BUILD_OUTPUT_REGEXES, filterBuildOutputScopePaths,
    filterUntrackedBuildOutputPaths, normalizeUntrackedBuildOutputRegexes } from '../../../src/core/build-output-paths';
import { runGit } from '../../../src/core/git-helpers';
import { validatePathsConfig } from '../../../src/schemas/config-artifacts-core';
import { clearWorkspacePlannedFiles, publishWorkspacePlannedFiles } from '../../../src/core/workspace-planned-files';
import { classifyGitChanges } from '../../../src/core/git-change-classification';
import { spawnSyncWithTimeout } from '../../../src/core/subprocess';

const NATIVE_TOOL_TIMEOUT_MS = 120_000;

function verifyNativeBuild(t: TestContext, options: {
    command: string; version: string[]; args: string[]; files: Record<string, string>;
    artifact: string; additionalSource?: string[];
}): void {
    // A cold JVM or SDK start on a loaded hosted Windows runner can exceed 10 s; the
    // availability probe gets the same budget as the build it guards.
    const probe = spawnSyncWithTimeout(options.command, options.version, { encoding: 'utf8', timeoutMs: NATIVE_TOOL_TIMEOUT_MS });
    if ((probe.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        t.skip(`${options.command} is unavailable; native stack acceptance is not established here.`);
        return;
    }
    assert.equal(probe.timedOut, false, `${options.command} availability probe timed out after ${NATIVE_TOOL_TIMEOUT_MS} ms`);
    assert.equal(probe.status, 0, `${options.command} availability: ${probe.stderr}`);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-native-output-'));
    const control = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-native-output-control-'));
    t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(control, { recursive: true, force: true }); });
    for (const [file, text] of Object.entries(options.files)) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), text);
    }
    runGit(root, ['init']);
    runGit(root, ['config', 'user.name', 'Garda Tests']);
    runGit(root, ['config', 'user.email', 'tests@example.com']);
    runGit(root, ['add', '.']); runGit(root, ['commit', '-m', 'native build fixture']);
    publishWorkspacePlannedFiles(root, 'T-928', ['bin/release.sh']);
    t.after(() => clearWorkspacePlannedFiles(root));
    const build = spawnSyncWithTimeout(options.command, options.args, { cwd: root, encoding: 'utf8', timeoutMs: NATIVE_TOOL_TIMEOUT_MS,
        env: { ...process.env, DOTNET_CLI_HOME: control, NUGET_PACKAGES: path.join(control, 'nuget'),
            DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
            DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: 'true', RUSTUP_AUTO_INSTALL: '0' } });
    assert.equal(build.timedOut, false, 'native build must finish within its fixture budget');
    assert.equal(build.status, 0, String(build.stderr || build.stdout).slice(-4000));
    assert.ok(fs.existsSync(path.join(root, options.artifact)), 'the real compiler must produce its expected output');
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'bin/release.sh'), '#!/bin/sh\nprintf release\n');
    assert.deepEqual(classifyGitChanges(root).untrackedFiles, [...(options.additionalSource ?? []), 'bin/release.sh'].sort());
}

test('T-428 Python native build output stays excluded', t => verifyNativeBuild(t, {
    command: 'python', version: ['--version'], args: ['-I', '-m', 'py_compile', 'src/main.py'],
    files: { 'src/main.py': 'print("fixture")\n' }, artifact: 'src/__pycache__'
}));

test('T-428 Rust native build output stays excluded', t => verifyNativeBuild(t, {
    command: 'cargo', version: ['--version'], args: ['build', '--offline', '--manifest-path', 'Cargo.toml'],
    files: { 'Cargo.toml': '[package]\nname = "garda_fixture"\nversion = "0.1.0"\nedition = "2021"\n',
        'src/main.rs': 'fn main() { println!("fixture"); }\n' },
    artifact: `target/debug/garda_fixture${process.platform === 'win32' ? '.exe' : ''}`, additionalSource: ['Cargo.lock']
}));

test('T-428 Java native build output stays excluded', t => verifyNativeBuild(t, {
    command: 'javac', version: ['--version'], args: ['-d', 'out', 'src/Main.java'],
    files: { 'src/Main.java': 'class Main { public static void main(String[] args) { System.out.println("fixture"); } }\n' },
    artifact: 'out/Main.class'
}));

test('T-428 dotnet native build output stays excluded', t => {
    const sdks = spawnSyncWithTimeout('dotnet', ['--list-sdks'], { encoding: 'utf8', timeoutMs: NATIVE_TOOL_TIMEOUT_MS });
    // A slow SDK listing must fail, not turn into a silent "SDK unavailable" skip.
    assert.equal(sdks.timedOut, false, `dotnet SDK listing timed out after ${NATIVE_TOOL_TIMEOUT_MS} ms`);
    const versions = String(sdks.stdout).split(/\r?\n/u).map(line => Number(line.match(/^(\d+)\./u)?.[1])).filter(Number.isFinite);
    const major = Math.max(...versions);
    if (!Number.isSafeInteger(major) || major < 8) { t.skip('A .NET SDK 8+ is unavailable; native acceptance is not established.'); return; }
    verifyNativeBuild(t, { command: 'dotnet', version: ['--list-sdks'],
        args: ['build', 'Fixture.csproj', '--configfile', 'NuGet.Config', '--nologo', '--verbosity', 'quiet', '--disable-build-servers'],
        files: { 'Fixture.csproj': `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net${major}.0</TargetFramework></PropertyGroup></Project>`,
            'Program.cs': 'System.Console.WriteLine("fixture");\n',
            'NuGet.Config': '<configuration><packageSources><clear /></packageSources></configuration>' },
        artifact: `bin/Debug/net${major}.0/Fixture.dll` });
});

test('T-404 managed build defaults and schema validation share the runtime contract', () => {
    const template = JSON.parse(fs.readFileSync(path.resolve('template/config/paths.json'), 'utf8'));
    assert.deepEqual(template.untracked_build_output_regexes, DEFAULT_UNTRACKED_BUILD_OUTPUT_REGEXES);
    assert.deepEqual(validatePathsConfig(template).untracked_build_output_regexes, DEFAULT_UNTRACKED_BUILD_OUTPUT_REGEXES);
    for (const value of [null, 'target/', ['['], [null], ['']]) {
        assert.throws(() => normalizeUntrackedBuildOutputRegexes(value), /untracked_build_output_regexes/);
        assert.throws(() => validatePathsConfig({ ...template, untracked_build_output_regexes: value }), /untracked_build_output_regexes/);
    }
});

test('T-404 preserves staged deletion and exact Git path components in build filtering', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-output-policy-'));
    try {
        runGit(root, ['init']);
        runGit(root, ['config', 'user.name', 'Garda Tests']);
        runGit(root, ['config', 'user.email', 'tests@example.com']);
        fs.mkdirSync(path.join(root, 'bin'));
        fs.writeFileSync(path.join(root, 'bin/tracked.ts'), 'tracked\n');
        runGit(root, ['add', '.']); runGit(root, ['commit', '-m', 'seed']);
        runGit(root, ['rm', 'bin/tracked.ts']);
        assert.deepEqual(filterBuildOutputScopePaths(root, ['bin/tracked.ts', 'bin/new.dll', 'source.ts']),
            ['bin/tracked.ts', 'source.ts']);
        assert.deepEqual(filterUntrackedBuildOutputPaths(root, ['target\\literal.ts', 'mytarget/file', 'target/file',
            'build.config.ts', 'folder/coverage.txt', 'nested/out/file']),
            ['target\\literal.ts', 'mytarget/file', 'build.config.ts', 'folder/coverage.txt']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('T-404 preserves both tracked endpoints of staged rename inside build directories', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-output-rename-'));
    try {
        runGit(root, ['init']);
        runGit(root, ['config', 'user.name', 'Garda Tests']);
        runGit(root, ['config', 'user.email', 'tests@example.com']);
        runGit(root, ['config', 'diff.renames', 'true']);
        fs.mkdirSync(path.join(root, 'bin'));
        fs.writeFileSync(path.join(root, 'bin/old.ts'), 'tracked\n');
        runGit(root, ['add', '.']); runGit(root, ['commit', '-m', 'seed']);
        runGit(root, ['mv', 'bin/old.ts', 'bin/new.ts']);
        const files = ['bin/old.ts', 'bin/new.ts', 'source.ts'];
        assert.deepEqual(filterBuildOutputScopePaths(root, files), files);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
