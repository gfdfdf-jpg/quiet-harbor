import * as hashes from '../../../../../../src/core/file-hashing';
import { execFileSync } from 'node:child_process';
import { getTaskModeEvidence } from '../../../../../../src/gates/task-mode/task-mode-evidence';
import { runEnterTaskMode } from '../../gate-test-helpers';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { runGit } from '../../../../../../src/core/git-helpers';
import { classifyGitChanges } from '../../../../../../src/core/git-change-classification';
import { filterBuildOutputScopePaths } from '../../../../../../src/core/build-output-paths';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../../../../src/core/next-step-measurement';
import { withInvocationReadObservation } from '../../../../../../src/core/invocation-read-observation';
import { resolveCanonicalTaskPlanPath } from '../../../../../../src/core/task-plan-read';
import { serializeTaskPlan, validateTaskPlan } from '../../../../../../src/schemas/task-plan';
import { serializeRedactedJson } from '../../../../../../src/core/redaction';
import {
    createWorkspaceSnapshotGitGeneration, getWorkspaceSnapshot
} from '../../../../../../src/gates/compile/compile-gate';
import {
    createWorkspaceSnapshotRequest, getWorkspaceSnapshotCached
} from '../../../../../../src/gates/workspace/workspace-snapshot-cache';
import { buildGitDiffSummary } from '../../../../../../src/gates/review-context/review-context-diff';
import { buildReviewTreeState } from '../../../../../../src/gates/review/review-tree-state';
import { scopeEntryFixture, writeScopeFile } from '../../../../scope-integrity-fixtures';

// P3 / T-428: a declaration of an exact source survives a build-like directory name.
test('P3 T-428 native entry keeps exact planned sources visible across scope and review consumers', t => {
    const f = scopeEntryFixture(t);
    const sources = ['bin/release.sh', 'nested/build/generate.py', 'out/handwritten.ts', 'dist/publish.sh'];
    f.enter(sources);
    for (const file of sources) writeScopeFile(f.root, file, 'planned source\n');
    const outputs = ['bin/Debug/app.dll', 'dist/other.sh', 'target/bin/generated.rs',
        'build/__pycache__/main.pyc', 'bin/node_modules/package.js'];
    for (const file of outputs) writeScopeFile(f.root, file, 'generated output\n');
    assert.deepEqual(filterBuildOutputScopePaths(f.root, [...sources, ...outputs]), sources);
    for (const file of sources) assert.ok(classifyGitChanges(f.root).untrackedFiles.includes(file), file);
    const snapshot = getWorkspaceSnapshot(f.root, 'git_auto', true, []);
    for (const file of sources) assert.ok(snapshot.changed_files.includes(file), file);
    const preflight = { task_id: f.taskId, detection_source: 'git_auto', changed_files: sources };
    const preflightPath = path.join(f.root, 'garda-agent-orchestrator/runtime/reviews', `${f.taskId}-preflight.json`);
    fs.writeFileSync(preflightPath, JSON.stringify(preflight));
    const diff = buildGitDiffSummary(f.root, sources, preflight, preflightPath);
    assert.match(diff.diff || '', /planned source/u);
    assert.doesNotMatch(diff.diff || '', /generated output/u);
    const tree = buildReviewTreeState({ repoRoot: f.root, detectionSource: 'git_auto', includeUntracked: true,
        changedFiles: sources });
    assert.deepEqual(tree.changed_files, [...sources].sort());
});

test('P3 T-428 attached approved plan publishes exact visibility without a second explicit declaration', t => {
    const f = scopeEntryFixture(t);
    const planPath = resolveCanonicalTaskPlanPath(f.root, f.taskId);
    writeScopeFile(f.root, path.relative(f.root, planPath), serializeTaskPlan(validateTaskPlan({
        schema_version: 1, task_id: f.taskId, status: 'approved', goal: 'P3 scope integrity regression',
        scope_files: ['bin/release.sh'], risk_level: 'low', steps: [{ id: 'one', title: 'Write the release script' }],
        acceptance_criteria: ['Keep declared sources visible'], verification_expectations: ['Focused scope test'],
        out_of_scope: ['Generated binaries']
    })));
    f.enter([], { planPath });
    writeScopeFile(f.root, 'bin/release.sh');
    writeScopeFile(f.root, 'bin/other.sh');
    const snapshot = getWorkspaceSnapshot(f.root, 'git_auto', true, []);
    assert.ok(snapshot.changed_files.includes('bin/release.sh'));
    assert.ok(!snapshot.changed_files.includes('bin/other.sh'));
});

