'use strict';
// This is a toolchain simulator, not a Garda evidence publisher. All receipts come from native gates.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => fs.readFileSync(file, 'utf8');
const fixture = JSON.parse(read('.stand-fixture.json'));
const plan = JSON.parse(read('.git/stand-task.json'));
const [dispatch, ...argv] = process.argv.slice(2);
const tech = fixture.technologies.find(item => item.id === dispatch || [item.executable, item.compileExecutable].some(executable => dispatch === '@' + executable)
    && [item.compileArgv, item.broadArgv, ...plan.invocations.filter(run => run.technology === item.id).map(run => run.argv)]
        .some(args => JSON.stringify(args) === JSON.stringify(argv)))
    || fixture.technologies.find(item => [item.executable, item.compileExecutable].some(executable => dispatch === '@' + executable));
const technology = tech?.id;
if (!tech) throw new Error('Unknown simulated technology: ' + technology);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const invocation = plan.invocations.find(item => item.technology === technology && same(item.argv, argv));
const compile = same(tech.compileArgv, argv);
const broad = same(tech.broadArgv, argv);
const variant = plan.runnerVariant || 'ordinary';
let targets = invocation?.targets || [];
let error = !compile && !broad && !invocation ? 'selector/module/target set differs from the task declaration' : '';
const cwd = plan.repoRoot ? path.relative(fs.realpathSync(plan.repoRoot), fs.realpathSync(process.cwd())).replace(/\\/g, '/') || '.' : '.';
if (cwd !== '.') error = 'runner cwd differs from the declared repository root';
const compileFailure = '.git/stand-fail-compile-once';
if (compile && !error && fs.existsSync(compileFailure)) {
    fs.unlinkSync(compileFailure);
    error = 'synthetic interruption of the compile command';
}
if (variant === 'ignored-selector') targets = fixture.suites.map(item => item.target);
if (variant === 'dropped-second-module') targets = targets.slice(0, 1);
if (variant === 'zero-tests' || variant === 'noop') targets = [];
const checks = targets.map(target => {
    const suite = fixture.suites.find(item => item.target === target);
    if (!suite || !fs.existsSync(target)) return { target, passed: false, reason: 'missing target' };
    const test = read(target), source = read(suite.source);
    const testMarker = 'STAND_CASE_A' + plan.archetype;
    const implementation = 'STAND_IMPLEMENT_A' + plan.archetype;
    const requiresImplementation = ![2, 4].includes(plan.archetype);
    const passed = test.includes(testMarker) && (!requiresImplementation || source.includes(implementation))
        && (plan.archetype !== 5 || source.includes('STAND_REPAIRED_A5'));
    return { target, source: suite.source, case: suite.case, passed, skipped: variant === 'skipped',
        sourceSha256: hash(source), testSha256: hash(test),
        reason: passed ? 'task assertions satisfied' : 'task assertion: missing behavior or repair' };
});
const failed = !!error || broad || checks.some(item => !item.passed);
const exitCode = variant === 'noop' || variant === 'zero-tests' || variant === 'output-report-disagreement' ? 0 : Number(failed);
let output;
if (error) output = '[' + technology + '] ' + error;
else if (compile) output = technology === 'maven' ? '[INFO] Reactor Summary:\n[INFO] application SUCCESS\n[INFO] partners-module SUCCESS\n[INFO] BUILD SUCCESS' : '[' + technology + '] Build succeeded. 0 errors.';
else if (broad) output = 'worker 7f3a: repository audit\n3 checks broke in an unrelated resource boundary';
else {
    const lines = checks.map((item, index) => {
        const status = item.skipped ? 'SKIPPED' : item.passed ? 'PASSED' : 'FAILED';
        switch (technology) {
            case 'maven': return '[INFO] Running example.' + path.basename(item.target, '.java') + '\n[INFO] Tests run: 1, Failures: ' + Number(!item.passed) + ', Errors: 0, Skipped: ' + Number(item.skipped);
            case 'gradle': return '> Task :' + item.target.split('/')[0] + ':test\n' + path.basename(item.target) + ' > taskContract ' + status;
            case 'dotnet': return '  ' + (item.passed ? 'Passed' : 'Failed') + ' Example.OrderTests.TaskContract [1 ms]';
            case 'go': return JSON.stringify({ Action: item.passed ? 'pass' : 'fail', Package: 'example.org/' + item.target.split('/')[0], Test: 'TestTaskContract', Elapsed: 0.001 });
            case 'rust': return 'test task_contract ... ' + (item.passed ? 'ok' : 'FAILED');
            case 'python': return item.target + '::test_task_contract ' + status + ' [100%]';
            case 'node': return (item.passed ? 'ok ' : 'not ok ') + (index + 1) + ' - task-contract # ' + item.target;
            case 'phpunit': return 'PHPUnit 11.5\n' + (item.passed ? '.' : 'F') + ' 1 / 1 (100%) ' + item.target;
            case 'laravel': return '   ' + (item.passed ? 'PASS' : 'FAIL') + '  ' + item.target + '\n  ' + (item.passed ? '✓' : '⨯') + ' task contract';
            case 'vitest': return ' RUN  v3.0\n ' + (item.passed ? '✓' : '❯') + ' ' + item.target + ' (1 test)';
            case 'playwright': return 'Running 1 test using 1 worker\n  ' + (item.passed ? '✓' : '✘') + ' 1 [chromium] › ' + item.target + ' › task contract';
            case 'nx': return '> nx run ' + item.target.split('/')[1] + ':test\n' + (item.passed ? 'PASS' : 'FAIL') + ' ' + item.target;
            case 'ruby': return item.target + '\n1 example, ' + Number(!item.passed) + ' failures';
            case 'elixir': return (item.passed ? '.' : 'F') + '\n1 test, ' + Number(!item.passed) + ' failures';
            case 'swift': return "Test Case '" + path.basename(item.target, '.swift') + ".testTaskContract' " + (item.passed ? 'passed' : 'failed') + ' (0.001 seconds).';
            case 'cmake': return '1/1 Test #1: ' + path.basename(item.target, '.cpp') + ' ... ' + (item.passed ? 'Passed' : '***Failed');
            default: return 'quartz receipt=' + hash(item.testSha256 + item.sourceSha256).slice(0, 16) + ' balance=' + (item.passed ? 'settled' : 'broken');
        }
    });
    output = lines.join('\n') || 'runner finished; no cases';
}
if (variant === 'noop') output = 'runner intentionally did no work';
const reports = [];
if (!compile && !broad && plan.mode === 'auto') {
    for (const item of checks) {
        let file;
        if (technology === 'maven') file = item.target.split('/')[0] + '/target/surefire-reports/TEST-example.' + path.basename(item.target, '.java') + '.xml';
        else file = '.stand-output/' + technology + '/' + path.basename(item.target) + (tech.report === 'trx' ? '.trx' : '.xml');
        const passed = variant === 'output-report-disagreement' ? false : item.passed;
        const xml = tech.report === 'trx'
            ? '<TestRun><Results><UnitTestResult testName="TaskContract" outcome="' + (passed ? 'Passed' : 'Failed') + '"/></Results></TestRun>'
            : '<testsuite tests="1" failures="' + Number(!passed) + '" skipped="' + Number(item.skipped) + '"><testcase classname="example.' + path.basename(item.target, path.extname(item.target)) + '" name="taskContract">' + (!passed ? '<failure message="task assertion"/>' : '') + (item.skipped ? '<skipped/>' : '') + '</testcase></testsuite>';
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, xml);
        if (variant === 'stale-report') fs.utimesSync(file, new Date(0), new Date(0));
        reports.push({ path: file, sha256: hash(xml), stale: variant === 'stale-report', passed });
    }
}
const record = { schema: 1, fixture: fixture.id, technology, argv, cwd, purpose: compile ? 'compile' : broad ? 'broad' : 'own',
    archetype: plan.archetype, mode: plan.mode, variant, targets, checks, reports, exitCode: compile && !error ? 0 : exitCode,
    outputSha256: hash(output + '\n'), output, error };
fs.appendFileSync('.git/stand-invocations.jsonl', JSON.stringify(record) + '\n');
console.log(output);
process.exitCode = compile && !error ? 0 : exitCode;
