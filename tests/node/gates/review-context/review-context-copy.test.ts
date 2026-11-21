import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canRestoreReviewContextCopy, canRestoreReviewerInputsBeforeHandoff, preserveReviewContextCopy, restoreReviewContextCopy,
    findRestorableReviewContexts, findReviewContextRecoveryCandidates, readPreservedReviewContextCopy,
    sameReviewContextPath } from '../../../../src/gates/review/review-artifact-recovery';
import type { ReviewArtifactState } from '../../../../src/gates/next-step/next-step-review-artifact-readers';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';

test('event paths respect the filesystem case rules', () => {
    const canonical = '/repo/runtime/reviews/T-COPY-code-review-context.json';
    const differentlyCased = '/repo/runtime/reviews/t-copy-code-review-context.json';
    assert.equal(sameReviewContextPath(canonical, differentlyCased, 'linux'), false);
    assert.equal(sameReviewContextPath(canonical, differentlyCased, 'win32'), true);
    assert.equal(sameReviewContextPath(canonical, '/repo/runtime/reviews/another.json', 'win32'), false);
});

test('a context copy needs its external digest, the canonical destination and unchanged damaged bytes', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-context-copy-'));
    try {
        const reviews = path.join(repoRoot, 'runtime', 'reviews');
        fs.mkdirSync(reviews, { recursive: true });
        const contextPath = path.join(reviews, 'T-COPY-code-review-context.json');
        const options = { repoRoot, taskId: 'T-COPY', reviewType: 'code', contextPath };
        const text = '{"reviewed":"original"}\n';
        const digest = crypto.createHash('sha256').update(text).digest('hex');
        const copy = path.join(repoRoot, 'runtime', 'tmp', '.review-context-cache', options.taskId, digest);
        fs.writeFileSync(contextPath, text);
        preserveReviewContextCopy(options, text);
        assert.equal(fs.readFileSync(copy, 'utf8'), text);
        fs.unlinkSync(contextPath);
        assert.equal(canRestoreReviewContextCopy(options, ''), false);
        assert.equal(canRestoreReviewContextCopy(options, 'a'.repeat(64)), false);
        assert.equal(restoreReviewContextCopy({ ...options, contextPath: path.join(reviews, 'other.json') }, digest, null), false);
        assert.equal(restoreReviewContextCopy(options, digest, null), true);
        assert.equal(fs.readFileSync(contextPath, 'utf8'), text);
        fs.writeFileSync(contextPath, 'damage');
        assert.equal(restoreReviewContextCopy(options, digest, null), false, 'do not overwrite a concurrently changed file');
        const damaged = crypto.createHash('sha256').update('damage').digest('hex');
        fs.writeFileSync(copy, 'tampered copy');
        assert.equal(restoreReviewContextCopy(options, digest, damaged), false);
        assert.equal(fs.readFileSync(contextPath, 'utf8'), 'damage');
        fs.unlinkSync(copy);
        assert.equal(restoreReviewContextCopy(options, digest, damaged), false);
        const legacy = path.join(repoRoot, 'runtime', 'tmp', '.review-context-cache', digest);
        fs.writeFileSync(legacy, text);
        assert.equal(readPreservedReviewContextCopy(options, digest)?.toString('utf8'), text);
        fs.writeFileSync(legacy, 'tampered legacy copy');
        assert.equal(readPreservedReviewContextCopy(options, digest), null);
        fs.writeFileSync(legacy, text);
        assert.equal(restoreReviewContextCopy(options, digest, damaged), true, 'an older open task can still use its verified copy');
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});