test('P3 T-428 planned visibility changes invalidate persisted scope and retained read generations', t => {
    const f = scopeEntryFixture(t);
    f.enter(['src/app.ts']);
    writeScopeFile(f.root, 'bin/release.sh');
    const before = getWorkspaceSnapshotCached(f.root, 'git_auto', true, []);
    assert.ok(!before.changed_files.includes('bin/release.sh'));
    const request = createWorkspaceSnapshotRequest(f.root);
    request.read('git_auto', true, []);
    const generation = createWorkspaceSnapshotGitGeneration(f.root);
    getWorkspaceSnapshot(f.root, 'git_auto', true, [], generation);
    f.enter(['src/app.ts', 'bin/release.sh'], { upgradeExistingTaskMode: true });
    const after = getWorkspaceSnapshotCached(f.root, 'git_auto', true, []);
    assert.ok(after.changed_files.includes('bin/release.sh'));
    assert.equal(after.cache_hit, false);
    assert.throws(() => request.read('git_auto', true, []), /planned|scope|generation/iu);
    assert.throws(() => getWorkspaceSnapshot(f.root, 'git_auto', true, [], generation), /planned|authenticated|generation/iu);
});

test('P3 T-428 repeated reads in a stable generation add zero Git ACL or filesystem probes', t => {
    const f = scopeEntryFixture(t);
    f.enter(['bin/release.sh']);
    writeScopeFile(f.root, 'bin/release.sh');
    runGit(f.root, ['add', '--', 'bin/release.sh']);
    withInvocationReadObservation(() => {
        const request = createWorkspaceSnapshotRequest(f.root);
        const first = request.read('git_auto', true, []);
        assert.ok(first.changed_files.includes('bin/release.sh'), 'the budget must be tested on retained planned source');
        let measurement: NextStepMeasurement | undefined;
        withNextStepMeasurement(() => {
            for (let index = 0; index < 5; index++) assert.deepEqual(request.read('git_auto', true, []), first);
        }, value => { measurement = value; });
        assert.ok(measurement);
        const extra = Object.entries(measurement.work).filter(([key, count]) => count > 0
            && /^(?:process:|payload_read:)/u.test(key));
        assert.deepEqual(extra, [], 'visibility must be captured once per stable read generation');
        assert.deepEqual(Object.entries(measurement.io || {}).filter(([, value]) => value.count > 0), [],
            'repeated reads must not reopen metadata or repeat filesystem probes');
    });
});

// P3 / T-456: native identity maps preserve exact paths; ordinary values remain redacted.
for (const staged of [false, true]) {
    test(`P3 T-456 native ${staged ? 'staged' : 'unstaged'} baseline preserves path-keyed digests and protected continuation`, t => {
        const f = scopeEntryFixture(t, true);
        const files = ['src/core/auth/token.ts', 'src/credentials/password.ts', 'src/secrets/api-key.ts'];
        for (const file of files) writeScopeFile(f.root, file, 'export const local = 1;\n');
        runGit(f.root, ['add', '--', ...files]);
        runGit(f.root, ['commit', '-m', 'seed sensitive-looking paths']);
        for (const file of files) writeScopeFile(f.root, file, 'export const local = 2;\n');
        if (staged) runGit(f.root, ['add', '--', ...files]);
        const indexBefore = f.index();
        f.enter(['src/app.ts'], { taskSummary: 'P3 API_TOKEN=p3-fixture-secret' });
        const artifact = f.readEntry();
        const baseline = artifact.dirty_workspace_baseline;
        for (const file of files) {
            const expected = createHash('sha256').update(fs.readFileSync(path.join(f.root, file))).digest('hex');
            assert.ok(baseline.changed_files.includes(file));
            assert.equal(baseline.file_hashes[file], expected, file);
            assert.ok(!baseline.entry_authorized_files.includes(file));
            if (staged) {
                const witness = baseline.staged_trust.files[file];
                assert.equal(witness.status, 'present');
                for (const key of ['object_id_sha256', 'content_sha256', 'line_fingerprint_sha256'])
                    assert.match(witness[key], /^[a-f0-9]{64}$/u);
            }
        }
        const serialized = fs.readFileSync(f.artifactPath, 'utf8');
        assert.doesNotMatch(serialized, /p3-fixture-secret/u);
        assert.equal(serialized.trimEnd().split('\n').length, 1, 'preserve compact publication in 1.4.4');
        t.mock.method(Date, 'now', () => Date.parse(f.confirmedAt) + 11 * 60_000);
        f.enter(['src/app.ts'], { taskSummary: 'P3 API_TOKEN=p3-fixture-secret', upgradeExistingTaskMode: true,
            operatorConfirmed: undefined, operatorConfirmedAtUtc: undefined });
        assert.deepEqual(f.readEntry().dirty_workspace_baseline, baseline);
        assert.equal(f.index(), indexBefore, 'publication and continuation must preserve index custody');
    });
}

