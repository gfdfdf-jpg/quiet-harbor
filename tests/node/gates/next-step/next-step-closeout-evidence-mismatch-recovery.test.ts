import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initGitRepo } from '../git-fixtures';import {
    assessProjectMemoryImpact,
    bindFixtureEffectiveReviewSnapshot,
    buildDomainScopeFingerprints,
    getWorkspaceSnapshot,
    resolveNextStep
} from './next-step-test-support';
import {
    TASK_ID,
    ALL_REVIEW_FLAGS,
    makeTempRepo,
    reviewsRoot,
    writeJson,
    fileSha256,
    appendEvent,
    eventsRoot,
    normalizeForTimeline,
    seedStartedTask,
    seedPostPreflightRulePack,
    seedGitAutoCompilePass,
    writeReviewEvidence,
    seedReviewGatePass,
    writeProjectMemoryWorkflowConfig,
    seedProjectMemory
} from './next-step-doc-impact-fixtures';

const SOURCE_PATH = path.join('src', 'gates', 'review-remediation', 'delta-contract.ts');
const REQUIRED_REVIEWS = Object.freeze({ ...ALL_REVIEW_FLAGS, code: true, test: true });
const MISMATCH_VIOLATION = 'Doc impact evidence claims project_memory_update_not_needed=true, but project-memory-impact '
    + 'did not record NO_UPDATE_NEEDED evidence for the current completion cycle. Project memory: enabled; mode=update; '
    + 'required=true; evidence=CURRENT; status=UPDATED; update_needed=false; updated_files=0; compact=OK; compact_refreshed=false';

function preflightPathOf(repoRoot: string): string {
    return path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
}

/** Writes the preflight and its PREFLIGHT_CLASSIFIED event with the classification facts classify-change records. */
function classify(repoRoot: string, refreshedUtc: string | null = null, criteriaSha256 = 'c'.repeat(64)): void {
    const preflightPath = preflightPathOf(repoRoot);
    const snapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', true, []);
    writeJson(preflightPath, {
        task_id: TASK_ID,
        detection_source: snapshot.detection_source,
        mode: 'FULL_PATH',
        scope_category: 'code',
        metrics: {
            changed_lines_total: snapshot.changed_lines_total,
            changed_files_sha256: snapshot.changed_files_sha256,
            scope_content_sha256: snapshot.scope_content_sha256,
            scope_sha256: snapshot.scope_sha256,
            domain_scope_fingerprints: buildDomainScopeFingerprints({
                repoRoot,
                detectionSource: snapshot.detection_source,
                includeUntracked: snapshot.include_untracked,
                changedFiles: snapshot.changed_files
            })
        },
        required_reviews: REQUIRED_REVIEWS,
        changed_files: snapshot.changed_files,
        review_execution_policy: {
            mode: 'code_first_optional',
            visible_summary_line: 'Review execution policy: code_first_optional'
        },
        ...(refreshedUtc ? { budget_forecast: { timestamp_utc: refreshedUtc } } : {})
    });
    bindFixtureEffectiveReviewSnapshot(repoRoot, TASK_ID, 'code', preflightPath, '', { ensureSkillEntrypoints: false });
    appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED', 'INFO', {
        mode: 'FULL_PATH',
        output_path: normalizeForTimeline(preflightPath),
        output_sha256: fileSha256(preflightPath),
        changed_files_count: snapshot.changed_files.length,
        changed_lines_total: snapshot.changed_lines_total,
        scope_sha256: snapshot.scope_sha256,
        scope_content_sha256: snapshot.scope_content_sha256,
        task_criteria_sha256: criteriaSha256,
        code_changed: true,
        required_reviews: REQUIRED_REVIEWS,
        effective_review_snapshot: (JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>)
            .effective_review_snapshot
    });
    seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
}

