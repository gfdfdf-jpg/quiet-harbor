import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { formatTaskCompositeText, resolveTaskCompositeExitCode } from '../../../../src/cli/commands/task-composite/task-composite-command';
import { runTaskComposite } from '../../../../src/cli/commands/task-composite/task-composite-runner';
import type { TaskCompositeOperationOutcome } from '../../../../src/cli/commands/task-composite/task-composite-actions';
import type { NextStepResult } from '../../../../src/gates/next-step/next-step';
import {
    resolvePostReviewCloseoutRouteFromState,
    type PostReviewCloseoutRouteState
} from '../../../../src/gates/next-step/next-step-closeout-routing';
import {
    attachNextStepCommandExecution,
    readNextStepCommandExecution,
    type NextStepCommandOperation
} from '../../../../src/gates/next-step/next-step-command-execution';
import { selectTaskCompositeAction } from '../../../../src/gates/next-step/next-step-composite-action';
import { resolveCompletedCloseoutDecisionRoute } from '../../../../src/gates/next-step/next-step-decision-route-groups';
import { buildRequiredReviewsCheckInvocation } from '../../../../src/gates/next-step/next-step-lifecycle-command-builders';
import { buildFollowUpMaterializationCommand } from '../../../../src/gates/next-step/next-step-follow-up-materialization-command';
import * as os from 'node:os';
import { resolveNextStep } from '../../../../src/gates/next-step';
import { formatNextStepCompactText, formatNextStepText } from '../../../../src/gates/next-step/next-step-command-formatters';
import { projectNextStepJson, selectNextStepRecommendedAction } from '../../../../src/gates/next-step/next-step-recommended-action';
import { DEFAULT_BUNDLE_NAME } from '../../../../src/core/constants';
import type { TaskCompositeRunResult } from '../../../../src/cli/commands/task-composite/task-composite-runner';
import {
    PROVIDER_ARGS,
    TASK_ID as FIXTURE_TASK_ID,
    cli,
    createCompositeFixture,
    runPrintedCommand,
    timelineEvents
} from './task-composite-test-fixture';

const TASK_ID = 'T-409-4';
const PREFLIGHT = `garda-agent-orchestrator/runtime/reviews/${TASK_ID}-preflight.json`;
const GATE_ARGUMENTS = { task_id: TASK_ID, preflight_path: PREFLIGHT, task_mode_path: null };
const REVIEWS_ARGUMENTS = { ...GATE_ARGUMENTS, review_authorship_attestation_json: null, review_authorship_attestation_template: null };
const ATTESTATION_TEMPLATE = '{"code":false}';
const AGENT_REVIEWS_ARGUMENTS = { ...REVIEWS_ARGUMENTS, review_authorship_attestation_template: ATTESTATION_TEMPLATE };
const CLOSEOUT_TEST_ARGUMENTS = { task_id: TASK_ID, preflight_path: PREFLIGHT, closeout: true as const };
const NAVIGATOR = `node bin/garda.js next-step "${TASK_ID}" --repo-root "."`;
const FINAL_REPORT: NonNullable<NextStepResult['final_report']> = {
    closeout_json_path: 'closeout.json',
    closeout_markdown_path: 'closeout.md',
    final_user_report_path: 'final-user-report.md',
    final_user_report_body: 'GARDA FINAL REPORT\nTask T-409-4: DONE',
    final_user_report_sha256: 'b'.repeat(64),
    required_order: ['Summary', 'Final user report', 'Commit command', 'Commit question'],
    commit_command_suggestion: 'git commit -m "T-409-4: finish"',
    commit_question: 'Do you want me to commit now? (yes/no)'
};

