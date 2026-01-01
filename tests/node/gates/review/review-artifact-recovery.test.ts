import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readJsonFile as readCanonical } from '../../../../src/cli/commands/gate-review-handlers/launch/review-artifact-path-support';
import { readJsonFile as readLaunch } from '../../../../src/cli/commands/gate-review-handlers/launch/review-launch-artifact-fields';
import { resolveReviewerHandoffArtifactBinding, resolveReviewerPromptArtifactBinding } from '../../../../src/gates/review/review-prompt-artifact';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { readAuthenticatedCompileReplay, rememberReviewTimelineSource, resolveReviewCompileFloorSequence } from '../../../../src/gates/review/review-artifact-recovery';
import { readDependencyTimelineEvents } from '../../../../src/cli/commands/gate-review-handlers/result/review-dependency-timeline';
import { findMatchingRoutingEvent } from '../../../../src/cli/commands/gate-review-handlers/context/review-context-runtime-validation';
import { findMatchingRoutingEvent as findRequiredRoutingEvent } from '../../../../src/gates/required-reviews/required-reviews-check-dependencies';
import { findReviewGateStaleUpstreamRecovery } from '../../../../src/gates/next-step/next-step-review-evidence';

for (const [readerName, read] of [['canonical', readCanonical], ['launch', readLaunch]] as const) {
    for (const label of ['Reviewer launch artifact', 'Reviewer launch input artifact', 'Reviewer launch lane reservation']) {
        test(`${readerName}: missing, corrupt and non-object ${label} refuse with an operator recovery`, () => {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-lost-launch-'));
            const file = path.join(root, 'evidence.json');
            try {
                for (const content of [null, '{', '[]']) {
                    if (content !== null) fs.writeFileSync(file, content);
                    assert.throws(() => read(file, label), error => {
                        assert.ok(error instanceof Error);
                        assert.match(error.message, /evidence\.json/u);
                        assert.match(error.message, /Ask the operator to reset this task with task-reset and enter it again/u);
                        assert.doesNotMatch(error.message, /ENOENT:|^SyntaxError:/u);
                        return true;
                    });
                    assert.equal(fs.existsSync(file), content !== null);
                    if (content !== null) assert.equal(fs.readFileSync(file, 'utf8'), content);
                }
            } finally { fs.rmSync(root, { recursive: true, force: true }); }
        });
    }
}

