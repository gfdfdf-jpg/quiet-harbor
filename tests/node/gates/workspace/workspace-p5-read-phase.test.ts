import { publishWorkspacePlannedFiles } from '../../../../src/core/workspace-planned-files';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { withInvocationReadObservation } from '../../../../src/core/invocation-read-observation';
import { withInvocationGitReadObservation } from '../../../../src/core/invocation-git-observation';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../../src/core/next-step-measurement';
import { createWorkspaceSnapshotRequest, createDeferredWorkspaceSnapshotRequest, type WorkspaceSnapshotRequest } from '../../../../src/gates/workspace/workspace-snapshot-cache';

test('P5 T-415-1 one workspace observation per stable phase, fresh observation after mutation', async t => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-p5-phase-'));
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const git = (...args: string[]) => execFileSync('git', ['-C', repoRoot, ...args], { stdio: 'pipe' });
    git('init', '-q'); git('config', 'user.name', 'P5'); git('config', 'user.email', 'p5@example.invalid');
    const file = path.join(repoRoot, 'source.ts');
    fs.writeFileSync(file, 'export const value = 0;\n');
    git('add', '.'); git('commit', '-qm', 'fixture');
    let priorRequest: WorkspaceSnapshotRequest | undefined;
    const repeatMeasurements: NextStepMeasurement[] = [];
    const phases = [1, 2].map(value => {
        fs.writeFileSync(file, 'export const value = ' + value + ';\n');
        let measured: NextStepMeasurement | undefined;
        const snapshot = withInvocationGitReadObservation(() => withInvocationReadObservation(() => {
            const request = createWorkspaceSnapshotRequest(repoRoot);
            assert.notEqual(request, priorRequest, 'A new phase cannot retain the earlier generation');
            priorRequest = request;
            const first = request.read('explicit_changed_files', false, ['source.ts']);
            withNextStepMeasurement(() => {
                for (let repeat = 0; repeat < 8; repeat++) {
                    assert.equal(createWorkspaceSnapshotRequest(repoRoot), request);
                    assert.equal(request.read('explicit_changed_files', false, ['source.ts']), first);
                }
            }, result => { measured = result; });
            assert.ok(Object.isFrozen(first));
            return first;
        }));
        assert.ok(measured);
        repeatMeasurements.push(measured);
        assert.deepEqual(Object.keys(measured.work).filter(key => /^(?:process:|file_hash:|payload_read:)/u.test(key)), []);
        return snapshot;
    });
    assert.notEqual(phases[0].scope_content_sha256, phases[1].scope_content_sha256,
        'The second phase must observe the changed source bytes');
    await t.test('T-415-1 repeated consumers add no probes (RED on base)', () => {
        t.diagnostic(JSON.stringify(repeatMeasurements.map(measured => measured.io)));
        assert.deepEqual(repeatMeasurements.map(measured => measured.io), [undefined, undefined]);
    });
});


test('unused navigator requests perform no hydration; first use keeps native generation revocation', t => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-deferred-workspace-'));
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const git = (...args: string[]) => execFileSync('git', ['-C', repoRoot, ...args], { stdio: 'pipe' });
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(repoRoot, 'source.ts'), 'export const value = 0;\n');
    git('add', '.'); git('commit', '-qm', 'fixture');
    let revokedAfterRead = false;
    assert.throws(() => withInvocationGitReadObservation(() => withInvocationReadObservation(() => {
        let hydrated = 0;
        const request = createDeferredWorkspaceSnapshotRequest(repoRoot, () => {
            hydrated++; publishWorkspacePlannedFiles(repoRoot, 'T-DEFERRED', ['source.ts'], '', 'a'.repeat(64));
        });
        assert.equal(hydrated, 0);
        const first = request.read('explicit_changed_files', false, ['source.ts']);
        assert.equal(request.read('explicit_changed_files', false, ['source.ts']), first);
        assert.equal(hydrated, 1);
        publishWorkspacePlannedFiles(repoRoot, 'T-DEFERRED', ['source.ts'], '', 'b'.repeat(64));
        assert.throws(() => request.read('explicit_changed_files', false, ['source.ts']), /planned-source scope changed/u);
        revokedAfterRead = true;
    })), /planned-source scope changed/u);
    assert.equal(revokedAfterRead, true);
});