test('P3 T-456 arbitrary caller JSON never gains a native digest-map redaction exemption', () => {
    const payload = { event_source: 'enter-task-mode', status: 'PASSED', outcome: 'PASS', task_id: 'T-P3-SCOPE',
        dirty_workspace_baseline: { changed_files: ['src/auth/token.ts'],
            file_hashes: { 'src/auth/token.ts': 'a'.repeat(64) },
            staged_trust: { schema_version: 1, salt: 'p3-fixture-salt', files: { 'src/auth/token.ts': {
                schema_version: 1, status: 'present', mode: '100644', object_id_sha256: 'b'.repeat(64),
                content_sha256: 'c'.repeat(64), line_fingerprint_sha256: 'd'.repeat(64)
            } } } },
        workflow_config_file_hashes: { 'garda-agent-orchestrator/live/config/workflow-config.json': 'e'.repeat(64) },
        metadata: { api_token: 'p3-value-secret' },
        api_token: 'p3-outer-secret', task_summary: 'API_TOKEN=p3-summary-secret' };
    const output = serializeRedactedJson(payload);
    assert.doesNotMatch(output, /p3-(?:value|outer|summary)-secret/u);
    assert.equal(JSON.parse(output).dirty_workspace_baseline.file_hashes['src/auth/token.ts'], '<redacted>');
});

for (const linkedMetadata of [false, true]) {
    test(`P3 T-428 fresh process restores native visibility with ${linkedMetadata ? 'linked' : 'ordinary'} Git metadata`, t => {
        const f = scopeEntryFixture(t);
        if (linkedMetadata) {
            fs.renameSync(path.join(f.root, '.git'), path.join(f.root, '.git-storage'));
            fs.writeFileSync(path.join(f.root, '.git'), 'gitdir: .git-storage\n');
            fs.appendFileSync(path.join(f.root, '.gitignore'), '.git-storage/\n');
        }
        f.enter(['nested/bin/release.sh']);
        writeScopeFile(f.root, 'nested/bin/release.sh');
        writeScopeFile(f.root, 'nested/bin/other.sh');
        const output = execFileSync(process.execPath, ['-e', `
            const evidence = require(process.argv[1]).getTaskModeEvidence(process.argv[3], process.argv[4]);
            if (evidence.evidence_status !== 'PASS') throw new Error(evidence.evidence_status);
            const snapshot = require(process.argv[2]).getWorkspaceSnapshot(process.argv[3], 'git_auto', true, []);
            process.stdout.write(JSON.stringify(snapshot.changed_files));
        `, require.resolve('../../../../../../src/gates/task-mode/task-mode-evidence'),
        require.resolve('../../../../../../src/gates/compile/compile-gate'), f.root, f.taskId], { encoding: 'utf8' });
        const files = JSON.parse(output) as string[];
        assert.ok(files.includes('nested/bin/release.sh'));
        assert.ok(!files.includes('nested/bin/other.sh'));
    });
}

test('P3 T-428 modified native visibility metadata cannot retain a foreign scope hint', t => {
    const f = scopeEntryFixture(t);
    f.enter(['bin/release.sh']);
    writeScopeFile(f.root, 'bin/release.sh');
    writeScopeFile(f.root, 'bin/foreign.sh');
    const artifact = f.readEntry();
    artifact.planned_changed_files.push('bin/foreign.sh');
    fs.writeFileSync(f.artifactPath, JSON.stringify(artifact));
    assert.equal(getTaskModeEvidence(f.root, f.taskId).evidence_status, 'EVIDENCE_PLANNED_SCOPE_MISMATCH');
    assert.deepEqual(filterBuildOutputScopePaths(f.root, ['bin/release.sh', 'bin/foreign.sh']), []);
});

test('P3 T-428 native refusal publishes no new planned-source hint', t => {
    const f = scopeEntryFixture(t);
    assert.throws(() => runEnterTaskMode({ repoRoot: f.root, taskId: f.taskId, provider: 'Codex',
        taskSummary: 'Refused protected source scope', plannedChangedFiles: ['bin/refused.sh'],
        orchestratorWork: true, emitMetrics: false }), /confirmation|protected/u);
    writeScopeFile(f.root, 'bin/refused.sh');
    assert.deepEqual(filterBuildOutputScopePaths(f.root, ['bin/refused.sh']), []);
});

test('P3 T-428 external metadata replacement invalidates the invocation after retained scope reads', t => {
    const f = scopeEntryFixture(t);
    f.enter(['bin/release.sh']);
    writeScopeFile(f.root, 'bin/release.sh');
    assert.throws(() => withInvocationReadObservation(() => {
        assert.equal(getTaskModeEvidence(f.root, f.taskId).evidence_status, 'PASS');
        const request = createWorkspaceSnapshotRequest(f.root);
        assert.ok(request.read('git_auto', true, []).changed_files.includes('bin/release.sh'));
        execFileSync(process.execPath, ['-e', `const fs = require('node:fs');
            fs.writeFileSync(process.argv[1], fs.readFileSync(process.argv[1], 'utf8') + ' ');`, f.artifactPath]);
        request.read('git_auto', true, []);
    }), /changed|snapshot|observation/iu);
});

