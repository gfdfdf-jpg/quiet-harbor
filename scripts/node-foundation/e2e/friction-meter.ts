import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import { buildPublishRuntime, getRepoRoot } from '../build';
import { buildGitignoreEntries, syncManagedGitignoreBlockInContent } from '../../../src/materialization/content-builders';

interface Navigation {
    status: string;
    next_gate?: string;
    reason?: string;
    commands: Array<{ command: string }>;
    recommended_action?: { mode: 'advance'; command: string };
    quality_checklist?: { answers_template_path?: string };
}

interface CommandRecord {
    phase: string;
    command: string;
    exit_code: number | null;
    duration_ms: number;
}

/** navigator: discovers composites exclusively from the navigator answer, then queries again at every stop. */
export type MeterMode = 'individual' | 'composite' | 'navigator';

interface CompositeRun {
    outcome: string;
    completed: Array<{ gate: string }>;
    stop: { kind: string } | null;
    next: Navigation | null;
    counters: { subgates_succeeded: number };
}

interface FixtureReport {
    fixture: string;
    mode: MeterMode;
    commands_executed: number;
    /** Gates a composite command ran inside one invocation; they are evidence, not hidden work. */
    internal_subgates_executed: number;
    commands: CommandRecord[];
    dead_ends_count: number;
    dead_ends: Array<{ gate: string; reason: string; instruction_output: string }>;
    preflight_refreshes: number;
    task_resets: number;
    wall_time_ms: number;
    last_gate_reached: string;
    stop_reason: 'reviewer_boundary' | 'blocked' | 'command_failed' | 'step_limit';
    stop_instruction?: string;
    blocked_reason?: string;
    failure?: string;
}

export interface MeterOptions {
    fixtures: string[];
    outputPath: string;
    baselineRef?: string;
    mode?: MeterMode;
}

const TASK_ID = 'T-FRICTION';
const BUNDLE = 'garda-agent-orchestrator';
const COMMAND_TIMEOUT_MS = 180_000;
const MAX_NAVIGATION_STEPS = 80;
const DIAGNOSTIC_MAX_CHARS = 4000;
const TRUST_BOUNDARY_RULE_ID = 'trust_boundary_adversarial_analysis';
const QUALITY_ANSWERS: Readonly<Record<string, string>> = {
    code_simplification: 'Only one source comment changes; no executable behavior is introduced.',
    project_style_fit: 'The probe uses the existing source file and its native comment syntax.',
    unnecessary_abstraction: 'The source comment adds no abstraction or dependency.',
    size_growth: 'The source file grows by one comment; no function or class grows.',
    hardcoded_values_contracts: 'The measurement marker is a comment, not a runtime value or public contract.',
    duplicated_logic_contracts: 'The comment introduces no duplicated executable logic or contract.',
    test_verification_scope: 'Portable fixture stubs measure orchestration only; they do not validate the fixture language or source behavior.'
};

export function isDeadEnd(navigation: Pick<Navigation, 'status' | 'commands'>, humanOutput: string): boolean {
    // The compact answer (`Commands: none`) names the instruction as `Instruction:`; its `Next:` line is the title.
    // The full text and older navigators print the instruction as `Next:` under `Command: none`.
    const instruction = /^Commands: none$/mu.test(humanOutput) ? /^Instruction:\s*\S/mu : /^\s*Next:\s*\S/mu;
    return navigation.status === 'BLOCKED' && navigation.commands.length === 0
        && !instruction.test(humanOutput);
}

function execute(command: string, args: string[], cwd: string, phase: string, records?: CommandRecord[]) {
    const started = performance.now();
    // 1.4.4 classifies even local-source setup as network-sensitive; no source override is passed below.
    const environment: NodeJS.ProcessEnv = { ...process.env, GARDA_EXECUTION_PROVIDER: 'Codex',
        GARDA_OFFLINE: phase === 'setup' ? '0' : '1', GARDA_UPDATE_CHECK: '0' };
    delete environment.NODE_TEST_CONTEXT;
    const result = spawnSync(command, args, {
        cwd, encoding: 'utf8', windowsHide: true, env: environment,
        timeout: COMMAND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024
    });
    records?.push({ phase, command: [command, ...args].map(value => JSON.stringify(value)).join(' '),
        exit_code: result.status, duration_ms: Math.round(performance.now() - started) });
    if (result.error || result.status !== 0) {
        throw new Error(`${phase}: ${result.error?.message || `exit ${result.status}, signal ${result.signal}`}\n`
            + `${result.stderr}\n${result.stdout}`.slice(-DIAGNOSTIC_MAX_CHARS));
    }
    return result.stdout;
}

