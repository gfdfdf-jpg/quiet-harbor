import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import '../isolate-compile-cache';
import { parseCommandChain } from '../../../src/core/command-line';

export const BASELINES = ['9cc56c65', 'pre-universal-2026-11-06'] as const;
export const TASK = 'T-P4';
export const BUNDLE = 'garda-agent-orchestrator';
export const PREFLIGHT = `${BUNDLE}/runtime/reviews/${TASK}-preflight.json`;
export const OWN_COMMAND = 'node --test tests/total.test.cjs';
export const BROAD_COMMAND = 'node scripts/legacy-broad.cjs';

export interface CommandResult { code: number | null; output: string; stdout: string }
export interface Runtime { root: string; commit: string; cli: string; readerCli: string }
export interface Project {
    root: string; cli: string; sourcePath: string; testPath: string; ownCommand: string;
    sourceEdit: string; testEdit: string;
    transcript: Array<{ argv: string[] } & CommandResult>;
}

export function environment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base, NO_COLOR: '1', GARDA_UPDATE_CHECK: '0' };
    for (const name of Object.keys(env)) if (/^(?:GIT_CONFIG_|NODE_TEST_)/iu.test(name)) delete env[name];
    // A spread environment is case-sensitive even on Windows. Keeping Path and
    // adding PATH loses Git when Node deduplicates the two names for spawn.
    const pathKey = Object.hasOwn(env, 'PATH') ? 'PATH' : Object.keys(env).find(key => key.toUpperCase() === 'PATH');
    const inheritedPath = pathKey ? env[pathKey] : undefined;
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
    env.PATH = [process.platform === 'win32' ? 'C:\\Windows\\System32' : '', inheritedPath].filter(Boolean).join(path.delimiter);
    return env;
}

export function command(executable: string, argv: string[], cwd: string, timeout = 60_000): CommandResult {
    const argumentsToRun = executable === 'git' ? ['-c', `safe.directory=${cwd.replace(/\\/gu, '/')}`, ...argv] : argv;
    const result = spawnSync(executable, argumentsToRun, { cwd, env: environment(), encoding: 'utf8',
        windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 });
    assert.ifError(result.error);
    return { code: result.status, output: `${result.stdout || ''}\n${result.stderr || ''}`.trim(), stdout: result.stdout || '' };
}

export function succeeds(result: CommandResult): void { assert.equal(result.code, 0, result.output); }

export function write(root: string, relative: string, contents: string): void {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
}

export function json(root: string, relative: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8')) as Record<string, unknown>;
}

export function sourceRoot(): string {
    let root = __dirname;
    while (!fs.existsSync(path.join(root, 'tsconfig.build.json'))) {
        const parent = path.dirname(root);
        assert.notEqual(parent, root, 'P4 source checkout not found');
        root = parent;
    }
    return root;
}

