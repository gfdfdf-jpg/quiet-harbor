import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as git from '../../../../src/core/git-helpers';
import * as subprocess from '../../../../src/core/process/subprocess';
import { resolveNextStep } from '../../../../src/gates/next-step/next-step';
import { readHeadSha } from '../../../../src/gates/workspace/workspace-snapshot-cache';
import { createNextStepLongHistoryFixture } from '../next-step/next-step-long-history-fixture';
import { scopeGitFixture } from '../../scope-integrity-fixtures';

test('P3 native next-step preserves a Git authority failure and recovers on the same narrow route', t => {
    const fixture = createNextStepLongHistoryFixture(0);
    t.after(() => fs.rmSync(fixture.repoRoot, { recursive: true, force: true }));
    const options = { repoRoot: fixture.repoRoot, taskId: fixture.taskId };
    const before = resolveNextStep(options);
    const original = git.runGitBinary;
    let injected = 0;
    const mocked = t.mock.method(git, 'runGitBinary', (...args: Parameters<typeof original>) => {
        if (args[1].includes('status')) {
            injected++;
            return original(path.join(args[0], 'missing-git-authority'), args[1], args[2]);
        }
        return original(...args);
    });
    assert.throws(() => resolveNextStep(options), /git (?:--no-pager )?status .*failed/iu,
        'The native boundary must preserve the actual failed query instead of accepting an empty scope.');
    assert.ok(injected);
    mocked.mock.restore();
    assert.equal(resolveNextStep(options).next_gate, before.next_gate);
});

for (const failure of ['exit', 'timeout', 'signal', 'buffer', 'type', 'malformed'] as const) {
    test(`P3 snapshot HEAD authority rejects ${failure} with successful-looking stdout`, t => {
        const root = scopeGitFixture(t), original = subprocess.spawnSyncWithTimeout;
        t.mock.method(subprocess, 'spawnSyncWithTimeout', (...args: Parameters<typeof original>) => {
            const result = original(...args);
            if (args[0] === 'git' && args[1].includes('rev-parse')) {
                if (failure === 'exit') result.status = 128;
                if (failure === 'timeout') result.timedOut = true;
                if (failure === 'signal') result.signal = 'SIGTERM';
                if (failure === 'buffer') result.error = new Error('partial output');
                if (failure === 'type') Object.assign(result, { stdout: Buffer.from('a'.repeat(40)) });
                if (failure === 'malformed') result.stdout = 'a'.repeat(41);
            }
            return result;
        });
        assert.throws(() => readHeadSha(root), /git rev-parse HEAD failed.*Diagnose with:/isu);
    });
}


test('a cold navigator hydrates authenticated planned scope before capturing its workspace generation', t => {
    const f = createNextStepLongHistoryFixture(0);
    t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    const expected = resolveNextStep({ repoRoot: f.repoRoot, taskId: f.taskId });
    const script = "const {resolveNextStep}=require(process.argv[1]); const r=resolveNextStep({repoRoot:process.argv[2],taskId:process.argv[3]}); console.log(JSON.stringify({gate:r.next_gate,status:r.status}));";
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_CONFIG(?:_|$)|^NODE_TEST_/iu.test(key)));
    const result = spawnSync(process.execPath, ['-e', script, require.resolve('../../../../src/gates/next-step/next-step'), f.repoRoot, f.taskId],
        { cwd: f.repoRoot, env: environment, encoding: 'utf8', timeout: 60_000, windowsHide: true });
    assert.equal(result.status, 0, String(result.stderr || result.stdout || result.error));
    assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1)!), { gate: expected.next_gate, status: expected.status });
});