function tokenizeCommand(command: string): string[] {
    const tokens = [...command.matchAll(/"([^"\r\n]*)"|([^\s"]+)/gu)].map(match => match[1] ?? match[2]);
    if (tokens[0] !== 'node' || !tokens[1]?.endsWith('/bin/garda.js')
        || tokens.some(token => /[<>|;&`\r\n]/u.test(token))) {
        throw new Error(`Unsupported navigator command: ${command}`);
    }
    return tokens.slice(1);
}

function writeJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

/** The fixture source the probe edits and the fixture test that covers it, both from stack-fixture.json. */
interface FixtureFiles {
    source: string;
    test: string;
}

function readFixtureFile(fixtureRoot: string, name: string, manifest: Record<string, unknown>, key: keyof FixtureFiles): string {
    const value = manifest[key];
    if (typeof value !== 'string' || path.isAbsolute(value)
        || value.split(/[\\/]/u).includes('..') || !fs.statSync(path.join(fixtureRoot, value)).isFile()) {
        throw new Error(`Invalid ${key} in ${name}/stack-fixture.json`);
    }
    return value;
}

function resolveFixtureSource(repoRoot: string, name: string): { fixtureRoot: string } & FixtureFiles {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(name)) throw new Error(`Invalid fixture name: ${name}`);
    const fixtureRoot = path.join(repoRoot, 'tests', 'fixtures', 'stacks', name);
    const manifest = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'stack-fixture.json'), 'utf8')) as Record<string, unknown>;
    return { fixtureRoot, source: readFixtureFile(fixtureRoot, name, manifest, 'source'),
        test: readFixtureFile(fixtureRoot, name, manifest, 'test') };
}

function initializeFixture(repoRoot: string, root: string, name: string, records: CommandRecord[]): FixtureFiles {
    const { fixtureRoot, source, test } = resolveFixtureSource(repoRoot, name);
    fs.cpSync(fixtureRoot, root, { recursive: true });
    fs.rmSync(path.join(root, 'stack-fixture.json'));
    fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tools', 'friction-check.cjs'),
        'if (!["compile", "suite"].includes(process.argv[2])) throw new Error("Unknown stub action");\n'
        + 'console.log("FRICTION_STUB_OK " + process.argv[2]);\n');
    fs.writeFileSync(path.join(root, 'README.md'), '# Friction measurement fixture\n\n'
        + `Source probe: ${source}. Compile: node tools/friction-check.cjs compile. `
        + 'Suite: node tools/friction-check.cjs suite. These portable stubs measure orchestration only.\n');
    const ignorePath = path.join(root, '.gitignore');
    const ignoreBefore = (fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, 'utf8') : '') + '\n.vscode/\n';
    fs.writeFileSync(ignorePath, syncManagedGitignoreBlockInContent(ignoreBefore,
        buildGitignoreEntries(['AGENTS.md'], [], false, false, true), false).content);
    const git = (args: string[]) => execute('git', args, root, 'fixture_git', records);
    git(['init', '--quiet']);
    git(['config', 'user.name', 'Garda Friction Fixture']);
    git(['config', 'user.email', 'friction@example.invalid']);
    git(['config', 'commit.gpgsign', 'false']);
    git(['config', 'core.autocrlf', 'false']);
    git(['add', '.']);
    git(['commit', '--quiet', '-m', 'Seed friction fixture']);
    execute(process.execPath, [path.join(repoRoot, 'bin', 'garda.js'), 'setup', '--target-root', root,
        '--no-prompt', '--source-of-truth', 'Codex', '--assistant-language', 'English',
        '--active-agent-files', 'AGENTS.md'], root, 'setup', records);
    return { source, test };
}

function configureFixture(root: string, records: CommandRecord[]): void {
    const cli = path.join(root, BUNDLE, 'bin', 'garda.js');
    execute(process.execPath, [cli, 'workflow', 'set', '--target-root', '.',
        '--compile-gate-command', 'node tools/friction-check.cjs compile',
        '--full-suite-command', 'node tools/friction-check.cjs suite', '--full-suite-enabled', 'true',
        '--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString()], root, 'configure', records);
    const memoryRoot = path.join(root, BUNDLE, 'live', 'docs', 'project-memory');
    for (const name of fs.readdirSync(memoryRoot).filter(name => name.endsWith('.md'))) {
        fs.writeFileSync(path.join(memoryRoot, name), '# Friction fixture project map\n\n'
            + 'This isolated stack fixture measures Garda ceremony for a source comment. '
            + 'Compile and tests intentionally run the tracked portable tools/friction-check.cjs stub. '
            + 'No language toolchain, network, real review, or application correctness claim is involved.\n');
    }
    execute(process.execPath, [cli, 'agent-init', '--target-root', '.', '--active-agent-files', 'AGENTS.md',
        '--project-rules-updated', 'yes', '--skills-prompted', 'yes', '--ordinary-doc-paths', 'README.md'], root, 'agent_init', records);
    fs.writeFileSync(path.join(root, 'TASK.md'), '# TASK.md\n\n## Active Queue\n\n'
        + '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |\n'
        + '|---|---|---|---|---|---|---|---|---|\n'
        + `| ${TASK_ID} | TODO | P2 | fixture | Add a source comment | fixture | 2026-10-23 | balanced | Friction measurement: stop before reviewer launch. |\n`);
    const pending = execute('git', ['status', '--porcelain=v1'], root, 'fixture_git', records);
    if (pending.trim()) throw new Error('Fixture bootstrap must leave a clean project tree: ' + pending);
}

function fillQualityAnswers(root: string, navigation: Navigation, files: FixtureFiles): string[] | null {
    const candidate = navigation.quality_checklist?.answers_template_path;
    if (!candidate) return null;
    const answersPath = path.resolve(root, candidate);
    const relative = path.relative(path.join(root, BUNDLE, 'runtime'), answersPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Checklist path escaped fixture runtime');
    const template = JSON.parse(fs.readFileSync(answersPath, 'utf8')) as {
        answers: Array<{ rule_id: string; status: string; answer: string; trust_boundary_matrix?: unknown }>;
    };
    const trustBoundary = buildTrustBoundaryAnswer(root, files);
    const unanswered = template.answers
        .filter(answer => !QUALITY_ANSWERS[answer.rule_id] && !(answer.rule_id === TRUST_BOUNDARY_RULE_ID && trustBoundary))
        .map(answer => answer.rule_id);
    if (unanswered.length) return unanswered;
    for (const answer of template.answers) {
        answer.status = 'PASS';
        if (answer.rule_id === TRUST_BOUNDARY_RULE_ID && trustBoundary) {
            answer.answer = trustBoundary.answer;
            answer.trust_boundary_matrix = trustBoundary.matrix;
        } else {
            answer.answer = QUALITY_ANSWERS[answer.rule_id];
        }
    }
    writeJson(answersPath, template);
    return [];
}

/**
 * The first named test case of the fixture test and the real command that runs only that case. Only pytest cases
 * are supported: a cited case must really run, so a stack without a runnable named case gets no answer.
 */
function readFixtureTestCase(root: string, files: FixtureFiles): { caseId: string; selector: string; command: string } | null {
    const caseId = /^\s*def\s+(test_\w+)\s*\(/mu.exec(fs.readFileSync(path.join(root, files.test), 'utf8'))?.[1];
    if (!caseId || !files.test.endsWith('.py')) return null;
    const selector = `${files.test}::${caseId}`;
    return { caseId, selector, command: `python -m pytest -q ${selector}` };
}

/** Records the real run of the cited case, as the navigator asks after the trust-boundary matrix is bound. */
function runFixtureCaseCheck(root: string, files: FixtureFiles, report: FixtureReport): boolean {
    const testCase = readFixtureTestCase(root, files);
    if (!testCase) return false;
    execute(process.execPath, [path.join(BUNDLE, 'bin', 'garda.js'), 'gate', 'run-intermediate-command', '--task-id', TASK_ID,
        '--command-source', 'targeted-test', '--command', testCase.command,
        '--preflight-path', `${BUNDLE}/runtime/reviews/${TASK_ID}-preflight.json`,
        '--selected-case', JSON.stringify({ source: files.test, case_id: testCase.caseId, selector: testCase.selector }),
        '--repo-root', '.'], root, 'run-intermediate-command', report.commands);
    return true;
}

/**
 * A sensitive fixture path (billing) makes the trust-boundary rule active. The probe adds only a comment, so the
 * matrix records that boundary as unchanged and cites the existing fixture test case as its regression evidence.
 */
function buildTrustBoundaryAnswer(root: string, files: FixtureFiles): { answer: string; matrix: unknown[] } | null {
    const testCase = readFixtureTestCase(root, files);
    if (!testCase) return null;
    return {
        answer: `The probe adds one comment to ${files.source}; no input, authority or evidence handling changes.`,
        matrix: [{
            boundary_id: 'fixture-source-comment',
            boundary: `${files.source} behavior across a comment-only edit`,
            authority_source: 'The fixture source committed in the measurement repository',
            mutable_inputs: [`comment line appended to ${files.source}`],
            integrity_evidence: ['git diff of the fixture repository shows one added comment line'],
            canonical_reconstruction: 'Removing the comment line restores the committed fixture source byte for byte.',
            toctou_replay: 'No runtime state, credential or artifact is read or written by the change.',
            negative_paths: [{
                kind: 'other',
                scenario: 'A comment-only edit must not change the computed result',
                expected_behavior: 'The existing fixture test case still passes',
                evidence_files: [`${files.test}#${testCase.caseId}`]
            }]
        }]
    };
}

