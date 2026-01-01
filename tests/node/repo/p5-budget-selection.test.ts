import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getRepoRoot, type BuildResult } from '../../../scripts/node-foundation/build';
import { resolveSelectedTestFiles } from '../../../scripts/node-foundation/test';
import { resolveCoverageTestArgs } from '../../../scripts/node-foundation/coverage';
import { parseCommandChain } from '../../../src/core/command-line';
import { assertP5HistoryGrowth, type P5Sample } from '../gates/next-step/next-step-p5-cost-fixture';

test('P5 linear history tolerance rejects repeated verification/parsing and any extra non-history work', () => {
    const sample = (events: number, bytes: number): P5Sample => ({ route: 'budget-negative-control', variant: 'control',
        result: {} as P5Sample['result'], measurement: { phases_ms: {}, work: {
            timeline_verify: 1, timeline_events: events, timeline_bytes: bytes, 'timeline_payload_read:timeline.jsonl': 1,
            json_parse_verified_timeline_event: events, 'visit:verified_timeline_index_event': events,
            json_parse_total: events
        } } });
    const before = sample(2, 100), after = sample(128, 1000);
    const input = { events: 126, bytes: 900, previousBytes: 100, objects: 3 * 126, fields: 13 * 126 };
    assert.doesNotThrow(() => assertP5HistoryGrowth(before, after, input));
    for (const counter of ['timeline_verify', 'json_parse_verified_timeline_event', 'json_parse_total',
        'payload_read:timeline', 'file_hash:source', 'visit:unexpected_history_walk', 'visit:review_index_candidate',
        'visit:invocation_file_read_chunk:timeline.jsonl', 'io:existsSync', 'io:readSync']) {
        const bad = { ...after, measurement: { ...after.measurement, work: { ...after.measurement.work } } };
        if (counter.startsWith('io:')) bad.measurement.io = { [counter.slice(3)]: { count: 1, total_ms: 0, max_ms: 0, throws: 0 } };
        else bad.measurement.work[counter] = (bad.measurement.work[counter] || 0) + 1;
        assert.throws(() => assertP5HistoryGrowth(before, bad, input), counter);
    }
});

test('P5 T-451-3 new cost regressions are collected by default and release coverage without running those groups', () => {
    const root = getRepoRoot(), buildRoot = path.resolve(__dirname, '../../..');
    const scripts = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    const build: BuildResult = { repoRoot: root, buildRoot, copiedFiles: [], generatedCliPath: '', manifestPath: '' };
    const files = [
        'gates/next-step/next-step-p5-route-cost', 'gates/next-step/next-step-p5-evidence-cost',
        'gates/next-step/next-step-p5-authenticated-cost', 'gates/workspace/workspace-p5-read-phase'
    ].map(file => path.join(buildRoot, 'tests/node', file + '.test.js'));
    for (const file of files) assert.ok(fs.existsSync(file), file);
    const commands = parseCommandChain(scripts.test);
    assert.equal(commands.length, 1);
    assert.deepEqual(commands[0].slice(0, 3), ['node', 'scripts/node-foundation/build-scripts.cjs', 'test.js']);
    const targets = commands[0].slice(3);
    assert.ok(targets.every(target => !target.startsWith('-')));
    const selected = resolveSelectedTestFiles(build, files, targets);
    for (const file of files) assert.ok(selected.includes(file), 'Default test collection omitted ' + file);
    const withoutGates = resolveSelectedTestFiles(build, files, targets.filter(target => target !== 'tests/node/gates'));
    for (const file of files) assert.ok(!withoutGates.includes(file), 'Negative control must remove ' + file);
    const runs = (script: string, dependency: string) => parseCommandChain(scripts[script]).some(command =>
        command.length === 3 && command[0] === 'npm' && command[1] === 'run' && command[2] === dependency);
    assert.ok(runs('validate:release', 'quality'));
    assert.ok(runs('quality', 'coverage'));
    assert.deepEqual(parseCommandChain(scripts.coverage), [['node', 'scripts/node-foundation/build-scripts.cjs', 'coverage.js', 'test']]);
    const release = resolveSelectedTestFiles(build, files, resolveCoverageTestArgs(root, 'test', []).slice(2));
    for (const file of files) assert.ok(release.includes(file), 'Release coverage omitted ' + file);
});