test('P3 T-428 approved-plan visibility preserves an existing build-like dirty baseline without granting ownership', t => {
    const f = scopeEntryFixture(t);
    const planPath = resolveCanonicalTaskPlanPath(f.root, f.taskId);
    writeScopeFile(f.root, path.relative(f.root, planPath), serializeTaskPlan(validateTaskPlan({
        schema_version: 1, task_id: f.taskId, status: 'approved', goal: 'Preserve the existing planned source baseline',
        scope_files: ['bin/release.sh'], risk_level: 'low', steps: [{ id: 'one', title: 'Adjust release source' }]
    })));
    fs.appendFileSync(path.join(f.root, '.gitignore'), 'bin/\n');
    writeScopeFile(f.root, 'bin/release.sh', 'pre-existing local source\n');
    f.enter([], { planPath });
    const baseline = f.readEntry().dirty_workspace_baseline;
    assert.ok(baseline.changed_files.includes('bin/release.sh'));
    assert.match(baseline.file_hashes['bin/release.sh'], /^[a-f0-9]{64}$/u);
    assert.ok(!baseline.entry_authorized_files.includes('bin/release.sh'));
});

test('P3 T-428 malformed approved source scope refuses before native artifact publication', t => {
    const f = scopeEntryFixture(t);
    const planPath = resolveCanonicalTaskPlanPath(f.root, f.taskId);
    writeScopeFile(f.root, path.relative(f.root, planPath), serializeTaskPlan(validateTaskPlan({
        schema_version: 1, task_id: f.taskId, status: 'approved', goal: 'Reject an escaping planned source',
        scope_files: ['../bin/foreign.sh'], risk_level: 'low', steps: [{ id: 'one', title: 'Rejected source' }]
    })));
    assert.throws(() => runEnterTaskMode({ repoRoot: f.root, taskId: f.taskId, provider: 'Codex',
        taskSummary: 'Reject malformed source scope', planPath, emitMetrics: false }), /planned-source|canonical|scope/u);
    assert.equal(fs.existsSync(f.artifactPath), false);
});

test('P3 T-428 external same-scope native re-entry invalidates retained readers after the existing entry read', t => {
    const f = scopeEntryFixture(t);
    const files = ['bin/release.sh'];
    f.enter(files);
    writeScopeFile(f.root, files[0]);
    const request = createWorkspaceSnapshotRequest(f.root);
    assert.ok(request.read('git_auto', true, []).changed_files.includes(files[0]));
    const generation = createWorkspaceSnapshotGitGeneration(f.root);
    getWorkspaceSnapshot(f.root, 'git_auto', true, [], generation);
    assert.equal(getTaskModeEvidence(f.root, f.taskId).evidence_status, 'PASS');
    assert.ok(request.read('git_auto', true, []).changed_files.includes(files[0]),
        'hydration of unchanged native bytes must retain the publication identity');
    getWorkspaceSnapshot(f.root, 'git_auto', true, [], generation);
    execFileSync(process.execPath, ['-e', `
        const result = require(process.argv[1]).runEnterTaskMode({ repoRoot: process.argv[2], taskId: process.argv[3],
            provider: 'Codex', taskSummary: 'P3 scope integrity regression', plannedChangedFiles: ['bin/release.sh'],
            upgradeExistingTaskMode: true, emitMetrics: false });
        if (result.exitCode) throw new Error(result.outputLines.join('\\n'));
    `, require.resolve('../../gate-test-helpers'), f.root, f.taskId], { encoding: 'utf8' });
    assert.equal(getTaskModeEvidence(f.root, f.taskId).evidence_status, 'PASS');
    assert.throws(() => request.read('git_auto', true, []), /planned-source scope changed/u);
    assert.throws(() => getWorkspaceSnapshot(f.root, 'git_auto', true, [], generation), /planned-source scope changed/u);
});

test('P3 T-428 unavailable native entry digest never becomes empty visibility authority', t => {
    const f = scopeEntryFixture(t);
    f.enter(['bin/release.sh']);
    const original = hashes.fileSha256;
    t.mock.method(hashes, 'fileSha256', (...args: Parameters<typeof original>) =>
        path.resolve(String(args[0])) === path.resolve(f.artifactPath) ? null : original(...args));
    assert.throws(() => getTaskModeEvidence(f.root, f.taskId), /requires the task-mode entry digest/u);
});