function prepareCommand(navigation: Navigation, root: string, files: FixtureFiles): string[] {
    if (navigation.next_gate === 'record-strict-decomposition-decision') {
        return [path.join(BUNDLE, 'bin', 'garda.js'), 'gate', 'record-strict-decomposition-decision',
            '--task-id', TASK_ID, '--decision', 'atomic', '--task-profile', 'balanced',
            '--task-summary', 'Add a source comment', '--reason', 'One comment in one fixture source file.',
            '--scope-risk', 'No runtime behavior changes.', '--expected-review-type', 'code',
            '--atomicity-constraint', 'One source file only.', '--repo-root', '.'];
    }
    if (navigation.next_gate === 'task-test-selection') {
        // The task tests are the fixture test, run through the same portable suite stub as the project command.
        return [path.join(BUNDLE, 'bin', 'garda.js'), 'workflow', 'set', '--task-id', TASK_ID,
            '--task-test-command', `node tools/friction-check.cjs suite ${files.test}`, '--focused-required-test-path', files.test,
            '--reason', `${TASK_ID} verifies ${files.source}: regression ${files.test} covers ${files.source}`, '--target-root', '.'];
    }
    const args = tokenizeCommand(navigation.commands[0].command);
    if (navigation.next_gate === 'enter-task-mode') args.push('--planned-changed-file', files.source);
    for (let index = 0; index < args.length - 1; index++) {
        if (args[index] === '--loaded-rule-file') fs.readFileSync(path.resolve(root, args[index + 1]), 'utf8');
    }
    return args;
}

