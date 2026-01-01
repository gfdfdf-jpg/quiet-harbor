import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { splitCommandLine } from '../../../../../../src/core/command-line';
import { runClassifyChangeCommand } from '../../../../../../src/cli/commands/gates';
import { appendTaskEvent } from '../../../../../../src/gate-runtime/task-events';
import { resolveNextStep } from '../../../../../../src/gates/next-step';
import { preflightSnapshotPath, readLostPreflightSnapshot } from '../../../../../../src/gates/preflight/preflight-restoration';
import { createTempRepo, getOrchestratorRoot, initializeGitRepo, loadTaskEntryRulePack,
    readTaskTimelineEvents, runEnterTaskMode, runHandshakeForTask, runShellSmokeForTask,
    seedInitAnswers, seedTaskQueue } from './gates-preflight-fixtures';

function fixture(intent = 'Update app flow') {
    const repoRoot = createTempRepo();
    const taskId = 'T-preflight-restoration';
    fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n');
    fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# Instructions\n');
    initializeGitRepo(repoRoot);
    seedTaskQueue(repoRoot, taskId);
    seedInitAnswers(repoRoot);
    assert.equal(runEnterTaskMode({ repoRoot, taskId, provider: 'Codex', taskSummary: 'Update app flow' }).exitCode, 0);
    assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
    runHandshakeForTask(repoRoot, taskId);
    runShellSmokeForTask(repoRoot, taskId);
    fs.appendFileSync(path.join(repoRoot, 'src/app.ts'), '\nexport const changed = true;\n');
    const preflightPath = path.join(getOrchestratorRoot(repoRoot), 'runtime/reviews', `${taskId}-preflight.json`);
    const options = { repoRoot, taskId, taskIntent: intent, changedFiles: ['src/app.ts'],
        outputPath: preflightPath, emitMetrics: false };
    runClassifyChangeCommand(options);
    return { repoRoot, taskId, preflightPath, options };
}