function closeoutState(overrides: Partial<PostReviewCloseoutRouteState> = {}): PostReviewCloseoutRouteState {
    return {
        requiredReviewsGatePassed: true, zeroDiffNoReviewCloseout: false,
        requiredReviewsCommand: 'garda gate required-reviews-check',
        requiredReviewsOperation: { boundary: 'mechanical', arguments: REVIEWS_ARGUMENTS },
        docImpactGatePassed: true, docImpactCompatibilityHint: 'No compatibility issue.',
        docImpactCommand: 'garda gate doc-impact-gate --decision "NO_DOC_UPDATES"',
        fullSuiteEnabled: false, fullSuiteGatePassed: false, fullSuiteNotRequiredForDocsOnly: false,
        fullSuitePlacement: 'before_completion', fullSuiteConfigPath: 'workflow-config.json', fullSuiteCommandText: 'npm test',
        fullSuiteTimeoutForecastLine: null, fullSuiteCommand: 'garda gate task-test-validation',
        fullSuiteArguments: { task_id: TASK_ID, preflight_path: PREFLIGHT },
        projectMemoryRequired: false, projectMemoryEvidenceCurrent: true, projectMemoryVisibleSummaryLine: 'memory',
        projectMemoryAffectedMemoryFiles: [], projectMemoryViolations: [], projectMemoryCommand: 'garda gate project-memory-impact',
        completionGatePassed: false, completionCommand: 'garda gate completion-gate', completionArguments: GATE_ARGUMENTS,
        ...overrides
    };
}

function operationOf(state: PostReviewCloseoutRouteState): { gate: string | null; boundary: string | null; operation: unknown } {
    const route = resolvePostReviewCloseoutRouteFromState(state);
    assert.equal(route.commands.length, 1, JSON.stringify(route));
    const execution = readNextStepCommandExecution(route.commands[0]);
    return { gate: route.nextGate, boundary: execution?.boundary ?? null, operation: execution?.operation ?? null };
}

function navigatorResult(
    nextGate: string | null,
    status: NextStepResult['status'],
    commands: { boundary: 'mechanical' | 'agent'; operation: NextStepCommandOperation | null }[],
    finalReport: NextStepResult['final_report'] = null
): NextStepResult {
    return {
        task_id: TASK_ID, status, next_gate: nextGate, title: `${nextGate ?? 'done'} title`, reason: 'reason',
        navigator_command: NAVIGATOR, warnings: [], final_report: finalReport,
        commands: commands.map(({ boundary, operation }, index) => attachNextStepCommandExecution(
            { label: `step ${index}`, command: `display only ${nextGate} ${index}` }, boundary, operation))
    } as unknown as NextStepResult;
}

const mechanical = (operation: NextStepCommandOperation) => ({ boundary: 'mechanical' as const, operation });
const requiredReviews = () => navigatorResult('required-reviews-check', 'BLOCKED',
    [mechanical({ operation_id: 'required-reviews-check', arguments: REVIEWS_ARGUMENTS })]);
const attestationNeeded = () => navigatorResult('required-reviews-check', 'BLOCKED',
    [{ boundary: 'agent', operation: { operation_id: 'required-reviews-check', arguments: AGENT_REVIEWS_ARGUMENTS } }]);
const taskTests = () => navigatorResult('full-suite-validation', 'BLOCKED',
    [mechanical({ operation_id: 'task-test-validation', arguments: CLOSEOUT_TEST_ARGUMENTS })]);
const docDecision = () => navigatorResult('doc-impact-gate', 'BLOCKED', [{ boundary: 'agent', operation: null }]);
const completion = () => navigatorResult('completion-gate', 'BLOCKED',
    [mechanical({ operation_id: 'completion-gate', arguments: GATE_ARGUMENTS })]);
const audit = () => navigatorResult('task-audit-summary', 'READY',
    [mechanical({ operation_id: 'task-audit-summary', arguments: { task_id: TASK_ID } })]);
const done = () => navigatorResult(null, 'DONE', [], FINAL_REPORT);

function scripted(routes: NextStepResult[]) {
    const executed: string[] = [];
    return {
        executed,
        options: {
            taskId: TASK_ID, repoRoot: '.', mode: 'finish' as const, entryInputs: null,
            resolve: () => {
                const next = routes.shift();
                assert.ok(next, 'the runner resolved more often than the navigator script allows');
                return next;
            },
            execute: async (operation: NextStepCommandOperation): Promise<TaskCompositeOperationOutcome> => {
                executed.push(operation.operation_id);
                return { passed: true, outputLines: [`${operation.operation_id} ok`] };
            }
        }
    };
}

