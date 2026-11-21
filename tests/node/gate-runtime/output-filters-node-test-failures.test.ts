import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyOutputFilterProfile } from '../../../src/gate-runtime/output-filters';

const FAILING_NAMES = Array.from({ length: 12 }, (_, index) => `failing case ${String(index + 1).padStart(2, '0')}`);

function findTemplateOutputFilters(): string {
    for (let directory = __dirname; ; directory = path.dirname(directory)) {
        const candidate = path.join(directory, 'template', 'config', 'output-filters.json');
        if (fs.existsSync(candidate)) return candidate;
        if (path.dirname(directory) === directory) throw new Error('template/config/output-filters.json was not found.');
    }
}

/** Run a real node:test file with 12 failing and 4 passing tests in two suites through the given reporter. */
function runNodeTestReporter(t: TestContext, reporter: 'spec' | 'tap'): string[] {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-node-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'sample.test.cjs');
    const cases = (suite: number) => FAILING_NAMES.slice(suite * 6, suite * 6 + 6)
        .map((name) => `    it(${JSON.stringify(name)}, () => { assert.equal(1, 2, ${JSON.stringify(`${name} broke`)}); });`)
        .concat([`    it('passing case ${suite}a', () => {});`, `    it('passing case ${suite}b', () => {});`]);
    fs.writeFileSync(file, [
        "const { describe, it } = require('node:test');",
        "const assert = require('node:assert/strict');",
        "describe('suite one', () => {", ...cases(0), '});',
        "describe('suite two', () => {", ...cases(1), '});'
    ].join('\n'));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    const run = childProcess.spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, file],
        { cwd: directory, env, encoding: 'utf8', windowsHide: true });
    assert.notEqual(run.status, 0, 'the sample run fails');
    return `${run.stdout}${run.stderr}`.split(/\r?\n/u);
}

function filterFailure(lines: string[]): ReturnType<typeof applyOutputFilterProfile> {
    // No failure tail: the parser alone must surface every failing name.
    return applyOutputFilterProfile(lines, findTemplateOutputFilters(), 'test_failure_console', { context: { fail_tail_lines: 0 } });
}

for (const reporter of ['spec', 'tap'] as const) {
    test(`test failure parser keeps every failing node:test name from the ${reporter} reporter`, (t) => {
        const raw = runNodeTestReporter(t, reporter);
        const result = filterFailure(raw);
        assert.equal(result.parser_mode, 'FULL', result.lines.join('\n'));
        assert.equal(result.parser_name, 'test_failure_summary');
        const output = result.lines.join('\n');
        for (const name of FAILING_NAMES) assert.ok(output.includes(name), `${name} is missing:\n${output}`);
        assert.doesNotMatch(output, /passing case/u);
        assert.doesNotMatch(output, /✖ failing tests:/u, 'the summary heading is not a failure');
        // max_matches of the default profile bounds the parser lines (summary line plus groups).
        assert.ok(result.lines.length <= 17, `${result.lines.length} lines:\n${output}`);
        assert.ok(result.lines.length < raw.length, 'the summary is shorter than the raw output');
    });
}

test('test failure parser leaves passing node:test output to the success path', () => {
    const result = filterFailure(['▶ suite', '  ✔ passing case (1ms)', '✔ suite (2ms)', 'ℹ pass 1', 'ok 1 - passing case']);
    assert.equal(result.parser_mode, 'PASSTHROUGH');
});

/** Four suites with five failing tests, one failing todo and one passing test each: more groups than max_matches. */
function runManySuites(t: TestContext, reporter: 'spec' | 'tap'): string[] {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-node-test-many-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'many.test.cjs');
    const body = ["const { describe, it } = require('node:test');", "const assert = require('node:assert/strict');"];
    for (let suite = 1; suite <= 4; suite += 1) {
        body.push(`describe('suite ${suite}', () => {`);
        for (let index = 1; index <= 5; index += 1) body.push(`    it('fail ${suite}.${index}', () => { assert.equal(1, 2); });`);
        body.push(`    it.todo('todo ${suite}', () => { assert.equal(1, 2); });`, `    it('pass ${suite}', () => {});`, '});');
    }
    fs.writeFileSync(file, body.join('\n'));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    const run = childProcess.spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, file],
        { cwd: directory, env, encoding: 'utf8', windowsHide: true });
    assert.notEqual(run.status, 0, 'the sample run fails');
    return `${run.stdout}${run.stderr}`.split(/\r?\n/u);
}

for (const reporter of ['spec', 'tap'] as const) {
    test(`a ${reporter} failure list longer than max_matches ends with its truncation marker`, (t) => {
        const result = filterFailure(runManySuites(t, reporter));
        assert.equal(result.parser_mode, 'FULL', result.lines.join('\n'));
        const output = result.lines.join('\n');
        const grouping = result.grouping;
        assert.ok(grouping, 'the parser reports its grouping');
        assert.equal(grouping.groups.length, 16, 'the default profile shows max_matches groups');
        assert.ok(grouping.unique_groups > 16, `${grouping.unique_groups} groups:\n${output}`);
        assert.match(result.lines[0], new RegExp(`^CompactSummary: FULL \\| strategy=test \\| ${grouping.unique_groups} group\\(s\\)`, 'u'));
        // The omitted count stays visible: header, 16 groups and the marker.
        assert.equal(result.lines.at(-1), `... and ${grouping.unique_groups - 16} more distinct error(s) (${grouping.total_matches} total matches)`);
        assert.equal(result.lines.length, 18, output);
        // A failing todo is not a test failure: neither reporter counts it.
        assert.doesNotMatch(output, /todo \d/u);
        assert.doesNotMatch(output, /pass \d/u);
    });
}

test('TAP not ok lines with a TODO or SKIP directive are not failures', () => {
    const result = filterFailure([
        'TAP version 13',
        'not ok 1 - flaky case # TODO investigate',
        'not ok 2 - skipped case # SKIP not on this platform',
        'not ok 3 - lower-case directive # skip',
        'ok 4 - passing case',
        '1..4'
    ]);
    assert.equal(result.parser_mode, 'PASSTHROUGH', result.lines.join('\n'));
    const failing = filterFailure(['not ok 1 - broken case', 'not ok 2 - escaped \\# TODO is part of the name', 'not ok 3 - todo # TODO later']);
    assert.equal(failing.parser_mode, 'FULL');
    assert.deepEqual(failing.lines.slice(1), ['not ok 1 - broken case', 'not ok 2 - escaped \\# TODO is part of the name']);
});