test('only a verified native event pins a copy; old events without a hash and broken histories do not', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-context-events-'));
    try {
        const taskId = 'T-COPY';
        const reviews = path.join(repoRoot, 'runtime', 'reviews');
        const eventsRoot = path.join(repoRoot, 'runtime', 'task-events');
        fs.mkdirSync(reviews, { recursive: true });
        const contextPath = path.join(reviews, `${taskId}-code-review-context.json`);
        const text = '{"reviewed":"original"}\n';
        const sha = crypto.createHash('sha256').update(text).digest('hex');
        fs.writeFileSync(contextPath, text);
        preserveReviewContextCopy({ repoRoot, taskId, reviewType: 'code', contextPath }, text);
        fs.unlinkSync(contextPath);
        const state = { reviewType: 'code', contextPath } as ReviewArtifactState;
        const options = { repoRoot, eventsRoot, taskId, states: [state] };
        appendTaskEvent(repoRoot, taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'legacy', { review_type: 'code', output_path: contextPath });
        assert.deepEqual(findRestorableReviewContexts(options), [], 'an older context event has no authenticated digest');
        const routed = appendTaskEvent(repoRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'legacy routing',
            { review_type: 'code', reviewer_execution_mode: 'delegated_subagent' }, { actor: 'orchestrator', passThru: true });
        const routingSha256 = routed?.integrity?.event_sha256;
        assert.ok(routingSha256);
        appendTaskEvent(repoRoot, taskId, 'REVIEWER_LAUNCH_PREPARED', 'INFO', 'wrong actor',
            { task_id: taskId, review_type: 'code', review_context_sha256: sha, routing_event_sha256: routingSha256 }, { actor: 'user' });
        assert.deepEqual(findRestorableReviewContexts(options), [], 'a non-controller event cannot pin the context');
        appendTaskEvent(repoRoot, taskId, 'REVIEWER_LAUNCH_PREPARED', 'INFO', 'launch',
            { task_id: taskId, review_type: 'code', review_context_sha256: sha, routing_event_sha256: routingSha256 }, { actor: 'orchestrator' });
        assert.deepEqual(findRestorableReviewContexts(options).map(entry => entry.sha256), [sha]);
        fs.unlinkSync(path.join(repoRoot, 'runtime', 'tmp', '.review-context-cache', taskId, sha));
        assert.deepEqual(findReviewContextRecoveryCandidates(options).map(entry => ({
            sha256: entry.sha256, copyAvailable: entry.copyAvailable, launchPrepared: entry.launchPrepared
        })), [{ sha256: sha, copyAvailable: false, launchPrepared: true }], 'an older task without copies still identifies the lost review');
        preserveReviewContextCopy({ repoRoot, taskId, reviewType: 'code', contextPath }, text);
        const newerText = '{"reviewed":"newer"}\n';
        const newerSha = crypto.createHash('sha256').update(newerText).digest('hex');
        preserveReviewContextCopy({ repoRoot, taskId, reviewType: 'code', contextPath }, newerText);
        appendTaskEvent(repoRoot, taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'newer context',
            { review_type: 'code', output_path: contextPath, review_context_sha256: newerSha });
        appendTaskEvent(repoRoot, taskId, 'REVIEWER_INVOCATION_ATTESTED', 'INFO', 'late old attempt',
            { task_id: taskId, review_type: 'code', review_context_sha256: sha, routing_event_sha256: routingSha256 }, { actor: 'orchestrator' });
        appendTaskEvent(repoRoot, taskId, 'REVIEW_RECORDED', 'PASS', 'late old receipt',
            { task_id: taskId, review_type: 'code', review_context_sha256: sha, review_context_path: contextPath });
        assert.deepEqual(findRestorableReviewContexts(options).map(entry => entry.sha256), [newerSha],
            'an old launch or receipt cannot supersede a newer prepared context');
        appendTaskEvent(repoRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'untrusted later route',
            { review_type: 'code', review_context_sha256: sha }, { actor: 'user' });
        assert.deepEqual(findReviewContextRecoveryCandidates(options), [],
            'an untrusted later route cannot pin a copy or revive the earlier review context');
        appendTaskEvent(repoRoot, taskId, 'REVIEW_CYCLE_RESTARTED', 'PASS', 'restart', { task_id: taskId,
            event_type: 'REVIEW_CYCLE_RESTARTED', status: 'PASSED', invalidated_review_types: ['code'] }, { actor: 'orchestrator' });
        assert.deepEqual(findRestorableReviewContexts(options), [], 'a superseded attempt cannot be restored into the new cycle');
        appendTaskEvent(repoRoot, taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'new context',
            { review_type: 'code', output_path: contextPath, review_context_sha256: sha });
        assert.deepEqual(findRestorableReviewContexts(options).map(entry => entry.sha256), [sha]);
        fs.writeFileSync(contextPath, text);
        assert.deepEqual(findReviewContextRecoveryCandidates(options).map(entry => entry.sha256), [sha],
            'a matching fresh context stays pinned while the invalidated review is still open');
        appendTaskEvent(repoRoot, taskId, 'REVIEW_RECORDED', 'PASS', 'fresh receipt',
            { task_id: taskId, review_type: 'code', review_context_sha256: sha, review_context_path: contextPath,
                reviewer_input_proof: { review_context_sha256: sha, inputs: [] } });
        assert.deepEqual(findReviewContextRecoveryCandidates(options), [],
            'an intact freshly recorded review needs no recovery candidate');
        fs.unlinkSync(contextPath);
        assert.deepEqual(findRestorableReviewContexts(options).map(entry => entry.sha256), [sha]);
        const timeline = path.join(eventsRoot, `${taskId}.jsonl`);
        fs.appendFileSync(timeline, '{broken event\n');
        assert.deepEqual(findRestorableReviewContexts(options), [], 'a damaged event chain authenticates nothing');
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});

