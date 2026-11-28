import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { persistReviewerLaunchCompletionTransition } from '../../../../src/cli/commands/gate-review-handlers/launch/review-launch-complete-handler';
import { readReviewerLaunchTransitionArtifact } from '../../../../src/cli/commands/gate-review-handlers/launch/review-launch-artifact-fields';
import { persistedCompletionReportAvailable } from '../../../../src/gates/review/review-output-copy';

function withTempRoot(run: (root: string) => void | Promise<void>): Promise<void> | void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-launch-recovery-'));
    const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
    try {
        const result = run(root);
        return result instanceof Promise ? result.finally(cleanup) : cleanup();
    } catch (error) {
        cleanup();
        throw error;
    }
}

test('publication recovery refuses an artifact whose identity changes before the event append', () => withTempRoot(async (root) => {
    const artifactPath = path.join(root, 'launch.json');
    const bytes = JSON.stringify({ attestation_state: 'launched' });
    fs.writeFileSync(artifactPath, bytes, 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    const unchanged = readReviewerLaunchTransitionArtifact(artifactPath, sha256);
    assert.doesNotThrow(() => unchanged.recoveryDigest?.assertCurrent());

    const read = readReviewerLaunchTransitionArtifact(artifactPath, sha256);
    assert.ok(read.recoveryDigest);
    fs.appendFileSync(artifactPath, '\n', 'utf8');
    assert.throws(() => read.recoveryDigest?.assertCurrent(), /refused changed artifact bytes\. Run next-step again/u);

    // The persist step runs the same recheck before it hashes or appends anything.
    fs.writeFileSync(artifactPath, bytes, 'utf8');
    const stale = readReviewerLaunchTransitionArtifact(artifactPath, createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex'));
    fs.appendFileSync(artifactPath, ' ', 'utf8');
    let appended = 0;
    await assert.rejects(persistReviewerLaunchCompletionTransition({
        artifactPath, originalArtifactText: stale.originalArtifactText, recoveryDigest: stale.recoveryDigest,
        completedArtifact: stale.artifact, recoveringPersistedCompletion: true, reviewType: 'code',
        emitCompletedEvent: async () => { appended += 1; return true; },
        hasMatchingCompletedEvent: () => false
    }), /refused changed artifact bytes/u);
    assert.equal(appended, 0);
}));

test('the navigator and the gate judge a bound report digest with one predicate', () => withTempRoot((root) => {
    const outputPath = path.join('runtime', 'reviews', 'T-1-code-output.md');
    fs.mkdirSync(path.join(root, 'runtime', 'reviews'), { recursive: true });
    const bytes = '{"verdict":"PASS"}';
    fs.writeFileSync(path.join(root, outputPath), bytes, 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const delegationStartedMs = fs.statSync(path.join(root, outputPath)).mtimeMs - 1000;
    const base = { repoRoot: root, taskId: 'T-1', reviewType: 'code', outputPath, delegationStartedMs };
    const mtime = { review_output_source_mtime_ms: delegationStartedMs + 1000 };

    for (const artifact of [
        { ...mtime, review_output_sha256: sha256 },
        { ...mtime, review_output_sha256: sha256.toUpperCase() },
        { ...mtime, review_output_sha256: ` ${sha256.toUpperCase()} ` }
    ]) {
        assert.equal(persistedCompletionReportAvailable({ ...base, artifact }), true, JSON.stringify(artifact));
    }
    // Only the key Garda writes binds the report: an alias would let recovery drop the binding the result gate reads.
    assert.equal(persistedCompletionReportAvailable({ ...base, artifact: { ...mtime, reviewOutputSha256: sha256 } }), false);
    assert.equal(persistedCompletionReportAvailable({ ...base, artifact: { ...mtime, review_output_sha256: 'f'.repeat(64) } }), false);
    assert.equal(persistedCompletionReportAvailable({ ...base, artifact: { review_output_sha256: sha256 } }), false);
    assert.equal(persistedCompletionReportAvailable({ ...base, artifact: { ...mtime, review_output_sha256: sha256 },
        delegationStartedMs: delegationStartedMs + 5000 }), false);
}));