test('compile evidence replay keeps the original routing only with native proofs for identical policy, tree and commands', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-compile-replay-'));
    try {
        const taskId = 'T-REPLAY';
        const nativeDetails = {
            task_id: taskId, status: 'PASSED', exit_code: 0, preflight_path: 'runtime/reviews/T-REPLAY-preflight.json',
            preflight_hash_sha256: 'a'.repeat(64), scope_changed_files_sha256: 'b'.repeat(64),
            scope_sha256: 'c'.repeat(64), scope_content_sha256: 'd'.repeat(64),
            command_descriptors: [{ executable: 'node', argv: ['compile.cjs'] }], compile_commands: ['node compile.cjs']
        };
        for (const fault of ['none', 'criteria', 'content', 'scope', 'command', 'missing-proof', 'missing-commands', 'invalid-path', 'reset', 'failure', 'actor', 'tamper']) {
            const bundle = path.join(root, fault);
            const timeline = path.join(bundle, 'runtime', 'task-events', taskId + '.jsonl');
            appendTaskEvent(bundle, taskId, 'COMPILE_GATE_PASSED', 'PASS', 'Original compile.', nativeDetails);
            appendTaskEvent(bundle, taskId, 'REVIEWER_DELEGATION_ROUTED', 'PASS', 'Original routing.', {
                task_id: taskId, review_type: 'code', reviewer_execution_mode: 'delegated_subagent',
                reviewer_session_id: 'agent:code-reviewer', reviewer_identity: 'agent:code-reviewer', reviewer_fallback_reason: null
            });
            if (fault === 'reset') appendTaskEvent(bundle, taskId, 'TASK_RESET', 'PASS', 'Reset.', {});
            if (fault === 'failure') appendTaskEvent(bundle, taskId, 'COMPILE_GATE_FAILED', 'FAIL', 'Failure.', {});
            const changed: Record<string, unknown> = { ...nativeDetails };
            if (fault === 'criteria') changed.preflight_hash_sha256 = 'e'.repeat(64);
            if (fault === 'content') changed.scope_content_sha256 = 'e'.repeat(64);
            if (fault === 'scope') changed.scope_sha256 = 'e'.repeat(64);
            if (fault === 'command') changed.command_descriptors = [{ executable: 'node', argv: ['other.cjs'] }];
            if (fault === 'missing-proof') delete changed.scope_changed_files_sha256;
            if (fault === 'missing-commands') delete changed.compile_commands;
            if (fault === 'invalid-path') changed.preflight_path = { path: nativeDetails.preflight_path };
            appendTaskEvent(bundle, taskId, 'COMPILE_GATE_PASSED', 'PASS', 'Rebuilt compile.', changed,
                { actor: fault === 'actor' ? 'main-agent' : 'gate' });
            if (fault === 'tamper') fs.appendFileSync(timeline, '{"task_id":"T-REPLAY","event_type":"COMPILE_GATE_PASSED"}\n');
            const events = readDependencyTimelineEvents(timeline);
            assert.equal(Boolean(readAuthenticatedCompileReplay(timeline, taskId)), fault === 'none', fault);
            assert.equal(resolveReviewCompileFloorSequence(events, 2), fault === 'none' ? 0 : 2, fault);
            assert.equal(Boolean(findMatchingRoutingEvent(events, 'code', 'delegated_subagent', 'agent:code-reviewer', null)),
                fault === 'none', fault);
            // The gate's existing normalized view omits envelope fields. It is still only a hint: the native
            // source must authenticate gate actor, task id, scope and commands, including the negative actor case.
            const gateEvents = events.map(event => ({ event_type: event.event_type, outcome: event.outcome,
                sequence: event.sequence, details: event.details, integrity: event.integrity }));
            rememberReviewTimelineSource(gateEvents, timeline);
            assert.equal(Boolean(findRequiredRoutingEvent(gateEvents, 'code', 'delegated_subagent', 'agent:code-reviewer', null)),
                fault === 'none', 'required-reviews-check: ' + fault);
        }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('lost gate evidence selects the exact lane and only its replacement clears recovery', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-lane-loss-'));
    const taskId = 'T-LANE-LOSS';
    const cases = [
        { name: 'canonical', lane: 'code-security', order: ['code', 'code-security'],
            file: `${taskId}-code-security-findings-disposition.json`, prompt: false, ancestor: 'ordinary' },
        { name: 'snapshot', lane: 'code-security', order: ['code-security', 'code'],
            file: `${taskId}-code-security-findings-disposition-${'a'.repeat(64)}.json`, prompt: false, ancestor: 'ordinary' },
        { name: 'prompt', lane: 'code-security', order: ['code', 'code-security'],
            file: `${taskId}-code-security-review-context.json`, prompt: true, ancestor: "O'Neil" },
        { name: 'ancestor-prefix', lane: 'code', order: ['code-security', 'code'],
            file: `${taskId}-code-findings-disposition.json`, prompt: false, ancestor: `${taskId}-code-security-ancestor` }
    ];
    try {
        for (const entry of cases) {
            const repoRoot = path.join(root, entry.name);
            const bundle = path.join(repoRoot, 'garda-agent-orchestrator');
            const eventsRoot = path.join(bundle, 'runtime', 'task-events');
            const artifactPath = path.join(repoRoot, entry.ancestor, entry.file).replace(/\\/gu, '/');
            const violation = entry.prompt
                ? `required-reviews-check requires a readable reviewer prompt artifact for '${artifactPath}'. Rebuild its inputs.`
                : `Review findings disposition ${entry.name === 'snapshot' ? 'snapshot' : 'artifact'} '${artifactPath}' is missing.`;
            appendTaskEvent(bundle, taskId, 'COMPILE_GATE_PASSED', 'PASS', 'Original compile.', { task_id: taskId });
            appendTaskEvent(bundle, taskId, 'REVIEW_GATE_FAILED', 'FAIL', 'Lost review evidence.', {
                task_id: taskId, violations: [violation]
            });
            const options = { repoRoot, eventsRoot, taskId, requiredReviewTypes: [...entry.order],
                requiredReviews: { code: true, 'code-security': true }, policyMode: 'parallel_all' as const, reviewStates: [] };
            const before = findReviewGateStaleUpstreamRecovery(options);
            assert.ok(before?.kind === 'lost-review-evidence', entry.name);
            assert.equal(before.reviewType, entry.lane, entry.name);
            appendTaskEvent(bundle, taskId, 'REVIEW_RECORDED', 'PASS', 'Unrelated replacement.', {
                task_id: taskId, review_type: entry.lane === 'code' ? 'code-security' : 'code'
            });
            const unrelated = findReviewGateStaleUpstreamRecovery(options);
            assert.ok(unrelated?.kind === 'lost-review-evidence', entry.name);
            assert.equal(unrelated.reviewType, entry.lane, entry.name);
            appendTaskEvent(bundle, taskId, 'REVIEW_RECORDED', 'PASS', 'Affected review replaced.', {
                task_id: taskId, review_type: entry.lane
            });
            assert.equal(findReviewGateStaleUpstreamRecovery(options), null, entry.name);
            assert.deepEqual(options.requiredReviewTypes, entry.order, 'selection must not reorder the review plan');
        }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const [gateName, recovery] of [
    ['prepare-reviewer-launch', /Run build-review-context/u],
    ['record-reviewer-delegation-started', /Run build-review-context/u],
    ['complete-reviewer-launch', /Run next-step:.*record-reviewer-launch-failed/u],
    ['record-review-result', /Run next-step.*review-evidence-only/u],
    ['record-review-receipt', /Run next-step.*review-evidence-only/u],
    ['record-review-invocation', /Run next-step.*review-evidence-only/u],
    ['required-reviews-check', /Run next-step.*review-evidence-only/u]
] as const) {
    test(`${gateName}: lost prompt and handoff artifacts retain refusal and name the applicable recovery`, () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-lost-prompt-'));
        try {
            const input = { repoRoot, contextPath: path.join(repoRoot, 'context.json'), gateName,
                reviewContext: {
                    rule_context: { artifact_path: 'prompt.md', artifact_sha256: 'a'.repeat(64) },
                    reviewer_handoff: { manifest: { artifact_path: 'manifest.json', artifact_sha256: 'b'.repeat(64) } }
                } };
            assert.throws(() => resolveReviewerPromptArtifactBinding(input), recovery);
            assert.throws(() => resolveReviewerHandoffArtifactBinding({ ...input, handoffKey: 'manifest', artifactLabel: 'reviewer evidence manifest' }), recovery);
            assert.deepEqual(fs.readdirSync(repoRoot), [], 'refusal must not reconstruct any evidence');
        } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
    });
}
