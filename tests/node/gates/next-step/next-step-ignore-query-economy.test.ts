import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import { withInvocationReadObservation } from '../../../../src/core/invocation-read-observation';
import { withInvocationGitReadObservation } from '../../../../src/core/invocation-git-observation';
import { readCurrentProtectedScopeBeforePreflight } from '../../../../src/gates/next-step/next-step-protected-scope';
import { readPreflightWorkspaceReadiness } from '../../../../src/gates/next-step/next-step-preflight-workspace-readiness';
import { getWorkspaceSnapshot } from '../../../../src/gates/compile/compile-gate';
import { initGitRepo } from '../git-fixtures';
import { makeTempRepo, fileSha256, writeJson, TASK_ID } from './next-step-completion-fixtures';

const CONFIG = 'garda-agent-orchestrator/live/config/workflow-config.json';
const IGNORED_TEST = 'tests/ignored.test.ts';

/** Observe the real native command. No command result or gate input is mocked. */
function ignoreQueryCounter(t: TestContext) {
    const api = require('node:child_process') as typeof import('node:child_process');
    const original = api.spawnSync;
    let count = 0;
    t.mock.method(api, 'spawnSync', function (this: unknown, ...args: unknown[]) {
        if (typeof args[0] === 'string' && /^git(?:\.exe)?$/iu.test(path.basename(args[0]))
            && Array.isArray(args[1]) && args[1].includes('check-ignore')) count++;
        return Reflect.apply(original, this, args);
    });
    return () => count;
}

function observed<T>(read: () => T): T {
    return withInvocationGitReadObservation(() => withInvocationReadObservation(read));
}

function fixture() {
    const root = makeTempRepo();
    initGitRepo(root, { gitignoreContent: `garda-agent-orchestrator/runtime/\n${CONFIG}\n${IGNORED_TEST}\n` });
    fs.appendFileSync(path.join(root, 'src/app.ts'), 'export const changed = 2;\n');
    writeJson(path.join(root, 'garda-agent-orchestrator/runtime/protected-control-plane-manifest.json'), {
        protected_snapshot: { [CONFIG]: fileSha256(path.join(root, CONFIG)) }, protected_roots: [CONFIG]
    });
    return root;
}

function protectedScope(root: string) {
    return readCurrentProtectedScopeBeforePreflight(root, { changed_files: ['src/app.ts'] },
        () => { throw new Error('The caller already provided a native workspace snapshot.'); });
}

function preflight(root: string, scope = ['src/app.ts']): Record<string, unknown> {
    const snapshot = getWorkspaceSnapshot(root, 'explicit_changed_files', true, scope);
    return { ...snapshot, task_id: TASK_ID, mode: 'FULL_PATH', metrics: {
        ...snapshot, actual_changed_files: snapshot.changed_files,
        actual_changed_files_sha256: snapshot.changed_files_sha256
    } };
}

test('unchanged protected workflow bytes require no ignore subprocess', t => {
    const root = fixture(), calls = ignoreQueryCounter(t);
    assert.equal(observed(() => protectedScope(root)), null);
    assert.equal(calls(), 0);
});

test('changed ignored workflow configuration still requires native ignore evidence and remains protected', t => {
    const root = fixture(), calls = ignoreQueryCounter(t);
    fs.appendFileSync(path.join(root, CONFIG), '\n');
    const scope = observed(() => protectedScope(root));
    assert.deepEqual(scope?.protectedFiles, [CONFIG]);
    assert.deepEqual(scope?.workflowConfigFiles, [CONFIG]);
    assert.equal(calls(), 2, 'Initial and final native checks remain required for a consumed result.');
});

test('deleted protected workflow configuration is still detected through ignore evidence', t => {
    const root = fixture(), calls = ignoreQueryCounter(t);
    fs.unlinkSync(path.join(root, CONFIG));
    assert.deepEqual(observed(() => protectedScope(root))?.protectedFiles, [CONFIG]);
    assert.equal(calls(), 2);
});

test('adding a protected workflow file with no baseline hash still requires native ignore evidence', t => {
    const root = fixture(), calls = ignoreQueryCounter(t);
    writeJson(path.join(root, 'garda-agent-orchestrator/runtime/protected-control-plane-manifest.json'), {
        protected_snapshot: {}, protected_roots: [CONFIG]
    });
    assert.deepEqual(observed(() => protectedScope(root))?.protectedFiles, [CONFIG]);
    assert.equal(calls(), 2);
});

test('restoring original protected bytes removes only the unused ignore lookup', t => {
    const root = fixture(), calls = ignoreQueryCounter(t), config = path.join(root, CONFIG), original = fs.readFileSync(config);
    fs.appendFileSync(config, '\n');
    assert.ok(observed(() => protectedScope(root)));
    const consumed = calls();
    fs.writeFileSync(config, original);
    assert.equal(observed(() => protectedScope(root)), null);
    assert.equal(calls(), consumed);
});

test('protected bytes changed after an unchanged assessment still refuse publication', () => {
    const root = fixture();
    assert.throws(() => observed(() => {
        assert.equal(protectedScope(root), null);
        fs.appendFileSync(path.join(root, CONFIG), '\n');
    }), /changed|identity|observation|fresh|current/iu);
});

test('unavailable Git still refuses a required protected ignore lookup', () => {
    const root = fixture(); fs.appendFileSync(path.join(root, CONFIG), '\n');
    const previous = process.env.PATH;
    try {
        process.env.PATH = '';
        assert.throws(() => observed(() => protectedScope(root)), /native-unavailable/iu);
    } finally { process.env.PATH = previous; }
});

test('explicit preflight with all expected files in the fresh Git scope needs no ignore query', t => {
    const root = fixture(), evidence = preflight(root), calls = ignoreQueryCounter(t);
    const result = observed(() => readPreflightWorkspaceReadiness(root, evidence));
    assert.equal(result.ready, true, result.reason);
    assert.equal(calls(), 0);
});

test('explicit ignored test scope keeps native ignore evidence and content validation', t => {
    const root = fixture(); fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(root, IGNORED_TEST), 'test("isolation", () => {});\n');
    const evidence = preflight(root, ['src/app.ts', IGNORED_TEST]), calls = ignoreQueryCounter(t);
    const result = observed(() => readPreflightWorkspaceReadiness(root, evidence));
    assert.equal(result.ready, true, result.reason);
    assert.equal(calls(), 2);
    fs.appendFileSync(path.join(root, IGNORED_TEST), 'test("changed", () => {});\n');
    assert.equal(observed(() => readPreflightWorkspaceReadiness(root, evidence)).ready, false);
});

test('deleting an explicitly selected ignored test cannot be hidden by its ignore status', () => {
    const root = fixture(); fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(root, IGNORED_TEST), 'test("isolation", () => {});\n');
    const evidence = preflight(root, ['src/app.ts', IGNORED_TEST]);
    fs.unlinkSync(path.join(root, IGNORED_TEST));
    assert.equal(observed(() => readPreflightWorkspaceReadiness(root, evidence)).ready, false);
});

test('an additional Git change remains outside the accepted explicit preflight', () => {
    const root = fixture(), evidence = preflight(root);
    fs.writeFileSync(path.join(root, 'src/other.ts'), 'export const unexpected = true;\n');
    const result = observed(() => readPreflightWorkspaceReadiness(root, evidence));
    assert.equal(result.ready, false);
    assert.match(result.reason, /preflight|scope|changed/iu);
});