describe('typed closeout descriptors', () => {
    it('required reviews carry the boundary Garda\'s evidence decides', () => {
        assert.deepEqual(operationOf(closeoutState({ requiredReviewsGatePassed: false })), {
            gate: 'required-reviews-check', boundary: 'mechanical',
            operation: { operation_id: 'required-reviews-check', arguments: REVIEWS_ARGUMENTS }
        });
        assert.deepEqual(operationOf(closeoutState({ requiredReviewsGatePassed: false,
            requiredReviewsOperation: { boundary: 'agent', arguments: AGENT_REVIEWS_ARGUMENTS } })), {
            gate: 'required-reviews-check', boundary: 'agent',
            operation: { operation_id: 'required-reviews-check', arguments: AGENT_REVIEWS_ARGUMENTS }
        }, 'an attestation Garda cannot prove is the agent\'s statement');
        assert.deepEqual(operationOf(closeoutState({ requiredReviewsGatePassed: false, requiredReviewsOperation: undefined })),
            { gate: 'required-reviews-check', boundary: null, operation: null }, 'no typed state: no descriptor');
    });

    it('the builder attests only what Garda\'s delegated-review evidence proves', () => {
        const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-finish-attestation-'));
        try {
            const preflightPath = path.join(fixture, 'preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({ required_reviews: { code: true, test: true } }), 'utf8');
            const none = buildRequiredReviewsCheckInvocation(fixture, 'garda', TASK_ID, 'missing-preflight.json', null);
            assert.doesNotMatch(none.command, /--review-authorship-attestation-json/u);
            assert.deepEqual([none.boundary, none.arguments], ['mechanical',
                { ...REVIEWS_ARGUMENTS, preflight_path: 'missing-preflight.json' }]);
            const proven = buildRequiredReviewsCheckInvocation(fixture, 'garda', TASK_ID, 'preflight.json', null,
                { code: true, test: true });
            assert.equal(proven.boundary, 'mechanical');
            assert.equal(proven.arguments.review_authorship_attestation_json, '{"code":true,"test":true}');
            assert.ok(proven.command.includes('--review-authorship-attestation-json'), 'the printed command is unchanged');
            const partial = buildRequiredReviewsCheckInvocation(fixture, 'garda', TASK_ID, 'preflight.json', null,
                { code: true, test: false });
            assert.deepEqual([partial.boundary, partial.arguments.review_authorship_attestation_json,
                partial.arguments.review_authorship_attestation_template], ['agent', null, '{"code":true,"test":false}']);
        } finally {
            fs.rmSync(fixture, { recursive: true, force: true });
        }
    });

    it('documentation and project-memory decisions are agent boundaries; completion and the first task test run are mechanical', () => {
        assert.deepEqual(operationOf(closeoutState({ docImpactGatePassed: false })),
            { gate: 'doc-impact-gate', boundary: 'agent', operation: null });
        assert.deepEqual(operationOf(closeoutState({ projectMemoryRequired: true, projectMemoryEvidenceCurrent: false })),
            { gate: 'project-memory-impact', boundary: 'agent', operation: null });
        assert.deepEqual(operationOf(closeoutState()), {
            gate: 'completion-gate', boundary: 'mechanical', operation: { operation_id: 'completion-gate', arguments: GATE_ARGUMENTS }
        });
        assert.deepEqual(operationOf(closeoutState({ fullSuiteEnabled: true })), {
            gate: 'full-suite-validation', boundary: 'mechanical',
            operation: { operation_id: 'task-test-validation', arguments: CLOSEOUT_TEST_ARGUMENTS }
        });
        assert.deepEqual(operationOf(closeoutState({ fullSuiteEnabled: true, fullSuiteArguments: null })),
            { gate: 'full-suite-validation', boundary: null, operation: null }, 'a retry or recovery run stays with the agent');
        assert.deepEqual(operationOf(closeoutState({ fullSuiteEnabled: true, fullSuiteNotRequiredForDocsOnly: true })), {
            gate: 'full-suite-validation', boundary: 'mechanical',
            operation: { operation_id: 'task-test-validation', arguments: CLOSEOUT_TEST_ARGUMENTS }
        }, 'Garda classified the scope as docs-only: the not-required record is decided by its own state');
    });

    it('only the READY final-closeout materialization carries a typed audit operation', () => {
        const base = {
            completionGatePassed: true, latestCompletionCurrent: true, postDoneDriftBlocked: false, postDoneDriftReason: '',
            finalReportContractReady: true, finalReportContractBlocker: '', finalReport: null,
            taskAuditCommand: 'garda gate task-audit-summary', missingArtifacts: []
        };
        const ready = resolveCompletedCloseoutDecisionRoute({ ...base, taskAuditTaskId: TASK_ID });
        assert.equal(ready?.status, 'READY');
        assert.deepEqual(readNextStepCommandExecution(ready!.commands![0])?.operation,
            { operation_id: 'task-audit-summary', arguments: { task_id: TASK_ID } });
        const untyped = resolveCompletedCloseoutDecisionRoute(base);
        assert.equal(readNextStepCommandExecution(untyped!.commands![0]), null);
        const finished = resolveCompletedCloseoutDecisionRoute({ ...base, taskAuditTaskId: TASK_ID, finalReport: FINAL_REPORT });
        assert.deepEqual([finished?.status, finished?.commands], ['DONE', []]);
    });
});

describe('closeout action selection', () => {
    it('finish runs closeout operations; advance and start stop before them', () => {
        for (const route of [requiredReviews(), completion(), taskTests()]) {
            assert.equal(selectTaskCompositeAction(route, 'finish', null).kind, 'execute');
            for (const mode of ['advance', 'start'] as const) {
                const action = selectTaskCompositeAction(route, mode, null);
                assert.equal(action.kind, 'stop');
                assert.match((action as { reason: string }).reason, /closeout step: run task <id> finish/u);
            }
        }
        assert.equal(selectTaskCompositeAction(audit(), 'finish', null).kind, 'execute', 'READY materialization runs in finish');
        assert.deepEqual(selectTaskCompositeAction(audit(), 'advance', null),
            { kind: 'stop', stop: 'unclassified', reason: 'Navigator status READY has no executable step.' });
    });

    it('finish stops before every earlier lifecycle step instead of becoming a second advance', () => {
        const compile = navigatorResult('compile-gate', 'BLOCKED', [mechanical({ operation_id: 'compile-gate', arguments: GATE_ARGUMENTS })]);
        const action = selectTaskCompositeAction(compile, 'finish', null);
        assert.deepEqual(action, { kind: 'stop', stop: 'agent', reason: "'compile-gate' is not a closeout step: run task <id> advance, then finish." });
        const classify = navigatorResult('classify-change', 'BLOCKED', [mechanical({ operation_id: 'classify-change', arguments: {
            task_id: TASK_ID, task_intent: 'intent', changed_files: [], detection_source: null, use_staged: false,
            task_mode_path: null, output_path: PREFLIGHT
        } })]);
        assert.equal(selectTaskCompositeAction(classify, 'finish', null).kind, 'stop', 'a docs edit that reopens classification stops finish');
    });

    it('every closeout judgment is a visible agent stop with its own instruction', () => {
        const judgments: Record<string, RegExp> = {
            'doc-impact-gate': /Documentation impact is your decision/u,
            'project-memory-impact': /Project-memory impact is your decision/u
        };
        for (const [gate, reason] of Object.entries(judgments)) {
            const action = selectTaskCompositeAction(navigatorResult(gate, 'BLOCKED', [{ boundary: 'agent', operation: null }]), 'finish', null);
            assert.equal(action.kind, 'stop', gate);
            assert.equal((action as { stop: string }).stop, 'agent', gate);
            assert.match((action as { reason: string }).reason, reason, gate);
        }
    });
});

describe('closeout attestation and follow-up steps', () => {
    it('an attestation only the agent can state is one finish call with the exact gate flag', () => {
        const stopped = selectTaskCompositeAction(attestationNeeded(), 'finish', null);
        assert.equal(stopped.kind, 'stop');
        assert.ok((stopped as { reason: string }).reason.includes(
            `task <id> finish --review-authorship-attestation-json '${ATTESTATION_TEMPLATE}'`), JSON.stringify(stopped));
        assert.equal(selectTaskCompositeAction(attestationNeeded(), 'finish', null, undefined, null,
            { reviewAuthorshipAttestationJson: '{"code":true}' }).kind, 'execute');
        assert.equal(selectTaskCompositeAction(attestationNeeded(), 'advance', null, undefined, null,
            { reviewAuthorshipAttestationJson: '{"code":true}' }).kind, 'stop', 'only finish forwards an attestation');
        const recommended = selectNextStepRecommendedAction(attestationNeeded());
        assert.deepEqual(recommended, { mode: 'finish', kind: 'attestation',
            command: `node bin/garda.js task "${TASK_ID}" finish --review-authorship-attestation-json '${ATTESTATION_TEMPLATE}' --repo-root "."` });
    });

    it('Garda-instructed follow-up rows are mechanical and rendered from their typed arguments', () => {
        const args = { task_id: TASK_ID, review_type: 'code', review_types: [], disposition_artifact_path: 'd.json',
            receipt_path: 'r.json', artifact_path: 'a.json', reviews_root: null };
        const command = buildFollowUpMaterializationCommand('Materialize', 'garda', args);
        assert.equal(command.command, `garda gate materialize-review-follow-up-tasks --task-id "${TASK_ID}" --review-type "code" `
            + '--disposition-artifact-path "d.json" --receipt-path "r.json" --artifact-path "a.json" --repo-root "."');
        assert.deepEqual(readNextStepCommandExecution(command), { boundary: 'mechanical',
            operation: { operation_id: 'materialize-review-follow-up-tasks', arguments: args }, rendered_command: command.command });
        const route = navigatorResult('materialize-review-follow-up-tasks', 'BLOCKED',
            [mechanical({ operation_id: 'materialize-review-follow-up-tasks', arguments: args })]);
        assert.equal(selectTaskCompositeAction(route, 'finish', null).kind, 'execute');
        assert.equal(selectTaskCompositeAction(route, 'advance', null).kind, 'execute', 'created without asking in every mode');
    });

    it('next-step states finish as the single action for the closeout and advance before it', () => {
        assert.deepEqual(selectNextStepRecommendedAction(completion()),
            { mode: 'finish', kind: 'closeout', command: `node bin/garda.js task "${TASK_ID}" finish --repo-root "."` });
        assert.equal(selectNextStepRecommendedAction(taskTests())?.mode, 'finish');
        const compile = navigatorResult('compile-gate', 'BLOCKED', [mechanical({ operation_id: 'compile-gate', arguments: GATE_ARGUMENTS })]);
        assert.equal(selectNextStepRecommendedAction(compile)?.mode, 'advance');
        assert.equal(selectNextStepRecommendedAction(docDecision()), null, 'a decision is the agent\'s own gate command');
    });
});

describe('task <id> finish', () => {
    it('follows the navigator order, pauses at the documentation decision and resumes to the canonical final report', async () => {
        const first = scripted([requiredReviews(), taskTests(), docDecision()]);
        const paused = await runTaskComposite(first.options);
        assert.deepEqual(first.executed, ['required-reviews-check', 'task-test-validation']);
        assert.deepEqual([paused.outcome, paused.stop?.kind, paused.next?.next_gate, paused.final_report],
            ['STOPPED', 'agent', 'doc-impact-gate', null]);
        assert.match(paused.stop?.reason || '', /Documentation impact is your decision/u);

        const second = scripted([completion(), audit(), done()]);
        const finished = await runTaskComposite(second.options);
        assert.deepEqual(second.executed, ['completion-gate', 'task-audit-summary']);
        assert.deepEqual([finished.outcome, finished.stop?.kind], ['STOPPED', 'terminal']);
        assert.deepEqual(finished.final_report, FINAL_REPORT, 'the report is returned unchanged');
        assert.deepEqual(finished.counters, {
            agent_invocations: 1, navigator_resolutions: 3, subgates_attempted: 2, subgates_succeeded: 2, effects_executed: 0
        });
        assert.equal(resolveTaskCompositeExitCode(finished), 0);

        const text = formatTaskCompositeText(finished);
        assert.ok(text.includes(`CopyPasteFinalUserReport:\n${FINAL_REPORT.final_user_report_body}`), text);
        assert.match(text, /FinalReportOrder:\n {2}1\. Summary/u);
        assert.ok(text.includes(`CommitCommandSuggestion: ${FINAL_REPORT.commit_command_suggestion}`));
        assert.ok(text.includes(`CommitQuestion: ${FINAL_REPORT.commit_question}`));
        assert.match(text, /task finish never commits or publishes/u);
    });

    it('repeating finish on a DONE task executes nothing and returns the same report', async () => {
        const repeat = scripted([done()]);
        const result = await runTaskComposite(repeat.options);
        assert.deepEqual(repeat.executed, []);
        assert.deepEqual([result.stop?.kind, result.completed, result.final_report], ['terminal', [], FINAL_REPORT]);
    });

    it('a failed closeout step never reports DONE or a final report', async () => {
        const routes = [completion(), done()];
        const result = await runTaskComposite({
            taskId: TASK_ID, repoRoot: '.', mode: 'finish', entryInputs: null,
            resolve: () => routes.shift()!,
            execute: async () => ({ passed: false, outputLines: ['COMPLETION_GATE_FAILED'] })
        });
        assert.deepEqual([result.outcome, result.failed?.gate, result.final_report, result.stop], ['FAILED', 'completion-gate', null, null]);
        assert.equal(routes.length, 0, 'one read-only preview after the failure');
        assert.equal(result.next, null);
        assert.equal(result.counters.navigator_resolutions, 2);
        assert.equal(result.counters.subgates_attempted, 1);
        assert.notEqual(resolveTaskCompositeExitCode(result), 0);
        assert.doesNotMatch(formatTaskCompositeText(result), /CopyPasteFinalUserReport|CommitCommandSuggestion|Outcome: STOPPED/u);
    });

    it('a stop before DONE carries no report, and advance never returns one', async () => {
        const stopped = await runTaskComposite(scripted([docDecision()]).options);
        assert.equal(stopped.final_report, null);
        const advance = await runTaskComposite({ ...scripted([done()]).options, mode: 'advance' });
        assert.equal(advance.stop?.kind, 'terminal');
        assert.equal('final_report' in advance, false);
    });
});

async function composite(repoRoot: string, mode: 'start' | 'advance' | 'finish', args: string[] = []): Promise<TaskCompositeRunResult> {
    const result = await cli(repoRoot, ['task', FIXTURE_TASK_ID, mode, '--as-json', ...args]);
    return JSON.parse(result.text) as TaskCompositeRunResult;
}

function fillQualityAnswers(repoRoot: string): void {
    const answersPath = path.join(repoRoot, DEFAULT_BUNDLE_NAME, 'runtime', 'tmp', `${FIXTURE_TASK_ID}-quality-checklist-answers.json`);
    const template = JSON.parse(fs.readFileSync(answersPath, 'utf8')) as { answers: { status: string; answer: string }[] };
    for (const answer of template.answers) {
        answer.status = 'PASS';
        answer.answer = 'The fixture edit adds one changelog line without code, structure or contracts.';
    }
    fs.writeFileSync(answersPath, `${JSON.stringify(template, null, 2)}\n`, 'utf8');
}

/** A docs-only task (no required reviews) taken through startup and validation to its first closeout step. */
async function reachCloseout(repoRoot: string): Promise<void> {
    assert.equal((await composite(repoRoot, 'start', PROVIDER_ARGS)).stop?.kind, 'agent');
    await runPrintedCommand(repoRoot, 'load-rule-pack');
    fs.appendFileSync(path.join(repoRoot, 'CHANGELOG.md'), '\n- Documented the composite fixture.\n', 'utf8');
    await composite(repoRoot, 'advance');
    await runPrintedCommand(repoRoot, 'load-rule-pack');
    await composite(repoRoot, 'advance');
    fillQualityAnswers(repoRoot);
    const validated = await composite(repoRoot, 'advance');
    assert.deepEqual(validated.completed.map(({ gate }) => gate), ['quality-checklist', 'compile-gate']);
    assert.deepEqual([validated.stop?.kind, validated.next?.next_gate], ['agent', 'required-reviews-check']);
    assert.match(validated.stop?.reason || '', /closeout step: run task <id> finish/u);
    // The navigator states the one closeout action; the individual gate command stays in --verbose and JSON details.
    const closeout = resolveNextStep({ taskId: FIXTURE_TASK_ID, repoRoot });
    const compact = formatNextStepCompactText(closeout);
    assert.match(compact, new RegExp(`Run closeout: .* task "${FIXTURE_TASK_ID}" finish `, 'u'), compact);
    assert.doesNotMatch(compact, /gate required-reviews-check/u);
    assert.equal(projectNextStepJson(closeout).recommended_action?.mode, 'finish');
    assert.match(formatNextStepText(closeout), /Single-step alternative:\n {2}Run required reviews check: .*gate required-reviews-check/u);
}

describe('task <id> finish against the real navigator', { concurrency: false }, () => {
    it('reaches DONE with the same events and report as the individual closeout commands, pausing at each judgment', async () => {
        const fixture = await createCompositeFixture();
        try {
            const individual = fixture.clone();
            await reachCloseout(individual);
            for (const gate of ['required-reviews-check', 'doc-impact-gate', 'project-memory-impact', 'completion-gate']) {
                await runPrintedCommand(individual, gate);
            }
            const individualDone = resolveNextStep({ taskId: FIXTURE_TASK_ID, repoRoot: individual });
            assert.equal(individualDone.status, 'DONE', individualDone.reason);

            const repoRoot = fixture.clone();
            await reachCloseout(repoRoot);
            const docs = await composite(repoRoot, 'finish');
            assert.deepEqual(docs.completed.map(({ gate }) => gate), ['required-reviews-check']);
            assert.deepEqual([docs.stop?.kind, docs.next?.next_gate, docs.final_report], ['agent', 'doc-impact-gate', null]);
            assert.equal((await composite(repoRoot, 'finish')).completed.length, 0, 'the docs decision is never defaulted');
            await runPrintedCommand(repoRoot, 'doc-impact-gate');
            const memory = await composite(repoRoot, 'finish');
            assert.deepEqual([memory.completed, memory.stop?.kind, memory.next?.next_gate], [[], 'agent', 'project-memory-impact']);
            await runPrintedCommand(repoRoot, 'project-memory-impact');
            const finished = await composite(repoRoot, 'finish');
            assert.deepEqual(finished.completed.map(({ gate }) => gate), ['completion-gate']);
            assert.equal(finished.stop?.kind, 'terminal');

            const done = resolveNextStep({ taskId: FIXTURE_TASK_ID, repoRoot });
            assert.equal(done.status, 'DONE');
            assert.deepEqual(finished.final_report, done.final_report, 'the canonical report, unchanged');
            assert.equal(finished.final_report?.final_user_report_body, individualDone.final_report?.final_user_report_body);
            assert.deepEqual(timelineEvents(repoRoot), timelineEvents(individual));

            const events = timelineEvents(repoRoot);
            const repeated = await composite(repoRoot, 'finish');
            assert.deepEqual([repeated.completed, repeated.stop?.kind], [[], 'terminal']);
            assert.deepEqual(repeated.final_report, finished.final_report);
            assert.deepEqual(timelineEvents(repoRoot), events, 'a repeated finish rewrites no accepted evidence');

            fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const late = "late";\n', 'utf8');
            const drifted = await composite(repoRoot, 'finish');
            assert.deepEqual([drifted.completed, drifted.final_report], [[], null], 'changed source after DONE reports nothing');
            assert.notEqual(drifted.stop?.kind, 'terminal');
            assert.deepEqual(timelineEvents(repoRoot), events);
        } finally {
            fixture.dispose();
        }
    });
});