test('a redirected reviews directory is never a context recovery destination', (t) => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-context-link-'));
    try {
        const runtime = path.join(repoRoot, 'runtime');
        const source = path.join(repoRoot, 'source');
        fs.mkdirSync(runtime);
        fs.mkdirSync(source);
        try { fs.symlinkSync(source, path.join(runtime, 'reviews'), 'junction'); }
        catch { t.skip('directory links are unavailable on this filesystem'); return; }
        const contextPath = path.join(runtime, 'reviews', 'T-COPY-code-review-context.json');
        const outsideDestination = path.join(source, 'T-COPY-code-review-context.json');
        const text = '{"reviewed":"original"}\n';
        const sha = crypto.createHash('sha256').update(text).digest('hex');
        const cache = path.join(runtime, 'tmp', '.review-context-cache');
        fs.mkdirSync(cache, { recursive: true });
        fs.writeFileSync(path.join(cache, sha), text);
        fs.writeFileSync(outsideDestination, 'leave this file alone');
        const options = { repoRoot, taskId: 'T-COPY', reviewType: 'code', contextPath };
        const damaged = crypto.createHash('sha256').update('leave this file alone').digest('hex');
        assert.equal(canRestoreReviewContextCopy(options, sha), false);
        assert.equal(restoreReviewContextCopy(options, sha, damaged), false);
        assert.equal(fs.readFileSync(outsideDestination, 'utf8'), 'leave this file alone');
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});

test('context copies require post-run proof after a reviewer has started', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-context-handoff-'));
    try {
        const taskId = 'T-COPY';
        const reviews = path.join(repoRoot, 'runtime', 'reviews');
        const eventsRoot = path.join(repoRoot, 'runtime', 'task-events');
        fs.mkdirSync(reviews, { recursive: true });
        const contextPath = path.join(reviews, `${taskId}-code-review-context.json`);
        const text = '{"criteria":"original"}\n';
        const sha = crypto.createHash('sha256').update(text).digest('hex');
        fs.writeFileSync(contextPath, text);
        preserveReviewContextCopy({ repoRoot, taskId, reviewType: 'code', contextPath }, text);
        const options = { repoRoot, eventsRoot, taskId, states: [{ reviewType: 'code', contextPath }] };
        appendTaskEvent(repoRoot, taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'context',
            { review_type: 'code', output_path: contextPath, review_context_sha256: sha });
        const route = appendTaskEvent(repoRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'route',
            { review_type: 'code', review_context_sha256: sha }, { actor: 'orchestrator', passThru: true });
        const details = { task_id: taskId, review_type: 'code', review_context_sha256: sha,
            routing_event_sha256: route!.integrity!.event_sha256 };
        const handoff = { repoRoot, taskId, reviewType: 'code', contextPath, contextSha256: sha };
        appendTaskEvent(repoRoot, taskId, 'REVIEWER_LAUNCH_PREPARED', 'INFO', 'prepared', details, { actor: 'orchestrator' });
        assert.equal(canRestoreReviewerInputsBeforeHandoff(handoff), true);
        fs.writeFileSync(contextPath, '{"criteria":"changed"}\n');
        assert.equal(findRestorableReviewContexts(options).length, 1, 'before the handoff');
        appendTaskEvent(repoRoot, taskId, 'REVIEWER_DELEGATION_STARTED', 'INFO', 'started', details, { actor: 'orchestrator' });
        assert.equal(canRestoreReviewerInputsBeforeHandoff(handoff), false);
        assert.equal(findRestorableReviewContexts(options).length, 0, 'the changed context is lost evidence');
        appendTaskEvent(repoRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'another route',
            { review_type: 'code', review_context_sha256: sha }, { actor: 'orchestrator' });
        assert.equal(findRestorableReviewContexts(options).length, 0, 'routing again does not cancel the open handoff');
        appendTaskEvent(repoRoot, taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'another preparation',
            { review_type: 'code', output_path: contextPath, review_context_sha256: sha });
        assert.equal(findRestorableReviewContexts(options).length, 0, 'only an authenticated restart supersedes the handoff');
        assert.equal(canRestoreReviewerInputsBeforeHandoff(handoff), false);
        appendTaskEvent(repoRoot, taskId, 'REVIEW_RECORDED', 'PASS', 'result without proof',
            { ...details, review_context_path: contextPath });
        assert.equal(findRestorableReviewContexts(options).length, 0, 'a result alone is not post-run proof');
        appendTaskEvent(repoRoot, taskId, 'REVIEW_RECORDED', 'PASS', 'verified result',
            { ...details, review_context_path: contextPath, reviewer_input_proof: { review_context_sha256: sha, inputs: [] } });
        assert.equal(findRestorableReviewContexts(options).length, 1, 'gate-signed proof permits the original bytes');
        appendTaskEvent(repoRoot, taskId, 'REVIEWER_DELEGATION_STARTED', 'INFO', 'new attempt', details, { actor: 'orchestrator' });
        assert.equal(findRestorableReviewContexts(options).length, 0, 'an older result proves nothing about a new attempt');
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});
