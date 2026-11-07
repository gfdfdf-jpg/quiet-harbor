/**
 * Product contract: real temporary Git repositories, public CLI and native gates.
 * Deliberately independent of the synthetic walk engine and its fixtures.
 * The tour's compile/RED/checklist/focused/closeout routes depend on universal-fallbacks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildDefaultWorkflowConfig } from '../../../src/core/workflow-config';
import { writeProtectedControlPlaneManifest } from '../../../src/gates/shared/helpers';
import { resolveNextStep } from '../../../src/gates/next-step/next-step';
import { buildFullSuiteValidationEvidence } from '../../../src/gates/review-context/review-context-validation-evidence';
import { fileSha256 } from '../../../src/gate-runtime/hash';
import { collectFullSuiteValidationEvidence } from '../../../src/gates/completion/completion-full-suite-evidence';
import { collectOrderedTimelineEvents } from '../../../src/gates/completion/completion-evidence';
import { readTaskTimelineJsonlEntries } from '../../../src/gate-runtime/task-events';
import { UNCONFIGURED_COMPILE_GATE_COMMAND } from '../../../src/core/constants';
import { parseCommandChain } from '../../../src/core/command-line';
import { UPDATE_CHECK_OPT_OUT_ENV } from '../../../src/lifecycle/update-availability/update-availability-types';
import { getProjectDiscovery } from '../../../src/materialization/project-discovery';
import { buildSharedStartTaskWorkflowContent } from '../../../src/materialization/content-builders/content-builders-provider-bridges';
import { buildQualityChecklistAnswersTemplate } from '../../../src/gates/quality-checklist';
import { TRUST_BOUNDARY_ANALYSIS_RULE_ID } from '../../../src/core/trust-boundary-analysis';
import { validationDigest } from '../../../src/core/project-validation-identity';
import { isPlainRecord } from '../../../src/core/records';
import { retainedNativeCaseOutput } from '../../../src/gates/review/native-case-semantics';
import type { ReviewCoverageContract } from '../../../src/gates/review/review-coverage-ledger';
import { GATE_COMMANDS } from '../../../src/compat/shim-registry';
import { loadTaskFullSuiteConfig } from '../../../src/gates/full-suite/task-full-suite-config';
import { parseCanonicalActiveTaskQueue } from '../../../src/core/task-md-table';
import { buildNoFindingsJsonReviewReport } from '../cli/commands/gates/review-result/gates-command-review-result-fixtures';
import { createTempRepo, initializeGitRepo, loadTaskEntryRulePack, loadPostPreflightRulePack,
    runEnterTaskMode, runHandshakeForTask, runShellSmokeForTask, runClassifyChangeCommand,
    seedInitAnswers, writeBalancedProfilesConfig, runCliWithCapturedOutput, removeTempRepoWithRetry } from '../cli/commands/gate-test-helpers';

const TASK = 'T-STACK-CONTRACT';
// Adding a validation/build route requires an explicit owner and an exercised route here.
export const VALIDATION_GATE_TOUR = {
    discovery: 'universal-fallbacks', 'compile-gate': 'universal-fallbacks',
    'task-test-selection': 'universal-core', 'full-suite-validation': 'universal-core',
    'test-first': 'universal-fallbacks', 'quality-checklist': 'universal-fallbacks',
    'focused-validation': 'universal-fallbacks', 'required-reviews': 'universal-fallbacks',
    'materialize-review-follow-up-tasks': 'universal-core', completion: 'universal-fallbacks'
} as const;

function quiet<T>(run: () => T): T {
    const log = console.log; console.log = () => undefined;
    try { return run(); } finally { console.log = log; }
}

function fixture(options: { rename?: boolean; maven?: boolean; polyglot?: boolean; tour?: boolean; noop?: boolean } = {}) {
    const root = createTempRepo(), previous = process.cwd();
    const updateCheck = process.env[UPDATE_CHECK_OPT_OUT_ENV];
    process.env[UPDATE_CHECK_OPT_OUT_ENV] = '0';
    const bundle = path.join(root, 'garda-agent-orchestrator');
    const targets = options.maven ? ['backend/a/src/test/java/example/A.java', 'backend/b/src/test/java/example/B.java']
        : options.polyglot ? ['backend/tests/Boundary.java', 'frontend/tests/Boundary.ts']
        : options.rename ? ['verification/one.assertion', 'verification/two.assertion'] : ['qa/one.zcheck', 'qa/two.zcheck'];
    const source = options.rename ? 'implementation/behavior.unknown' : 'product/behavior.zsrc';
    const runner = options.rename ? 'tools/renamed-runner.cjs' : 'tools/opaque-runner.cjs';
    const alias = `tools/strange-probe${process.platform === 'win32' ? '.cmd' : '.sh'}`;
    const testCommandPrefix = options.rename ? alias : `node ${runner}`;
    const write = (file: string, content: string) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), content); };
    write(source, 'before\n');
    for (const target of targets) write(target, target.endsWith('.java')
        ? `package example; class ${path.basename(target, '.java')} { @org.junit.jupiter.api.Test void behavior() throws Exception { assert java.nio.file.Files.readString(java.nio.file.Path.of("${source}")).trim().equals("after"); } }\n`
        : target.endsWith('.ts') ? `import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; assert.equal(readFileSync('${source}', 'utf8').trim(), 'after');\n`
        : `assert task behavior in ${target}\n`);
    write('qa/support.blob', 'helper and fixture input\n');
    write('qa/helper.blob', 'helper implementation\n');
    write('qa/current-plan.json', JSON.stringify({ targets: targets.map(path => ({ path, entrypoint: runner,
        reason: 'The opaque entrypoint selects the declared task behavior.' })), support: [
        { path: 'qa/support.blob', role: 'fixture', targets }, { path: 'qa/helper.blob', role: 'helper', targets }] }));
    write(runner, `const fs=require('node:fs'); const args=process.argv.slice(2);\n`
        + `fs.appendFileSync('garda-agent-orchestrator/runtime/invocations.jsonl',JSON.stringify(args)+'\\n');\n`
        + `if(args.includes('--broad') || (args.includes('verify')&&!args.some(x=>x.startsWith('-Dtest=')))) { console.log('opaque unrelated debt'); process.exit(1); }\n`
        + `const own=${JSON.stringify(targets)}; const selected=args.filter(x=>own.includes(x));\n`
        + `if(args.includes('--symbolic')) selected.push(...own);\n`
        + `if(args.some(x=>x.startsWith('-Dtest='))) { if(args[args.indexOf('-pl')+1]!=='a,b'||args[args.indexOf('-f')+1]!=='backend/pom.xml') process.exit(5); selected.push(...own.filter(x=>args.find(a=>a.startsWith('-Dtest=')).slice(7).split(',').includes(require('node:path').basename(x,'.java')))); }\n`
        + `if(!selected.length) process.exit(2); for(const x of selected) if(!fs.readFileSync(x,'utf8').includes('assert')) process.exit(3);\n`
        + `if(args.includes('--with-support')&&(!fs.readFileSync('qa/support.blob','utf8').includes('fixture input')||!fs.readFileSync('qa/helper.blob','utf8').includes('implementation'))) process.exit(6);\n`
        + `const behavior=fs.readFileSync(${JSON.stringify(source)},'utf8').trim();\n`
        + `if(behavior.split('\\n')[0]!=='after') { console.log('opaque behavior still red'); process.exit(4); }\n`
        + `if(args.includes('--finding-check')&&!behavior.includes('review-fix')) { console.log('opaque focused boundary still red'); process.exit(7); }\n`
        + `for(const x of selected) console.log('opaque '+x+' behavior satisfied');\n`);
    if (options.noop) write(runner, "console.log('opaque process exited without executing assertions');\n");
    if (options.rename) {
        write(alias, process.platform === 'win32' ? `@echo off\r\nnode ${runner} %*\r\n` : `#!/bin/sh\nexec node ${runner} "$@"\n`);
        fs.chmodSync(path.join(root, alias), 0o755);
    }
    if (options.maven) {
        write('backend/pom.xml', '<project><modelVersion>4.0.0</modelVersion><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.3.5</version><relativePath/></parent><groupId>fixture</groupId><artifactId>contract-parent</artifactId><version>1</version><packaging>pom</packaging><modules><module>a</module><module>b</module></modules><build><plugins><plugin><groupId>org.jacoco</groupId><artifactId>jacoco-maven-plugin</artifactId><version>0.8.12</version><configuration><excludes><exclude>**/dto/**</exclude></excludes></configuration></plugin></plugins></build></project>');
        for (const module of ['a', 'b']) write(`backend/${module}/pom.xml`, `<project><modelVersion>4.0.0</modelVersion><parent><groupId>fixture</groupId><artifactId>contract-parent</artifactId><version>1</version><relativePath>../pom.xml</relativePath></parent><artifactId>${module}</artifactId><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-test</artifactId><scope>test</scope></dependency></dependencies></project>`);
        write('backend/mvnw.cmd', `@echo off\r\nnode ${runner} %*\r\n`);
        write('backend/mvnw', `#!/bin/sh\nexec node ${runner} "$@"\n`);
        fs.chmodSync(path.join(root, 'backend/mvnw'), 0o755);
    }
    write('TASK.md', '# Tasks\n\n## Active Queue\n\n| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n'
        + `| ${TASK} | TODO | P1 | product | Contract behavior | fixture | 2026-11-06 | balanced | ${options.tour ? 'Test-first: expected-red' : 'fixture'} |\n`);
    write('.gitignore', 'TASK.md\ngarda-agent-orchestrator/\n');
    write('AGENTS.md', '# Contract project\n');
    write('.agents/workflows/start-task.md', buildSharedStartTaskWorkflowContent('AGENTS.md'));
    write('garda-agent-orchestrator/VERSION', fs.readFileSync(path.join(previous, 'VERSION'), 'utf8'));
    write('garda-agent-orchestrator/bin/garda.js', `const { runCliMainWithHandling } = require(${JSON.stringify(require.resolve('../../../src/cli/main'))});\n`
        + `void runCliMainWithHandling(process.argv.slice(2), ${JSON.stringify(previous)});\n`);
    seedInitAnswers(root); writeBalancedProfilesConfig(root);
    if (options.tour) {
        // Exercise the shipped DELTA policy, not the deliberately minimal legacy helper policy.
        const profilesPath = path.join(bundle, 'live/config/profiles.json');
        const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
        const shipped = JSON.parse(fs.readFileSync(path.join(previous, 'template/config/profiles.json'), 'utf8'));
        profiles.built_in_profiles.balanced.review_remediation_mode_policy = shipped.built_in_profiles.balanced.review_remediation_mode_policy;
        fs.writeFileSync(profilesPath, JSON.stringify(profiles));
        write('garda-agent-orchestrator/live/config/paths.json', JSON.stringify({ file_roles: { [source]: 'source' } }));
    }
    for (const [skill, directory] of [['code-review', 'skills'], ['test-review', 'skills'],
        ['testing-strategy', 'skill-packs/quality-architecture/skills']]) {
        write(`garda-agent-orchestrator/live/skills/${skill}/SKILL.md`,
            fs.readFileSync(path.join(previous, 'template', directory, skill, 'SKILL.md'), 'utf8'));
    }
    const config = buildDefaultWorkflowConfig();
    config.full_suite_validation.enabled = true;
    config.full_suite_validation.placement = 'after_compile_before_reviews';
    config.full_suite_validation.command = options.maven
        ? `backend/mvnw${process.platform === 'win32' ? '.cmd' : ''} -f backend/pom.xml verify` : `${testCommandPrefix} --broad`;
    config.compile_gate.command = options.tour ? UNCONFIGURED_COMPILE_GATE_COMMAND : `node --check ${runner}`;
    config.optional_quality_checks.enabled = options.tour === true;
    write('garda-agent-orchestrator/live/config/workflow-config.json', JSON.stringify(config));
    initializeGitRepo(root); writeProtectedControlPlaneManifest(root); process.chdir(root);
    const entry = quiet(() => runEnterTaskMode({ repoRoot: root, taskId: TASK, entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: '2', taskSummary: 'Verify task behavior across selected sources.', plannedChangedFiles: [source, ...targets] }));
    assert.equal(entry.exitCode, 0, entry.outputLines.join('\n'));
    quiet(() => { loadTaskEntryRulePack(root, TASK); runHandshakeForTask(root, TASK); runShellSmokeForTask(root, TASK); });
    for (const target of targets) fs.appendFileSync(path.join(root, target), '// assert current task regression\n');
    if (!options.tour) fs.writeFileSync(path.join(root, source), 'after\n');
    const preflightPath = path.join(bundle, `runtime/reviews/${TASK}-preflight.json`);
    quiet(() => runClassifyChangeCommand({ repoRoot: root, taskId: TASK, taskIntent: 'Verify selected task behavior.',
        includeUntracked: true, outputPath: preflightPath, emitMetrics: false }));
    quiet(() => loadPostPreflightRulePack(root, TASK, preflightPath));
    const cli = async (argv: string[], pass = true) => {
        const result = await runCliWithCapturedOutput(argv, { cwd: root });
        if (pass) assert.equal(result.exitCode, 0, [...result.logs, ...result.errors].join('\n'));
        return result;
    };
    const refresh = () => {
        quiet(() => { loadTaskEntryRulePack(root, TASK); runHandshakeForTask(root, TASK); runShellSmokeForTask(root, TASK);
            runClassifyChangeCommand({ repoRoot: root, taskId: TASK, taskIntent: 'Verify selected task behavior.',
                includeUntracked: true, outputPath: preflightPath, emitMetrics: false });
            loadPostPreflightRulePack(root, TASK, preflightPath); });
    };
    return { root, bundle, targets, runner, testCommandPrefix, preflightPath, source, cli, refresh,
        select: (command: string, plan?: unknown) => cli(['workflow', 'set', '--target-root', root, '--task-id', TASK,
            '--full-suite-command', command, '--reason', `${TASK} verifies current task behavior`,
            ...targets.flatMap(target => ['--focused-required-test-path', target]),
            ...(plan ? ['--task-test-plan', JSON.stringify(plan)] : [])]),
        compile: () => cli(['gate', 'compile-gate', '--task-id', TASK, '--preflight-path', preflightPath]),
        run: (pass = true) => cli(['gate', 'full-suite-validation', '--task-id', TASK, '--preflight-path', preflightPath], pass),
        cleanup: () => {
            process.chdir(previous);
            try { removeTempRepoWithRetry(root); }
            finally {
                if (updateCheck === undefined) delete process.env[UPDATE_CHECK_OPT_OUT_ENV];
                else process.env[UPDATE_CHECK_OPT_OUT_ENV] = updateCheck;
            }
        } };
}

function assertConsumers(f: ReturnType<typeof fixture>) {
    const evidence = quiet(() => buildFullSuiteValidationEvidence({ repoRoot: f.root, taskId: TASK, reviewType: 'test',
        preflightPath: f.preflightPath, preflightSha256: fileSha256(f.preflightPath) }));
    assert.equal(evidence?.cycle_binding_valid, true, JSON.stringify(evidence));
    const errors: string[] = [];
    const artifact = JSON.parse(fs.readFileSync(path.join(f.bundle, `runtime/reviews/${TASK}-full-suite-validation.json`), 'utf8'));
    collectFullSuiteValidationEvidence({ enabled: true, required: true, repoRoot: f.root, taskId: TASK,
        reviewsRoot: path.join(f.bundle, 'runtime/reviews'), timelinePath: path.join(f.bundle, `runtime/task-events/${TASK}.jsonl`),
        orderedEvents: collectOrderedTimelineEvents(path.join(f.bundle, `runtime/task-events/${TASK}.jsonl`), errors),
        expectedPreflightPath: f.preflightPath, expectedPreflightSha256: fileSha256(f.preflightPath)!,
        expectedCompileGateTimestamp: artifact.cycle_binding.compile_gate_timestamp, expectedCommand: artifact.command,
        fullSuiteNotRequiredForDocsOnly: false, errors });
    assert.deepEqual(errors, []);
    const route = quiet(() => resolveNextStep({ repoRoot: f.root, taskId: TASK }));
    assert.notEqual(route.next_gate, 'full-suite-validation', JSON.stringify(route));
    assert.notEqual(route.next_gate, 'task-test-selection', JSON.stringify(route));
    return artifact;
}

for (const rename of [false, true]) test(`unknown stack literal selection, native execution and consumers (rename=${rename})`, async () => {
    const f = fixture({ rename });
    try {
        assert.equal(fs.existsSync(path.join(f.root, 'package.json')), false);
        await f.compile();
        const route = quiet(() => resolveNextStep({ repoRoot: f.root, taskId: TASK }));
        assert.equal(route.next_gate, 'task-test-selection', JSON.stringify(route));
        assert.ok(route.commands.some(command => command.command.includes('<command')));
        await f.select(`${f.testCommandPrefix} ${f.targets.join(' ')}`);
        const declaredRoute = quiet(() => resolveNextStep({ repoRoot: f.root, taskId: TASK }));
        assert.equal(declaredRoute.next_gate, 'restart-coherent-cycle', JSON.stringify(declaredRoute));
        assert.match(declaredRoute.reason, /declares test sources/u);
        assert.equal(fs.existsSync(path.join(f.bundle, `runtime/reviews/${TASK}-full-suite-validation.json`)), false,
            'Role classification must precede the first execution, including a possible failed broad run.');
        await f.run(); assertConsumers(f);
        await f.cli(['gate', 'next-step', '--task-id', TASK, '--as-json']);
        assert.ok(!quiet(() => resolveNextStep({ repoRoot: f.root, taskId: TASK })).commands.some(c => c.command.includes('--broad')));
    } finally { f.cleanup(); }
});

test('Spring multi-module Maven narrows a failed broad run without output attribution or report preconditions', async () => {
    const f = fixture({ maven: true });
    try {
        await f.compile();
        const entrypoint = `backend/mvnw${process.platform === 'win32' ? '.cmd' : ''}`;
        await f.select(`${entrypoint} -f backend/pom.xml verify`, { targets: f.targets.map(path => ({ path, entrypoint,
            reason: 'The reactor command declares both task tests before narrowing the unrelated broad failure.' })) });
        assert.notEqual((await f.run(false)).exitCode, 0);
        const command = `backend/mvnw${process.platform === 'win32' ? '.cmd' : ''} -f backend/pom.xml -pl a,b -am -Dtest=A,B -Dsurefire.failIfNoSpecifiedTests=false test`;
        await f.select(command); await f.run(); assertConsumers(f);
        await f.cli(['gate', 'materialize-review-follow-up-tasks', '--task-id', TASK, '--review-type', 'recorded-out-of-scope']);
        assert.match(fs.readFileSync(path.join(f.root, 'TASK.md'), 'utf8'), /out_of_scope_follow_up=grouped.*not attributed/u);
        const entries = readTaskTimelineJsonlEntries(path.join(f.bundle, `runtime/task-events/${TASK}.jsonl`));
        assert.ok(entries.some(entry => entry.record?.event_type === 'FULL_SUITE_VALIDATION_FAILED'));
        const selected = entries.filter(entry => entry.record?.event_type === 'TASK_TEST_SELECTION_RECORDED').at(-1)!;
        assert.match(JSON.stringify(selected.record), /not attributed/u);
    } finally { f.cleanup(); }
});

test('polyglot plan runs and records both declared invocations separately', async () => {
    const f = fixture({ polyglot: true });
    try {
        await f.compile();
        await f.select(f.targets.map(target => `node ${f.runner} ${target}`).join(' && '));
        await f.run();
        const artifact = assertConsumers(f);
        assert.equal(artifact.task_test_process_evidence.invocations.length, 2);
        assert.deepEqual(fs.readFileSync(path.join(f.bundle, 'runtime/invocations.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)), f.targets.map(target => [target]));
    } finally { f.cleanup(); }
});

test('symbolic mapping admits opaque targets and bound support without changing global roles', async () => {
    const f = fixture();
    try {
        await f.compile();
        const plan = { targets: f.targets.map(path => ({ path, entrypoint: f.runner,
            reason: 'Opaque entrypoint selects the declared task assertions.' })),
            support: [{ path: 'qa/support.blob', role: 'fixture', targets: f.targets }, { path: 'qa/helper.blob', role: 'helper', targets: f.targets }] };
        await f.select(`node ${f.runner} --broad ${f.targets.join(' ')}`, plan);
        assert.notEqual((await f.run(false)).exitCode, 0);
        await f.select(`node ${f.runner} --symbolic --with-support qa/support.blob qa/helper.blob`, plan);
        await f.run(); assertConsumers(f);
    } finally { f.cleanup(); }
});

test('a no-op may prove process success but cannot close the task without independent review', async () => {
    const f = fixture({ noop: true });
    try {
        await f.compile(); await f.select(`node ${f.runner} ${f.targets.join(' ')}`); await f.run();
        assert.equal(assertConsumers(f).status, 'PASSED', 'This status proves process completion only.');
        const preflight = JSON.parse(fs.readFileSync(f.preflightPath, 'utf8'));
        assert.ok(Object.values(preflight.required_reviews).some(Boolean));
        const completion = await f.cli(['gate', 'completion-gate', '--task-id', TASK, '--preflight-path', f.preflightPath], false);
        assert.notEqual(completion.exitCode, 0);
        assert.match([...completion.logs, ...completion.errors].join('\n'), /review/iu);
        const row = parseCanonicalActiveTaskQueue(fs.readFileSync(path.join(f.root, 'TASK.md'), 'utf8')).rows.find(row => row.taskId === TASK);
        assert.ok(row); assert.ok(!row.status.includes('DONE'));
    } finally { f.cleanup(); }
});

for (const fault of ['hash', 'execution-binding', 'chronology']) test(`integrity refusal: ${fault}`, async () => {
    const f = fixture();
    try {
        await f.compile(); await f.select(`node ${f.runner} ${f.targets.join(' ')}`); await f.run();
        const artifactPath = path.join(f.bundle, `runtime/reviews/${TASK}-full-suite-validation.json`);
        const artifact = assertConsumers(f);
        if (fault === 'hash') fs.appendFileSync(artifactPath, ' ');
        else {
            if (fault === 'execution-binding') artifact.task_test_process_evidence.selection_sha256 = '0'.repeat(64);
            else artifact.task_test_process_evidence.invocations[0].completed_at = '1970-01-01T00:00:00.000Z';
            fs.writeFileSync(artifactPath, JSON.stringify(artifact));
        }
        const evidence = quiet(() => buildFullSuiteValidationEvidence({ repoRoot: f.root, taskId: TASK, reviewType: 'test',
            preflightPath: f.preflightPath, preflightSha256: fileSha256(f.preflightPath) }));
        assert.ok(evidence?.cycle_binding_valid !== true || evidence.artifact_freshness !== 'current', JSON.stringify(evidence));
        assert.match(JSON.stringify(evidence), /integrity|hash|binding|chronology|authenticated|changed|process/iu);
        const specific = fault === 'hash' ? /artifact integrity/iu : fault === 'execution-binding'
            ? /missing or mismatched selection\/execution binding/iu : /invalid execution chronology/iu;
        assert.match(String(evidence?.mismatch_reason), specific);
        const route = quiet(() => resolveNextStep({ repoRoot: f.root, taskId: TASK }));
        assert.equal(route.status, 'BLOCKED', JSON.stringify(route));
        assert.match(route.reason, /integrity|hash|binding|chronology|authenticated|changed|process/iu);
        assert.match(route.reason, specific);
        assert.ok(route.commands.length > 0);
    } finally { f.cleanup(); }
});

test('contained declaration manifest replaces large argv path lists and remains hash-bound', async () => {
    const f = fixture();
    try {
        await f.compile();
        const declaration = path.join(f.bundle, 'runtime/reviews/agent-declared-plan.json');
        fs.copyFileSync(path.join(f.root, 'qa/current-plan.json'), declaration);
        await f.cli(['workflow', 'set', '--target-root', f.root, '--task-id', TASK,
            '--full-suite-command', `node ${f.runner} --symbolic --with-support qa/support.blob qa/helper.blob`,
            '--reason', `${TASK} verifies both declared task behavior targets`, '--task-test-plan', '@garda-agent-orchestrator/runtime/reviews/agent-declared-plan.json']);
        await f.run(); assertConsumers(f);
        fs.appendFileSync(declaration, ' ');
        assert.equal(loadTaskFullSuiteConfig(f.root, TASK).selection.status, 'stale');
        const route = quiet(() => resolveNextStep({ repoRoot: f.root, taskId: TASK }));
        assert.equal(route.status, 'BLOCKED', JSON.stringify(route));
        assert.ok(route.commands.length > 0);
    } finally { f.cleanup(); }
});

test('validation command inventory has an explicit contract owner', () => {
    const inventory = GATE_COMMANDS.filter(gate => /(?:compile|test|validation|quality-checklist|completion)/u.test(gate));
    assert.deepEqual(inventory, ['compile-gate', 'full-suite-validation', 'completion-gate', 'quality-checklist'],
        'A new validation/build gate requires a route in VALIDATION_GATE_TOUR and the standalone tour.');
});

for (const rename of [false, true]) test(`universal-fallbacks dependency: complete opaque gate tour (rename=${rename})`, async () => {
    const f = fixture({ tour: true, rename });
    const reached = new Set<string>(), launches: Array<{ lane: string; mode: string }> = [];
    try {
        const discovery = getProjectDiscovery(f.root);
        assert.deepEqual(discovery.suggestedCompileGateCommands, []);
        assert.equal(discovery.suggestedFullSuiteValidationCommand, null);
        reached.add('discovery');
        const own = `${f.testCommandPrefix} --with-support qa/support.blob qa/helper.blob ${f.targets.join(' ')}`;
        const focused = own + ' --finding-check';
        await f.select(own, { support: [{ path: 'qa/support.blob', role: 'fixture', targets: f.targets },
            { path: 'qa/helper.blob', role: 'helper', targets: f.targets }] });
        reached.add('task-test-selection');
        // R4: declaration belongs to this task; project configuration remains unconfigured.
        await f.cli(['gate', 'compile-gate', '--task-id', TASK, '--preflight-path', f.preflightPath,
            '--compile-command', `node --check ${f.runner}`]);
        reached.add('compile-gate');
        const targeted = (red = false) => f.cli(['gate', 'run-intermediate-command', '--task-id', TASK,
            '--command-source', 'targeted-test', '--command', own, '--preflight-path', f.preflightPath,
            ...f.targets.flatMap(source => ['--selected-case', JSON.stringify({ source, case_id: 'behavior', selector: source })]),
            ...(red ? ['--expect-failure'] : [])]);
        await targeted(true); reached.add('test-first');
        fs.writeFileSync(path.join(f.root, f.source), 'after\n'); f.refresh();
        await f.select(own); await targeted();
        await f.cli(['gate', 'compile-gate', '--task-id', TASK, '--preflight-path', f.preflightPath,
            '--compile-command', `node --check ${f.runner}`]);
        await f.select(`${f.testCommandPrefix} --broad ${f.targets.join(' ')}`);
        assert.notEqual((await f.run(false)).exitCode, 0);
        await f.select(own); await f.run(); reached.add('full-suite-validation');
        await f.cli(['gate', 'materialize-review-follow-up-tasks', '--task-id', TASK, '--review-type', 'recorded-out-of-scope']);
        reached.add('materialize-review-follow-up-tasks');
        const matrix = [{ boundary_id: 'TB-OPAQUE', boundary: 'Declared task assertions to native process evidence',
            authority_source: 'Current task cycle and content-bound selection', mutable_inputs: ['source, runner, tests, helper and data'],
            integrity_evidence: ['native process identity and hashes'], canonical_reconstruction: 'Read retained source and output bindings.',
            toctou_replay: 'Reject stale selection and damaged chronology.', negative_paths: f.targets.map(source => ({ kind: 'other',
                scenario: 'behavior', expected_behavior: 'Reject the prior behavior before implementation and pass after.', evidence_files: [`${source}#behavior`] })) }];
        const checklist = async () => {
            const answers = buildQualityChecklistAnswersTemplate({ repoRoot: f.root, taskId: TASK, preflightPath: f.preflightPath })
                .answers.map(answer => ({ ...answer, status: 'PASS', answer: 'Inspected the task behavior and its bound two-target execution.',
                    ...(answer.rule_id === TRUST_BOUNDARY_ANALYSIS_RULE_ID ? { trust_boundary_matrix: matrix } : {}) }));
            await f.cli(['gate', 'quality-checklist', '--task-id', TASK, '--preflight-path', f.preflightPath, '--answers-json', JSON.stringify(answers)]);
        };
        await checklist();
        reached.add('quality-checklist');
        let focusedFinding = false;
        let focusedExecuted = false;
        const seen = new Map<string, number>();
        const trace: string[] = [];
        for (let step = 0; step < 100; step++) {
            const cliRoute = await f.cli(['gate', 'next-step', '--task-id', TASK, '--as-json']);
            const route = JSON.parse(cliRoute.logs.join('\n')) as ReturnType<typeof resolveNextStep>;
            if (route.status === 'DONE') {
                reached.add('completion');
                assert.ok(focusedFinding && focusedExecuted);
                // Concept 6.2: a real small code fix repeats only code in DELTA; test first runs in FULL.
                assert.deepEqual(launches, [{ lane: 'code', mode: 'FULL' }, { lane: 'code', mode: 'DELTA' }, { lane: 'test', mode: 'FULL' }]);
                for (const gate of Object.keys(VALIDATION_GATE_TOUR)) assert.ok(reached.has(gate), `Unreached gate: ${gate}; native routes: ${trace.join(', ')}`);
                return;
            }
            if (route.next_gate === 'task-test-selection') { await f.select(own); trace.push('task-test-selection/workflow-set'); continue; }
            if (route.next_gate === 'quality-checklist') { await checklist(); trace.push('quality-checklist/quality-checklist'); continue; }
            assert.ok(route.commands.length, JSON.stringify(route));
            const command = route.commands[0].command.replace(/\$(?:env:)?GARDA_EXECUTION_PROVIDER\b/gu, 'Codex')
                .replace(/<agent:resolved-provider-reviewer-id-from-delegated-agent>/gu, `agent:opaque-${step}`)
                .replace(/<provider-owned invocation id from delegated reviewer launch result>/gu, `opaque-invocation-${step}`)
                .replace(/<provider-owned attestation source from delegated reviewer launch result>/gu, 'test_provider_invocation')
                .replace(/<task-compile-command>/gu, `node --check ${f.runner}`)
                .replace(/<task-test-command>/gu, own)
                .replace(/<analysis>/gu, `The F-001 fix changes only ${f.source}; both opaque targets pass with unchanged test bytes.`);
            assert.ok(!/<[^>]+>/u.test(command), `Unresolved route: ${command}\n${route.reason}`);
            const argv = parseCommandChain(command)[0];
            const start = argv.indexOf('gate'); assert.ok(start >= 0, command);
            const args = argv.slice(start);
            trace.push(`${route.next_gate}/${args[1]}`);
            const key = JSON.stringify(args); seen.set(key, (seen.get(key) ?? 0) + 1);
            assert.ok(seen.get(key)! <= 2, `Repeated unchanged action: ${command}`);
            const argument = (name: string) => args[args.indexOf(name) + 1];
            if (route.next_gate === 'complete-reviewer-launch') {
                const lane = argument('--review-type');
                const contextPath = path.join(f.bundle, `runtime/reviews/${TASK}-${lane}-review-context.json`);
                const context = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as { review_execution: { mode: string }; coverage_contract: ReviewCoverageContract };
                launches.push({ lane, mode: context.review_execution.mode }); reached.add('required-reviews');
                const report = buildNoFindingsJsonReviewReport(contextPath, TASK, lane);
                const ledger = report.coverage_ledger as { entries: Array<{ obligation_id: string; evidence: Array<{ location: string }>; case_resolution?: unknown }> };
                for (const obligation of context.coverage_contract.obligations) {
                    const binding = obligation.validation_binding, execution = binding?.case_execution;
                    if (!binding || !execution) continue;
                    const quote = retainedNativeCaseOutput(f.root, execution).text.split(/\r?\n/u).find(line => execution.expected_failure
                        ? line === 'opaque behavior still red' : line.includes(binding.source_identity.path) && line.includes('satisfied'));
                    assert.ok(quote, `Missing genuine case output for ${obligation.id}`);
                    const entry = ledger.entries.find(entry => entry.obligation_id === obligation.id)!;
                    entry.evidence[0].location = `${binding.source_identity.path}:1`;
                    entry.case_resolution = { binding_sha256: validationDigest(binding),
                        execution_sha256: execution.record_sha256, output_sha256: execution.output_sha256,
                        ...(execution.expected_failure ? { outcome: 'FAILED', failure_kind: 'ASSERTION' } : { outcome: 'PASSED' }), evidence_quote: quote,
                        reasoning: 'The fixture reviewer inspected the runner assertion, before/after source behavior and retained two-target results.' };
                }
                if (!focusedFinding && lane === 'code') {
                    const evidence = [{ location: `${f.source}:1`, observation: 'The changed implementation omits the focused boundary state required by both opaque assertions.' }];
                    (report.findings as { high: unknown[] }).high.push({ id: 'F-001',
                        title: 'The implementation omits the focused boundary state',
                        description: 'Set the reviewed boundary state and verify both opaque targets with the finding-specific command.', evidence,
                        coverage_obligation_ids: [context.coverage_contract.obligations[0].id] });
                    (ledger.entries[0] as unknown as { finding_ids: string[] }).finding_ids = ['F-001'];
                    focusedFinding = true;
                }
                const launch = JSON.parse(fs.readFileSync(path.resolve(f.root, argument('--reviewer-launch-artifact-path')), 'utf8'));
                await new Promise(resolve => setTimeout(resolve, 11_000));
                fs.writeFileSync(path.resolve(f.root, launch.review_output_path), JSON.stringify(report));
            }
            const result = await f.cli(args, false);
            if (args[1] === 'record-review-result' && argument('--review-type') === 'code' && focusedFinding && !focusedExecuted) {
                const recorded = readTaskTimelineJsonlEntries(path.join(f.bundle, `runtime/task-events/${TASK}.jsonl`))
                    .map(entry => entry.record).filter(event => event?.event_type === 'REVIEW_RECORDED'
                        && isPlainRecord(event.details) && event.details.review_type === 'code').at(-1);
                const details = isPlainRecord(recorded?.details) ? recorded.details : {};
                const disposition = isPlainRecord(details.review_findings_disposition) ? details.review_findings_disposition : {};
                assert.equal(disposition.verdict, 'fail_for_fix_now', [...result.logs, ...result.errors].join('\n'));
                assert.deepEqual(disposition.blocking_ids, ['F-001']);
                const focusedArgs = ['gate', 'run-intermediate-command', '--task-id', TASK, '--command-source', 'targeted-test',
                    '--command', focused, '--preflight-path', f.preflightPath,
                    ...f.targets.flatMap(source => ['--selected-case', JSON.stringify({ source, case_id: 'focused-boundary', selector: source })])];
                const redFocused = await f.cli(focusedArgs, false);
                assert.notEqual(redFocused.exitCode, 0, 'The reviewed code defect must genuinely fail both focused targets.');
                fs.writeFileSync(path.join(f.root, f.source), 'after\nreview-fix\n');
                await f.cli(['gate', 'restart-review-cycle', '--task-id', TASK, '--preflight-path', f.preflightPath,
                    '--impact-analysis', [
                        'Reviewer finding: F-001 omits the focused boundary state required by the opaque assertions.',
                        'Intended fix: add the review-fix state after the existing after behavior.',
                        `Affected files and contracts: only ${f.source}; both declared test files remain byte-identical.`,
                        'API/runtime/artifact/test impact: the same runner reads the added state; no API or artifact schema changes.',
                        'Possible side effects: changing the first behavior line would regress the original targets.',
                        'Required targeted checks: run both original targets and the finding-specific command, then compile and own suite.',
                        'Scope or review-type changes: same files and lanes; the small code fix requires code DELTA and first test FULL.',
                        'Related blocker or follow-up decision: F-001 is fixed here; the unrelated broad failure keeps its grouped follow-up.'
                    ].join('; ')]);
                await f.select(own); await targeted();
                await f.cli(focusedArgs);
                reached.add('focused-validation'); focusedExecuted = true;
                await f.select(own); await f.run(); await checklist();
            } else assert.equal(result.exitCode, 0, [...result.logs, ...result.errors].join('\n'));
            if (args[1] === 'run-intermediate-command') reached.add('focused-validation');
        }
        assert.fail('Opaque gate tour did not reach DONE within its bounded command count.');
    } finally { f.cleanup(); }
});