function runComposite(root: string, args: string[], report: FixtureReport): CompositeRun {
    const cli = path.join(BUNDLE, 'bin', 'garda.js');
    const run = JSON.parse(execute(process.execPath, [cli, 'task', TASK_ID, ...args, '--as-json'], root,
        `composite_${args[0]}`, report.commands)) as CompositeRun;
    report.internal_subgates_executed += run.counters.subgates_succeeded;
    return run;
}

/**
 * Composite mode works like an agent using task start/advance: advance runs the mechanical steps, its stop names the
 * next action, and the agent asks the navigator only when that stop carries no command. Every agent action (a printed
 * command, the implementation or the checklist answers) is followed by advance instead of a navigator query.
 */
function navigateFixture(root: string, files: FixtureFiles, report: FixtureReport): void {
    const cli = path.join(BUNDLE, 'bin', 'garda.js');
    const source = files.source;
    const composite = report.mode === 'composite';
    let implemented = false;
    let preflights = 0;
    let pending: Navigation | null = null;
    let advanceNext = false;
    const recordComposite = (args: string[]): void => {
        const run = runComposite(root, args, report);
        // Same count as the individual mode: classifications after the first one.
        for (const completed of run.completed) {
            if (completed.gate === 'classify-change') report.preflight_refreshes = preflights++;
        }
        pending = run.next?.commands.length ? run.next : null;
    };
    for (let step = 0; step < MAX_NAVIGATION_STEPS; step++) {
        if (advanceNext) {
            advanceNext = false;
            recordComposite(['advance']);
            continue;
        }
        const namedByComposite: Navigation | null = pending;
        pending = null;
        const navigation: Navigation = namedByComposite ?? JSON.parse(execute(process.execPath,
            [cli, 'next-step', TASK_ID, '--repo-root', '.', '--as-json'], root, 'navigator', report.commands)) as Navigation;
        report.last_gate_reached = navigation.next_gate || 'none';
        if (report.mode === 'navigator' && navigation.recommended_action) {
            const args = tokenizeCommand(navigation.recommended_action.command);
            const run = JSON.parse(execute(process.execPath, [...args, '--as-json'], root,
                'navigator_composite', report.commands)) as CompositeRun;
            report.internal_subgates_executed += run.counters.subgates_succeeded;
            for (const completed of run.completed) {
                if (completed.gate === 'classify-change') report.preflight_refreshes = preflights++;
            }
            // The stop points back to the navigator for instructions/artifacts; do not guess another advance.
            continue;
        }
        if (['prepare-reviewer-launch', 'record-reviewer-delegation-started'].includes(report.last_gate_reached)) {
            report.stop_reason = 'reviewer_boundary';
            return;
        }
        if (navigation.commands.length === 0) {
            const human = execute(process.execPath, [cli, 'next-step', TASK_ID, '--repo-root', '.'], root, 'instructions', report.commands);
            if (isDeadEnd(navigation, human)) {
                report.dead_ends.push({ gate: report.last_gate_reached, reason: navigation.reason || '',
                    instruction_output: human.slice(0, DIAGNOSTIC_MAX_CHARS) });
            }
            if (navigation.next_gate === 'quality-checklist') {
                const unanswered = fillQualityAnswers(root, navigation, files);
                if (unanswered?.length === 0) {
                    advanceNext = composite;
                    continue;
                }
                report.blocked_reason = unanswered
                    ? 'No deterministic fixture answer for: ' + unanswered.join(', ')
                    : 'The navigator did not supply an editable quality answers file.';
            }
            if (navigation.next_gate === 'run-intermediate-command' && runFixtureCaseCheck(root, files, report)) {
                advanceNext = composite;
                continue;
            }
            if (['implementation', 'materialize-planned-scope'].includes(report.last_gate_reached) && !implemented) {
                const comment = source.endsWith('.rs') ? '// Friction measurement probe.' : '# Friction measurement probe.';
                fs.appendFileSync(path.join(root, source), '\n' + comment + '\n');
                implemented = true;
                advanceNext = composite;
                continue;
            }
            report.stop_instruction = human.slice(0, DIAGNOSTIC_MAX_CHARS);
            report.stop_reason = 'blocked';
            return;
        }
        if (navigation.commands.length !== 1) throw new Error('Navigator emitted more than one command');
        if (navigation.next_gate === 'task-reset') {
            report.stop_reason = 'blocked';
            return;
        }
        // A navigator answer may name a mechanical step; a composite stop never does, so its action is the agent's.
        if (composite && !namedByComposite && navigation.next_gate !== 'record-strict-decomposition-decision') {
            recordComposite(navigation.next_gate === 'enter-task-mode'
                ? ['start', '--provider', 'Codex', '--planned-changed-file', source] : ['advance']);
            continue;
        }
        const args = prepareCommand(navigation, root, files);
        execute(process.execPath, args, root, report.last_gate_reached, report.commands);
        if (navigation.next_gate === 'classify-change') report.preflight_refreshes = preflights++;
        advanceNext = composite;
    }
    report.stop_reason = 'step_limit';
}