/** Export, never switch a checkout. Build the real version's publish runtime with existing dependencies. */
export function buildRuntime(parent: string, ref: string, candidate = false): Runtime {
    const source = sourceRoot();
    // A ref names a commit; a bare tree is accepted so CI can receive one historical version without its history.
    let commitResult = command('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], source);
    if (commitResult.code !== 0) commitResult = command('git', ['rev-parse', '--verify', `${ref}^{tree}`], source);
    succeeds(commitResult);
    const commit = commitResult.output.trim();
    const root = path.join(parent, candidate ? 'candidate' : `old-${commit.slice(0, 8)}`);
    fs.mkdirSync(root, { recursive: true });
    const archive = `${root}.tar`;
    succeeds(command('git', ['archive', '--format=tar', `--output=${archive}`, commit], source));
    succeeds(command('tar', ['-xf', archive, '-C', root], parent));
    fs.unlinkSync(archive);
    if (candidate) {
        // Phase 2 tests the merged working tree, including uncommitted product fixes.
        for (const relative of ['src', 'template', 'scripts', 'docs', 'README.md', 'HOW_TO.md', 'AGENT_INIT_PROMPT.md', 'package.json', 'VERSION']) {
            fs.cpSync(path.join(source, relative), path.join(root, relative), { recursive: true });
        }
    }
    fs.symlinkSync(path.join(source, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    succeeds(command(process.execPath, ['scripts/node-foundation/build-scripts.cjs', 'build.js', 'publish-runtime'], root, 180_000));
    write(root, 'p4-provenance.json', JSON.stringify({ ref, commit, candidate, node: process.version,
        note: candidate ? 'working source overlay; not a released artifact' : 'unmodified git archive; real publish-runtime build' }, null, 2));
    return { root, commit, cli: path.join(root, 'bin/garda.js'), readerCli: path.join(root, 'dist/src/cli/main.js') };
}

export function cli(project: Project, argv: string[], launcher = project.cli, timeout = 60_000): CommandResult {
    const result = command(process.execPath, [launcher, ...argv], project.root, timeout);
    project.transcript.push({ argv: [launcher, ...argv], ...result });
    write(project.root, 'p4-transcript.json', JSON.stringify(project.transcript, null, 2));
    return result;
}

export function gate(project: Project, name: string, args: string[] = [], launcher = project.cli): CommandResult {
    return cli(project, ['gate', name, '--task-id', TASK, '--repo-root', project.root, ...args], launcher);
}

/** Execute an actual navigator command without a shell or accidental delegation to the installed old CLI. */
export function follow(project: Project, text: string, launcher: string): CommandResult {
    const commands = parseCommandChain(text);
    assert.equal(commands.length, 1);
    const argv = commands[0];
    assert.match(path.basename(argv[0]), /^node(?:[.]exe)?$/iu);
    const normalize = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
    assert.equal(normalize(path.resolve(project.root, argv[1])), normalize(project.cli));
    const rootIndex = argv.indexOf('--repo-root');
    assert.ok(rootIndex >= 0, 'a followed gate must name its fixture repository');
    assert.equal(normalize(path.resolve(project.root, argv[rootIndex + 1])), normalize(project.root));
    assert.ok(argv.slice(2).every(arg => !/<[^>]+>/u.test(arg)), 'a followed recovery command must be executable without placeholders');
    return cli(project, argv.slice(2), launcher);
}

/** Only ordinary project inputs are seeded. No event, receipt, digest or gate artifact is fabricated. */
export function createProject(parent: string, old: Runtime, label: string, legacy = false, shape: 'node' | 'python' | 'opaque' = 'node'): Project {
    const root = fs.mkdtempSync(path.join(parent, `${label}-`));
    const bundle = path.join(root, BUNDLE);
    const pkg = json(old.root, 'package.json');
    for (const relative of pkg.files as string[]) {
        const input = path.join(old.root, relative);
        if (fs.existsSync(input)) fs.cpSync(input, path.join(bundle, relative), { recursive: true });
    }
    let sourcePath = 'src/total.cjs', testPath = 'tests/total.test.cjs', ownCommand = OWN_COMMAND;
    let sourceEdit = '// task implementation\n', testEdit = '// task regression\n';
    let compileCommand = 'node --check src/total.cjs';
    let broadArgv = ['--test', 'tests/total.test.cjs', 'tests/unrelated.test.cjs'];
    let broadExecutable = 'process.execPath';
    if (shape === 'node') {
        write(root, 'package.json', JSON.stringify({ name: 'p4-consumer', private: true, scripts: {
        test: BROAD_COMMAND, build: 'node --check src/total.cjs' } }, null, 2));
        write(root, sourcePath, 'exports.total = (a, b) => a + b;\n');
        write(root, testPath, "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\nconst fs = require('node:fs');\nconst { total } = require('../src/total.cjs');\ntest('own total', () => { fs.appendFileSync('.p4-own-runs', 'run\\n'); assert.equal(total(2, 3), 5); });\n");
        write(root, 'tests/unrelated.test.cjs', "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\ntest('unrelated legacy failure', () => assert.fail('pre-existing external failure'));\n");
    } else if (shape === 'python') {
        sourcePath = 'arithmetic/total.py'; testPath = 'tests/test_total.py';
        ownCommand = 'python -m unittest tests/test_total.py';
        sourceEdit = '# task implementation\n'; testEdit = '# task regression\n';
        compileCommand = 'python -m py_compile arithmetic/total.py';
        broadExecutable = "'python'"; broadArgv = ['-m', 'unittest', 'discover'];
        write(root, 'pyproject.toml', '[project]\nname = "p4-arithmetic"\nversion = "0.0.1"\n');
        write(root, 'arithmetic/__init__.py', ''); write(root, 'tests/__init__.py', '');
        write(root, sourcePath, 'def total(a, b):\n    return a + b\n');
        write(root, testPath, 'import unittest\nfrom arithmetic.total import total\nclass TotalTest(unittest.TestCase):\n    def test_total(self):\n        self.assertEqual(total(2, 3), 5)\n');
        write(root, 'tests/test_unrelated.py', 'import unittest\nclass UnrelatedTest(unittest.TestCase):\n    def test_failure(self):\n        self.fail("pre-existing external failure")\n');
    } else {
        sourcePath = 'lib/total.orbit'; testPath = 'specs/total.case';
        ownCommand = 'node tooling/orbit.cjs specs/total.case';
        sourceEdit = '# task implementation\n'; testEdit = '\n';
        compileCommand = 'node --check tooling/orbit.cjs';
        broadArgv = ['tooling/orbit.cjs', 'specs/unrelated.case'];
        write(root, sourcePath, 'operation=sum\n');
        write(root, testPath, JSON.stringify({ a: 2, b: 3, expected: 5 }));
        write(root, 'specs/unrelated.case', JSON.stringify({ a: 2, b: 3, expected: 0 }));
        write(root, 'tooling/orbit.cjs', "const fs=require('node:fs'),assert=require('node:assert/strict');\n"
            + "assert.match(fs.readFileSync('lib/total.orbit','utf8'), /^operation=sum$/m);\n"
            + "const test=JSON.parse(fs.readFileSync(process.argv[2],'utf8')); assert.equal(test.a+test.b,test.expected);\nconsole.log('Orbit assertion passed');\n");
    }
    write(root, 'scripts/legacy-broad.cjs', "const { spawnSync } = require('node:child_process');\n"
        + `const result = spawnSync(${broadExecutable}, ${JSON.stringify(broadArgv)}, { stdio: 'pipe' });\n`
        + "console.log('Legacy aggregate command completed; this runner does not attribute failures.');\nprocess.exitCode = result.status ?? 1;\n");
    write(root, '.gitignore', `${BUNDLE}/\nAGENTS.md\nTASK.md\np4-transcript.json\n.p4-own-runs\n__pycache__/\n`);
    const answers = `${BUNDLE}/runtime/init-answers.json`;
    write(root, answers, JSON.stringify({ AssistantLanguage: 'English', AssistantBrevity: 'concise', SourceOfTruth: 'Codex',
        EnforceNoAutoCommit: 'false', ClaudeOrchestratorFullAccess: 'false', TokenEconomyEnabled: 'true',
        CollectedVia: 'AGENT_INIT_PROMPT.md', ActiveAgentFiles: ['AGENTS.md'] }, null, 2));
    const project: Project = { root, cli: path.join(bundle, 'bin/garda.js'), sourcePath, testPath, ownCommand,
        sourceEdit, testEdit, transcript: [] };
    succeeds(cli(project, ['install', '--target-root', root, '--init-answers-path', path.join(root, answers)]));
    const heading = legacy ? '# Legacy project tasks\n\nUser notes must survive.\n\n' : '# TASK.md\n\n## Active Queue\n\n';
    write(root, 'TASK.md', heading + '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |\n'
        + '| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n'
        + `| ${TASK} | TODO | P1 | billing | Continue total | unassigned | 2026-11-05 | balanced | Preserve every field |\n`
        + '| T-HISTORY | 🟩 DONE | P2 | history | Closed historical task | agent:previous | 2026-11-04 | balanced | Do not reopen |\n');
    for (const args of [['init'], ['config', 'user.name', 'P4 fixture'], ['config', 'user.email', 'p4@example.invalid'],
        ['add', '.'], ['-c', 'commit.gpgsign=false', 'commit', '-m', 'ordinary project baseline']]) {
        succeeds(command('git', args, root));
    }
    succeeds(cli(project, ['workflow', 'set', '--target-root', root, '--compile-gate-command', compileCommand,
        '--full-suite-enabled', 'true', '--full-suite-command', BROAD_COMMAND,
        '--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString()]));
    return project;
}

export function enter(project: Project, launcher = project.cli): void {
    succeeds(gate(project, 'enter-task-mode', ['--entry-mode', 'EXPLICIT_TASK_EXECUTION', '--task-summary', 'Continue total',
        '--provider', 'Codex', '--routed-to', 'AGENTS.md', '--start-banner', 'Garda captures my mind',
        '--planned-changed-file', project.sourcePath, '--planned-changed-file', project.testPath], launcher));
}

export function prepare(project: Project): void {
    enter(project);
    succeeds(gate(project, 'load-rule-pack', ['--stage', 'TASK_ENTRY', ...[
        '00-core.md', '15-project-memory.md', '40-commands.md', '80-task-workflow.md', '90-skill-catalog.md'
    ].flatMap(file => ['--loaded-rule-file', file])]));
    succeeds(gate(project, 'handshake-diagnostics'));
    succeeds(gate(project, 'shell-smoke-preflight'));
    succeeds(gate(project, 'record-strict-decomposition-decision', ['--decision', 'atomic', '--task-profile', 'balanced', '--task-summary', 'Continue total',
        '--reason', 'The arithmetic source and its regression implement one bounded behavior in one coherent cycle.',
        '--scope-risk', 'One arithmetic behavior, one implementation file and its own test.',
        '--expected-review-type', 'code', '--expected-review-type', 'test', '--atomicity-constraint', 'Keep source and regression together.']));
    fs.appendFileSync(path.join(project.root, project.sourcePath), project.sourceEdit);
    fs.appendFileSync(path.join(project.root, project.testPath), project.testEdit);
    refresh(project);
}

export function refresh(project: Project, launcher = project.cli): void {
    succeeds(gate(project, 'classify-change', ['--task-intent', 'Continue total', '--changed-file', project.sourcePath,
        '--changed-file', project.testPath, '--output-path', PREFLIGHT], launcher));
    succeeds(gate(project, 'load-rule-pack', ['--stage', 'POST_PREFLIGHT', '--preflight-path', PREFLIGHT, ...[
        '00-core.md', '15-project-memory.md', '30-code-style.md', '35-strict-coding-rules.md', '40-commands.md',
        '50-structure-and-docs.md', '70-security.md', '80-task-workflow.md', '90-skill-catalog.md'
    ].flatMap(file => ['--loaded-rule-file', file])], launcher));
    quality(project, launcher);
}

export function navigate(project: Project, launcher = project.cli): Record<string, unknown> {
    let result = gate(project, 'next-step', ['--as-json'], launcher);
    succeeds(result);
    let next = JSON.parse(result.output) as Record<string, unknown>;
    for (let count = 0; next.next_gate === 'next-step-effect' && count < 4; count += 1) {
        const commands = next.commands as Array<{ command: string }>;
        const hash = /--effect-plan-sha256 "?([a-f0-9]{64})/u.exec(commands[0].command)?.[1];
        assert.ok(hash, 'native effect plan must supply its digest');
        result = gate(project, 'next-step', ['--as-json', '--execute-effects', '--effect-plan-sha256', hash], launcher);
        succeeds(result);
        next = JSON.parse(result.output) as Record<string, unknown>;
    }
    return next;
}

/** Fill ordinary self-check answers; the old native gate alone produces authenticated checklist evidence. */
export function quality(project: Project, launcher = project.cli): void {
    const next = navigate(project, launcher);
    const qualityState = next.quality_checklist as { answers_template_path: string };
    assert.ok(qualityState?.answers_template_path, 'old navigator must publish a checklist input path');
    const answersPath = path.resolve(project.root, qualityState.answers_template_path);
    const template = JSON.parse(fs.readFileSync(answersPath, 'utf8')) as { answers: Array<Record<string, unknown>> };
    template.answers = template.answers.map(answer => ({ ...answer, status: 'PASS',
        answer: `The arithmetic fixture uses one source function and its own regression; ${String(answer.rule_id)} adds no further work.`,
        evidence_files: [project.sourcePath, project.testPath], actions_taken: [], actions_required: [] }));
    fs.writeFileSync(answersPath, JSON.stringify(template, null, 2));
    succeeds(gate(project, 'quality-checklist', ['--preflight-path', PREFLIGHT, '--answers-path', answersPath], launcher));
}

export function select(project: Project, commandText = project.ownCommand, launcher = project.cli): CommandResult {
    return cli(project, ['workflow', 'set', '--target-root', project.root, '--task-id', TASK,
        '--full-suite-command', commandText, '--focused-required-test-path', project.testPath,
        '--reason', `${TASK} verifies total in ${project.sourcePath} against ${project.testPath}`], launcher);
}

export function events(project: Project): Array<Record<string, unknown>> {
    return fs.readFileSync(path.join(project.root, BUNDLE, `runtime/task-events/${TASK}.jsonl`), 'utf8')
        .trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}

export function ownRunCount(project: Project): number {
    const marker = path.join(project.root, '.p4-own-runs');
    return fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).length : 0;
}

export function retainedBytes(project: Project): Map<string, Buffer> {
    const retained = new Map<string, Buffer>();
    const audit = path.join(project.root, BUNDLE, 'runtime/workflow-config-audit.jsonl');
    if (fs.existsSync(audit)) retained.set(path.relative(project.root, audit), fs.readFileSync(audit));
    for (const relative of ['runtime/task-events', 'runtime/reviews', 'runtime/tmp/reviews']) {
        const root = path.join(project.root, BUNDLE, relative);
        if (!fs.existsSync(root)) continue;
        for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
            if (entry.isFile()) {
                const file = path.join(entry.parentPath, entry.name);
                retained.set(path.relative(project.root, file), fs.readFileSync(file));
            }
        }
    }
    return retained;
}

export function assertRetained(project: Project, before: Map<string, Buffer>, appendTimeline = false): void {
    for (const [relative, bytes] of before) {
        const after = fs.readFileSync(path.join(project.root, relative));
        if (appendTimeline && relative.endsWith('.jsonl')) assert.deepEqual(after.subarray(0, bytes.length), bytes, relative);
        else assert.deepEqual(after, bytes, relative);
    }
}

export function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }

export function tempRoot(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'garda-p4-')); }

/** Pack built publication files locally; no install, registry access or lifecycle scripts. */
export function packRuntime(parent: string, runtime: Runtime): Runtime {
    const npmCli = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    if (process.platform === 'win32') assert.ok(fs.existsSync(npmCli), `npm CLI unavailable for focused pack: ${npmCli}`);
    const packArgs = ['pack', '--offline', '--ignore-scripts', '--json',
        '--cache', path.join(parent, 'npm-cache'), '--pack-destination', parent];
    const result = process.platform === 'win32' ? command(process.execPath, [npmCli, ...packArgs], runtime.root, 120_000)
        : command('npm', packArgs, runtime.root, 120_000);
    succeeds(result);
    const packed = JSON.parse(result.stdout) as Array<{ filename: string; integrity: string }>;
    const tarball = path.join(parent, packed[0].filename);
    const extracted = path.join(parent, 'packed');
    fs.mkdirSync(extracted);
    succeeds(command('tar', ['-xf', tarball, '-C', extracted], parent));
    const root = path.join(extracted, 'package');
    assert.ok(!fs.existsSync(path.join(root, 'src')), 'source checkout must not substitute for the published package');
    write(parent, 'p4-package.json', JSON.stringify({ commit: runtime.commit, filename: packed[0].filename,
        integrity: packed[0].integrity, sha256: digest(fs.readFileSync(tarball)) }, null, 2));
    return { ...runtime, root, cli: path.join(root, 'bin/garda.js'), readerCli: path.join(root, 'dist/src/cli/main.js') };
}

export function upgrade(project: Project, runtime: Runtime): CommandResult {
    return cli(project, ['update', '--target-root', project.root, '--init-answers-path',
        `${BUNDLE}/runtime/init-answers.json`, '--source-path', runtime.root, '--trust-override', '--no-prompt'], project.cli, 240_000);
}

/** A real lifecycle runs until the injection point. Never manufacture a sentinel or rollback manifest. */
export function interruptUpdate(project: Project, runtime: Runtime, mode: 'throw' | 'exit'): CommandResult {
    const worker = path.join(path.dirname(project.root), `p4-${mode}-worker.cjs`);
    fs.writeFileSync(worker, [
        `const { runUpdate } = require(${JSON.stringify(path.join(runtime.root, 'dist/src/lifecycle/update.js'))});`,
        `try { runUpdate({ targetRoot: ${JSON.stringify(project.root)}, bundleRoot: ${JSON.stringify(path.join(project.root, BUNDLE))},`,
        `initAnswersPath: ${JSON.stringify(path.join(project.root, BUNDLE, 'runtime/init-answers.json'))},`,
        `contractMigrationRunner() { ${mode === 'exit' ? 'process.exit(17);' : "throw new Error('P4 interruption after real materialization');"} } }); }`,
        "catch (error) { console.error(String(error)); process.exitCode = 19; }"
    ].join('\n'));
    return command(process.execPath, [worker], project.root, 240_000);
}

export async function review(project: Project, lane: 'code' | 'test', verdict: 'PASS' | 'FAIL'): Promise<CommandResult> {
    const contextPath = `${BUNDLE}/runtime/reviews/${TASK}-${lane}-review-context.json`;
    const launchPath = `${BUNDLE}/runtime/tmp/reviews/${TASK}/${lane}/reviewer-launch.json`;
    succeeds(cli(project, ['gate', 'build-review-context', '--repo-root', project.root, '--review-type', lane,
        '--depth', '2', '--preflight-path', PREFLIGHT]));
    const common = ['--review-type', lane, '--review-context-path', contextPath, '--reviewer-execution-mode', 'delegated_subagent'];
    succeeds(gate(project, 'record-review-routing', common));
    succeeds(gate(project, 'prepare-reviewer-launch', [...common, '--reviewer-launch-artifact-path', launchPath]));
    const launch = json(project.root, launchPath);
    const inputPath = String(launch.reviewer_launch_input_artifact_path);
    const inputHash = digest(fs.readFileSync(path.resolve(project.root, inputPath)));
    const outputPath = path.resolve(project.root, String(launch.review_output_path));
    const worker = spawn(process.execPath, [path.join(__dirname, 'p4-review-process.js'), path.resolve(project.root, inputPath), verdict], {
        cwd: project.root, env: environment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let workerOutput = '';
    worker.stdout.on('data', data => { workerOutput += String(data); });
    worker.stderr.on('data', data => { workerOutput += String(data); });
    const finished = new Promise<number | null>((resolve, reject) => { worker.once('error', reject); worker.once('exit', resolve); });
    assert.ok(worker.pid);
    const identity = `agent:p4-process-${worker.pid}`;
    const started = [...common, '--reviewer-identity', identity, '--reviewer-launch-artifact-path', launchPath,
        '--provider-invocation-id', `p4-process-${worker.pid}`, '--attestation-source', 'p4-controlled-process-provider',
        '--launch-input-mode', 'launch_artifact_path', '--launch-input-artifact-path', inputPath,
        '--launch-input-sha256', inputHash, '--fork-context', 'false'];
    try {
        succeeds(gate(project, 'record-reviewer-delegation-started', started));
        worker.stdin.end('review\n');
        assert.equal(await finished, 0, workerOutput);
        succeeds(gate(project, 'complete-reviewer-launch', [...started, '--record-invocation']));
        return gate(project, 'record-review-result', ['--review-type', lane, '--preflight-path', PREFLIGHT,
            '--review-output-path', outputPath, '--reviewer-execution-mode', 'delegated_subagent', '--reviewer-identity', identity]);
    } finally {
        if (worker.exitCode === null) worker.kill();
        await finished;
    }
}