test('next-step rebuilds lost preflight with its authenticated classified intent', () => {
    const intent = 'Preserve the custom classified task intent';
    const f = fixture(intent);
    try {
        const original = fs.readFileSync(f.preflightPath, 'utf8');
        for (const loss of ['delete', 'corrupt', 'stale']) {
            if (loss === 'delete') fs.unlinkSync(f.preflightPath);
            else if (loss === 'corrupt') fs.writeFileSync(f.preflightPath, '{broken');
            else {
                const stale = JSON.parse(original) as { task_intent: string; generated_utc: string;
                    effective_review_snapshot: { inputs: { task_intent: string } } };
                stale.task_intent = 'untrusted';
                stale.effective_review_snapshot.inputs.task_intent = 'untrusted';
                stale.generated_utc = '2000';
                fs.writeFileSync(f.preflightPath, JSON.stringify(stale));
                // A forged inner snapshot must still fail its own integrity check. Once removed,
                // the independently authenticated preflight snapshot can be restored normally.
                assert.throws(() => resolveNextStep({ repoRoot: f.repoRoot, taskId: f.taskId }),
                    /Effective review snapshot.*hash mismatch/u);
                fs.unlinkSync(f.preflightPath);
            }
            const route = resolveNextStep({ repoRoot: f.repoRoot, taskId: f.taskId });
            assert.equal(route.next_gate, 'classify-change', `${loss}: ${route.reason}`);
            const argv = splitCommandLine(route.commands[0].command);
            const taskIntent = argv[argv.indexOf('--task-intent') + 1];
            assert.equal(taskIntent, intent, `${loss}: ${route.commands[0].command}`);
            const changedFiles = argv.flatMap((arg, index) => arg === '--changed-file' ? [argv[index + 1]] : []);
            runClassifyChangeCommand({ ...f.options, taskIntent, changedFiles });
            assert.equal(fs.readFileSync(f.preflightPath, 'utf8'), original, loss);
        }
        const events = readTaskTimelineEvents(f.repoRoot, f.taskId);
        assert.equal(events.filter(event => event.event_type === 'PREFLIGHT_CLASSIFIED').length, 1);
        assert.equal(events.filter(event => event.event_type === 'PREFLIGHT_EVIDENCE_RESTORED').length, 3);
    } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('lost or corrupt preflight restores the authenticated classification for the same tree', () => {
    const f = fixture();
    try {
        const original = fs.readFileSync(f.preflightPath, 'utf8');
        for (const loss of ['delete', 'corrupt', 'stale']) {
            if (loss === 'delete') fs.unlinkSync(f.preflightPath);
            else if (loss === 'corrupt') fs.writeFileSync(f.preflightPath, '{broken');
            else fs.writeFileSync(f.preflightPath, JSON.stringify({ ...JSON.parse(original), generated_utc: '2000' }));
            assert.ok(readLostPreflightSnapshot(f.repoRoot, f.taskId, f.preflightPath), `missing retained snapshot: ${loss}`);
            runClassifyChangeCommand(f.options);
            assert.deepEqual(JSON.parse(fs.readFileSync(f.preflightPath, 'utf8')), JSON.parse(original), loss);
            assert.equal(fs.readFileSync(f.preflightPath, 'utf8'), original, loss);
        }
        const events = readTaskTimelineEvents(f.repoRoot, f.taskId);
        assert.equal(events.filter(event => event.event_type === 'PREFLIGHT_CLASSIFIED').length, 1);
        assert.equal(events.filter(event => event.event_type === 'PREFLIGHT_EVIDENCE_RESTORED').length, 3);
    } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('a changed tree, changed classification or unauthenticated snapshot does not restore the old classification', () => {
    for (const mutation of ['tree', 'classification', 'snapshot']) {
        const f = fixture();
        try {
            const original = fs.readFileSync(f.preflightPath, 'utf8');
            fs.unlinkSync(f.preflightPath);
            if (mutation === 'tree') fs.appendFileSync(path.join(f.repoRoot, 'src/app.ts'), '// changed again\n');
            if (mutation === 'snapshot') fs.writeFileSync(preflightSnapshotPath(f.preflightPath), '{tampered');
            runClassifyChangeCommand(mutation === 'classification'
                ? { ...f.options, taskIntent: 'Refactor the application' } : f.options);
            const events = readTaskTimelineEvents(f.repoRoot, f.taskId);
            assert.equal(events.filter(event => event.event_type === 'PREFLIGHT_EVIDENCE_RESTORED').length, 0, mutation);
            assert.equal(events.filter(event => event.event_type === 'PREFLIGHT_CLASSIFIED').length, 2, mutation);
            const eventTypes = events.map(event => event.event_type);
            const latestStart = eventTypes.lastIndexOf('PREFLIGHT_STARTED');
            const latestClassification = eventTypes.lastIndexOf('PREFLIGHT_CLASSIFIED');
            assert.ok(latestStart >= 0 && latestStart < latestClassification, mutation);
            if (mutation !== 'snapshot') assert.notEqual(fs.readFileSync(f.preflightPath, 'utf8'), original);
        } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
    }
});

test('next-step refreshes a parseable stale preflight whose scope still matches', () => {
    const f = fixture();
    try {
        const original = fs.readFileSync(f.preflightPath, 'utf8');
        fs.writeFileSync(f.preflightPath, JSON.stringify({ ...JSON.parse(original), generated_utc: '2000' }));
        const decision = resolveNextStep({ repoRoot: f.repoRoot, taskId: f.taskId });
        assert.equal(decision.next_gate, 'classify-change', decision.reason);
        runClassifyChangeCommand(f.options);
        assert.equal(fs.readFileSync(f.preflightPath, 'utf8'), original);
    } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('an older classification can reconstruct exact preflight bytes from an authenticated compile binding', () => {
    for (const mutation of ['none', 'tree', 'history']) {
        const f = fixture();
        try {
            const original = fs.readFileSync(f.preflightPath, 'utf8');
            const payload = JSON.parse(original) as Record<string, unknown>;
            const events = readTaskTimelineEvents(f.repoRoot, f.taskId);
            const classified = [...events].reverse().find(event => event.event_type === 'PREFLIGHT_CLASSIFIED');
            assert.ok(classified);
            const legacyDetails = { ...(classified.details as Record<string, unknown>) };
            delete legacyDetails.output_sha256;
            appendTaskEvent(getOrchestratorRoot(f.repoRoot), f.taskId, 'PREFLIGHT_CLASSIFIED', 'INFO', 'legacy classification', legacyDetails);
            appendTaskEvent(getOrchestratorRoot(f.repoRoot), f.taskId, 'COMPILE_GATE_PASSED', 'PASS', 'legacy compile', {
                preflight_path: f.preflightPath.replace(/\\/gu, '/'),
                preflight_hash_sha256: createHash('sha256').update(original).digest('hex'),
                preflight_detection_source: payload.detection_source,
                scope_authorized_files: payload.authorized_files,
                scope_changed_files: payload.changed_files
            });
            fs.unlinkSync(preflightSnapshotPath(f.preflightPath));
            fs.unlinkSync(f.preflightPath);
            if (mutation === 'tree') fs.appendFileSync(path.join(f.repoRoot, 'src/app.ts'), '// changed again\n');
            if (mutation === 'history') {
                fs.appendFileSync(path.join(getOrchestratorRoot(f.repoRoot), 'runtime/task-events', `${f.taskId}.jsonl`), '{tampered\n');
                assert.equal(readLostPreflightSnapshot(f.repoRoot, f.taskId, f.preflightPath), null);
                continue;
            }
            const candidate = readLostPreflightSnapshot(f.repoRoot, f.taskId, f.preflightPath);
            assert.ok(candidate);
            assert.equal(candidate.text, null);
            runClassifyChangeCommand(f.options);
            const restored = readTaskTimelineEvents(f.repoRoot, f.taskId)
                .filter(event => event.event_type === 'PREFLIGHT_EVIDENCE_RESTORED');
            assert.equal(restored.length, mutation === 'tree' ? 0 : 1);
            if (mutation === 'none') assert.equal(fs.readFileSync(f.preflightPath, 'utf8'), original);
            else assert.notEqual(fs.readFileSync(f.preflightPath, 'utf8'), original);
        } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
    }
});