/** One fixture measured against the runtime built from this checkout; measureFriction adds the commit binding. */
export function measureFixture(repoRoot: string, name: string, mode: MeterMode): FixtureReport {
    const started = performance.now();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-friction-'));
    const report: FixtureReport = { fixture: name, mode, commands_executed: 0, internal_subgates_executed: 0, commands: [],
        dead_ends_count: 0,
        dead_ends: [], preflight_refreshes: 0, task_resets: 0, wall_time_ms: 0,
        last_gate_reached: 'setup', stop_reason: 'blocked' };
    try {
        const files = initializeFixture(repoRoot, root, name, report.commands);
        configureFixture(root, report.commands);
        navigateFixture(root, files, report);
    } catch (error) {
        report.stop_reason = 'command_failed';
        report.failure = error instanceof Error ? error.message : String(error);
    } finally {
        report.commands_executed = report.commands.length;
        report.dead_ends_count = report.dead_ends.length;
        report.wall_time_ms = Math.round(performance.now() - started);
        removeTemporaryFixture(root);
    }
    return report;
}

function removeTemporaryFixture(root: string): void {
    const relative = path.relative(os.tmpdir(), root);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe fixture cleanup path');
    fs.rmSync(root, { recursive: true, force: true });
}

/** Binds a measurement to the checked-out commit: the baseline must be HEAD and every runtime input must match it. */
export function assertCommitBoundRuntime(repoRoot: string, baselineRef?: string): string {
    const runtimeCommit = execute('git', ['rev-parse', 'HEAD'], repoRoot, 'runtime_identity').trim();
    if (baselineRef) {
        const expected = execute('git', ['rev-parse', '--verify', baselineRef + '^{commit}'], repoRoot, 'baseline_identity').trim();
        if (expected !== runtimeCommit) throw new Error(`Baseline ${expected} does not match checked-out HEAD ${runtimeCommit}`);
    }
    execute('git', ['diff', '--exit-code', runtimeCommit, '--', 'src', 'template', 'bin', 'config',
        'package.json', 'package-lock.json', 'VERSION', 'tsconfig.build.json'], repoRoot, 'runtime_source');
    const newRuntimeFiles = execute('git', ['ls-files', '--others', '--exclude-standard', '--', 'src', 'template', 'bin', 'config'],
        repoRoot, 'runtime_source');
    if (newRuntimeFiles.trim()) throw new Error('Untracked runtime inputs prevent a commit-bound measurement: ' + newRuntimeFiles);
    return runtimeCommit;
}