function recordProjectMemoryUpdated(repoRoot: string): void {
    const result = assessProjectMemoryImpact({
        repoRoot,
        taskId: TASK_ID,
        preflightPath: preflightPathOf(repoRoot),
        confirmUpdated: true,
        skipUnchangedCandidatesRationale: 'Checked the candidate files: none documents remediation line evidence, so no durable statement is outdated.'
    });
    assert.ok(result.updateEvidenceToWrite, JSON.stringify(result.artifact.violations));
    writeJson(result.updateArtifactPath, result.updateEvidenceToWrite);
    const current = assessProjectMemoryImpact({ repoRoot, taskId: TASK_ID, preflightPath: preflightPathOf(repoRoot) });
    assert.equal(current.artifact.status, 'UPDATED', JSON.stringify(current.artifact.violations));
    writeJson(current.artifactPath, current.artifact);
    appendEvent(repoRoot, TASK_ID, 'PROJECT_MEMORY_IMPACT_ASSESSED', 'PASS', { status: 'UPDATED' });
}

function recordDocImpact(repoRoot: string, flags: { updated: boolean; notNeeded: boolean }): void {
    const preflightPath = preflightPathOf(repoRoot);
    const docImpact = {
        event_source: 'doc-impact-gate',
        task_id: TASK_ID,
        status: 'PASSED',
        outcome: 'PASS',
        preflight_path: normalizeForTimeline(preflightPath),
        preflight_hash_sha256: fileSha256(preflightPath),
        decision: 'NO_DOC_UPDATES',
        behavior_changed: true,
        changelog_updated: false,
        internal_changelog_updated: false,
        project_memory_updated: flags.updated,
        project_memory_update_not_needed: flags.notNeeded,
        docs_updated: []
    };
    writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-doc-impact.json`), docImpact);
    appendEvent(repoRoot, TASK_ID, 'DOC_IMPACT_ASSESSED', 'PASS', docImpact);
}

/** T-437 up to its completion failure: all reviews passed, project memory UPDATED, doc-impact claims not-needed. */
function seedT437CompletionFailure(violations: readonly string[] = [MISMATCH_VIOLATION]): string {
    const repoRoot = makeTempRepo();
    writeProjectMemoryWorkflowConfig(repoRoot, { enabled: true, mode: 'update' });
    seedProjectMemory(repoRoot);
    fs.mkdirSync(path.dirname(path.join(repoRoot, SOURCE_PATH)), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, SOURCE_PATH), 'export const reviewed = 1;\n', 'utf8');
    initGitRepo(repoRoot);
    fs.appendFileSync(path.join(repoRoot, SOURCE_PATH), 'export const remediated = 2;\n', 'utf8');
    seedStartedTask(repoRoot, TASK_ID);
    classify(repoRoot);
    seedGitAutoCompilePass(repoRoot, TASK_ID);
    writeReviewEvidence(repoRoot, TASK_ID, 'code');
    writeReviewEvidence(repoRoot, TASK_ID, 'test');
    seedReviewGatePass(repoRoot, TASK_ID);
    recordProjectMemoryUpdated(repoRoot);
    recordDocImpact(repoRoot, { updated: false, notNeeded: true });
    appendEvent(repoRoot, TASK_ID, 'COMPLETION_GATE_FAILED', 'FAIL', {
        status: 'FAILED',
        outcome: 'FAIL',
        violations: [...violations]
    });
    return repoRoot;
}

/** One more round on the unchanged tree: compile and review reruns, a completion failure, an identical reclassification. */
function rerunUnchangedRound(repoRoot: string, violations: readonly string[], refreshedUtc: string): void {
    seedGitAutoCompilePass(repoRoot, TASK_ID);
    seedReviewGatePass(repoRoot, TASK_ID);
    appendEvent(repoRoot, TASK_ID, 'COMPLETION_GATE_FAILED', 'FAIL', { status: 'FAILED', outcome: 'FAIL', violations: [...violations] });
    classify(repoRoot, refreshedUtc);
}

/** A persistent completion failure whose text carries per-round facts, as stage-sequence and full-suite messages do. */
function perRoundViolations(sequence: number, sha256Char: string, compiledUtc: string): string[] {
    return [
        `Stage sequence violation in 'timeline.jsonl': latest 'compile' evidence (seq ${sequence}) has no matching preflight.`,
        `Full suite validation artifact 'suite.json' is stale for the current task cycle. Expected preflight_sha256='`
            + `${sha256Char.repeat(64)}', compile_gate_timestamp='${compiledUtc}'.`
    ];
}