export function measureFriction(options: MeterOptions) {
    if (!options.fixtures.length) throw new Error('At least one fixture is required');
    const repoRoot = getRepoRoot();
    for (const name of options.fixtures) resolveFixtureSource(repoRoot, name);
    return writeFrictionReport(repoRoot, assertCommitBoundRuntime(repoRoot, options.baselineRef), options);
}

/** Measures and writes the report for an already commit-bound runtime; callers own the binding check. */
export function writeFrictionReport(repoRoot: string, runtimeCommit: string, options: MeterOptions) {
    buildPublishRuntime();
    const report = { schema_version: 1, generated_utc: new Date().toISOString(), runtime_commit: runtimeCommit,
        runtime_version: fs.readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim(),
        node_version: process.version, platform: process.platform,
        measurement_boundary: 'Before the first delegated reviewer launch; compile and suite use portable stubs.',
        mode: options.mode ?? 'individual',
        command_counting: 'Top-level Git and CLI invocations per fixture, including setup and navigator queries; child processes inside gates are not counted separately. '
            + 'internal_subgates_executed counts the gates task start/advance ran inside one invocation.',
        fixtures: options.fixtures.map(name => measureFixture(repoRoot, name, options.mode ?? 'individual')) };
    writeJson(path.resolve(options.outputPath), report);
    return report;
}

function main(args: string[]): void {
    const values = new Map<string, string>();
    for (let index = 0; index < args.length; index += 2) {
        const key = args[index];
        if (!['--fixtures', '--output', '--baseline-ref', '--mode'].includes(key) || !args[index + 1] || values.has(key)) {
            throw new Error('Usage: friction-meter.js --fixtures python,rust,unknown-nim --output e2e-friction-report.json '
                + '[--baseline-ref COMMIT] [--mode individual|composite|navigator]');
        }
        values.set(key, args[index + 1]);
    }
    const mode = values.get('--mode') || 'individual';
    if (mode !== 'individual' && mode !== 'composite' && mode !== 'navigator') throw new Error(`Unknown --mode: ${mode}`);
    const report = measureFriction({ fixtures: (values.get('--fixtures') || 'python,rust,unknown-nim').split(','),
        outputPath: values.get('--output') || 'e2e-friction-report.json', baselineRef: values.get('--baseline-ref'), mode });
    for (const fixture of report.fixtures) {
        console.log(JSON.stringify({ fixture: fixture.fixture, mode: fixture.mode, commands: fixture.commands_executed,
            internal_subgates: fixture.internal_subgates_executed,
            dead_ends: fixture.dead_ends_count, last_gate: fixture.last_gate_reached, stop_reason: fixture.stop_reason,
            ...(fixture.failure ? { failure: fixture.failure } : {}) }));
    }
    if (report.fixtures.some(fixture => ['command_failed', 'step_limit'].includes(fixture.stop_reason))) process.exitCode = 1;
}

if (require.main === module) main(process.argv.slice(2));