function commandsOf(result: ReturnType<typeof resolveNextStep>): string {
    return result.commands.map((command) => command.command).join('\n');
}

describe('gates/next-step closeout evidence mismatch recovery', () => {
    it('routes a doc-impact project-memory flag mismatch to a corrected doc-impact rerun without preflight refresh', () => {
        const repoRoot = seedT437CompletionFailure();

        const recovery = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(recovery.next_gate, 'doc-impact-gate', recovery.reason);
        assert.match(commandsOf(recovery), /--project-memory-updated true/u);
        assert.doesNotMatch(commandsOf(recovery), /--project-memory-update-not-needed|classify-change|restart-coherent-cycle/u);
        assert.match(recovery.reason, /supersedes/u);

        recordDocImpact(repoRoot, { updated: true, notNeeded: false });
        const resumed = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(resumed.next_gate, 'completion-gate', resumed.reason);
        const docImpactEvents = fs.readFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${TASK_ID}.jsonl`), 'utf8')
            .split('\n').filter((line) => line.trim())
            .map((line) => JSON.parse(line) as { event_type: string; details: Record<string, unknown> })
            .filter((event) => event.event_type === 'DOC_IMPACT_ASSESSED');
        assert.deepEqual(docImpactEvents.map((event) => event.details.project_memory_update_not_needed), [true, false],
            'the wrong doc-impact record stays in history and the corrected one follows it');
    });

    it('recovers a task whose agent already reclassified the unchanged scope after the mismatch (T-437 state)', () => {
        const repoRoot = seedT437CompletionFailure();
        classify(repoRoot, '2026-11-24T23:32:06.928Z');

        const recovery = resolveNextStep({ taskId: TASK_ID, repoRoot });

        // The refreshed preflight keeps the cycle: compile is rerun on it, nothing is restarted.
        assert.equal(recovery.next_gate, 'compile-gate', recovery.reason);
        assert.doesNotMatch(commandsOf(recovery), /restart-coherent-cycle|--operator-confirmed|classify-change/u);

        seedGitAutoCompilePass(repoRoot, TASK_ID);
        const afterCompile = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(afterCompile.next_gate, 'build-review-context', afterCompile.reason);
        assert.doesNotMatch(commandsOf(afterCompile), /restart-coherent-cycle|--operator-confirmed|classify-change/u);
    });

    it('stops with an explanation when the same completion failure returns after one identical reclassification', () => {
        const repoRoot = seedT437CompletionFailure();
        classify(repoRoot, '2026-11-24T23:32:06.928Z');
        seedGitAutoCompilePass(repoRoot, TASK_ID);
        seedReviewGatePass(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'COMPLETION_GATE_FAILED', 'FAIL', {
            status: 'FAILED', outcome: 'FAIL', violations: [MISMATCH_VIOLATION]
        });
        classify(repoRoot, '2026-11-25T00:10:00.000Z');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.match(String(result.title ?? ''), /no further rerun of the unchanged reviewed cycle/u, result.reason);
        assert.match(result.reason, /does not change that verdict/u);
        assert.match(commandsOf(result), /--review-restart-approved yes/u, 'a new review cycle needs the user\'s approval');
        assert.notEqual(result.next_gate, 'compile-gate', 'the unchanged cycle is not rerun a second time');
    });

    it('stops when a persistent completion failure only changes its per-round sequence, hash and timestamp', () => {
        const repoRoot = seedT437CompletionFailure(perRoundViolations(12, '1', '2026-11-24T22:10:00.000Z'));
        classify(repoRoot, '2026-11-24T23:32:06.928Z');
        assert.equal(resolveNextStep({ taskId: TASK_ID, repoRoot }).next_gate, 'compile-gate', 'the first rerun is allowed');

        rerunUnchangedRound(repoRoot, perRoundViolations(40, '2', '2026-11-25T00:05:00.000Z'), '2026-11-25T00:10:00.000Z');
        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.match(String(result.title ?? ''), /no further rerun of the unchanged reviewed cycle/u, result.reason);
        assert.match(result.reason, /repeated the violations of COMPLETION_GATE_FAILED/u);
        assert.match(commandsOf(result), /--review-restart-approved yes/u);
    });

    it('stops at the cap of identical reclassifications even when every completion failure differs', () => {
        const repoRoot = seedT437CompletionFailure();
        classify(repoRoot, '2026-11-24T23:32:06.928Z');
        rerunUnchangedRound(repoRoot, ['A second, different completion violation.'], '2026-11-25T00:10:00.000Z');
        assert.equal(resolveNextStep({ taskId: TASK_ID, repoRoot }).next_gate, 'compile-gate', 'two reruns are allowed');

        rerunUnchangedRound(repoRoot, ['A third, different completion violation.'], '2026-11-25T00:20:00.000Z');
        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.match(String(result.title ?? ''), /no further rerun of the unchanged reviewed cycle/u, result.reason);
        assert.match(result.reason, /identical reclassification 3 .*at most 2 reruns/u);
        assert.match(commandsOf(result), /--review-restart-approved yes/u);
    });

    it('does not rerun the unchanged cycle when the task history has an unreadable line', () => {
        const repoRoot = seedT437CompletionFailure();
        classify(repoRoot, '2026-11-24T23:32:06.928Z');
        const timelinePath = path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`);
        const lines = fs.readFileSync(timelinePath, 'utf8').split('\n').filter((line) => line.trim());
        // An unreadable line means the whole history cannot prove the rerun bound; the timeline integrity stop names it
        // before the bound is read (the bound itself fails closed too, see unchanged-reclassification.test.ts).
        lines.splice(1, 0, '{not json');
        fs.writeFileSync(timelinePath, `${lines.join('\n')}\n`, 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED', result.reason);
        assert.match(result.reason, /unparseable line/u);
        assert.notEqual(result.next_gate, 'compile-gate', 'an unprovable bound does not rerun the unchanged cycle');
        assert.doesNotMatch(commandsOf(result), /compile-gate/u);
    });

    it('keeps the operator-confirmed restart when the reclassification records different task criteria', () => {
        const repoRoot = seedT437CompletionFailure();
        classify(repoRoot, '2026-11-24T23:32:06.928Z', 'd'.repeat(64));

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'restart-coherent-cycle', result.reason);
    });

    it('keeps the refresh route when the reviewed code changed after the completion failure', () => {
        const repoRoot = seedT437CompletionFailure();
        fs.appendFileSync(path.join(repoRoot, SOURCE_PATH), 'export const changedAfterReview = 3;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'classify-change', result.reason);
        assert.match(result.reason, /older than the latest COMPLETION_GATE_FAILED/u);
    });

    it('keeps the preflight after any completion failure once the agent reran the failed step on the unchanged tree', () => {
        const repoRoot = seedT437CompletionFailure();
        recordDocImpact(repoRoot, { updated: true, notNeeded: false });
        appendEvent(repoRoot, TASK_ID, 'COMPLETION_GATE_FAILED', 'FAIL', {
            status: 'FAILED', outcome: 'FAIL', violations: ['An evidence step was recorded with a wrong argument.']
        });

        const unnamed = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(unnamed.next_gate, 'classify-change', 'Nothing names the failed step, so completion is not retried unchanged');

        recordDocImpact(repoRoot, { updated: true, notNeeded: false });
        const corrected = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(corrected.next_gate, 'completion-gate', corrected.reason);
        assert.doesNotMatch(commandsOf(corrected), /classify-change|restart-coherent-cycle/u);
    });
});
