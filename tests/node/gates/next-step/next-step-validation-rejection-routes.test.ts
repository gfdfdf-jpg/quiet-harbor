import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveDeclaredValidationDecisionRoute } from '../../../../src/gates/next-step/next-step-validation-routes';
import { readInspectionFailureFacts, VALIDATION_INSPECTION_RETRY_LIMIT, type NextStepQualityChecklistReadiness } from '../../../../src/gates/next-step/next-step-quality-checklist-readiness';
import { ProjectValidationAuthorityError, ValidationInspectionRaceError } from '../../../../src/core/project-validation-errors';
import {
    SAFE_EXIT_LABEL,
    applyNextStepSafeExit,
    findNextStepProgressViolation
} from '../../../../src/gates/next-step/next-step-progress-invariant';
import { resolveGroupedFollowUpAuditBlockedRoute } from '../../../../src/gates/next-step/next-step-closeout-routing';
import type { NextStepDecisionRoutePayload } from '../../../../src/gates/next-step/next-step-decision-route-groups';

const CLI = 'node garda-agent-orchestrator/bin/garda.js';
const TASK_ID = 'T-9';
const NAVIGATOR = `${CLI} next-step "${TASK_ID}" --repo-root "."`;

function route(readiness: Partial<NextStepQualityChecklistReadiness>): NextStepDecisionRoutePayload {
    const resolved = resolveDeclaredValidationDecisionRoute({ cliPrefix: CLI, taskId: TASK_ID, preflightPath: 'runtime/current-preflight.json',
        readiness: readiness as NextStepQualityChecklistReadiness });
    assert.ok(resolved, 'a rejection always resolves to a route');
    return resolved;
}

function subject(payload: NextStepDecisionRoutePayload) {
    return { taskId: TASK_ID, navigatorCommand: NAVIGATOR, status: payload.status, nextGate: payload.nextGate,
        reason: payload.reason, commands: payload.commands, decision: payload.decision ?? null };
}

/** Agent-recoverable: a real progressing command (or the agent's stated work), no operator marker, no reopen preview. */
function assertAgentRecoverable(payload: NextStepDecisionRoutePayload): void {
    assert.equal(payload.decision ?? null, null, payload.reason);
    assert.equal(findNextStepProgressViolation(subject(payload)), null, payload.reason);
    const rendered = applyNextStepSafeExit(subject(payload));
    assert.ok(!rendered.commands.some(entry => entry.label === SAFE_EXIT_LABEL), 'no preview where the agent can progress');
    assert.doesNotMatch(rendered.reason, /No agent command can progress this state/u);
}

/** Operator-only: the marker, a reason naming the decision, and the read-only preview as the only stated command. */
function assertOperatorDecision(payload: NextStepDecisionRoutePayload, decision: RegExp): void {
    assert.equal(payload.decision, 'operator', payload.reason);
    assert.deepEqual(payload.commands, []);
    assert.match(payload.reason, decision);
    assert.equal(findNextStepProgressViolation(subject(payload)), null, payload.reason);
    assert.deepEqual(applyNextStepSafeExit(subject(payload)).commands.map(entry => entry.label), [SAFE_EXIT_LABEL]);
}

test('a rejected admitted recipe carries the fresh-run command for that recipe, as an agent step', () => {
    for (const rejection of ['Recipe neutral retained CANCELLED.', 'Recipe neutral retained FAILED.',
        'Recipe neutral evidence rejected: Error: Foreign validation quality snapshot']) {
        const payload = route({ validationRejection: rejection, validationRejectionFacts: { source: 'phases',
            executionKind: 'declared', structural: 'BOUND', rejectedRecipeIds: ['neutral'] } });
        assert.equal(payload.nextGate, 'project-validation-evidence');
        assert.deepEqual(payload.commands.map(entry => entry.command),
            [`${CLI} gate run-intermediate-command --task-id "T-9" --recipe-id "neutral" --repo-root "."`]);
        assert.match(payload.reason, /record a genuine fresh run of the admitted recipe/u);
        assertAgentRecoverable(payload);
    }
    const several = route({ validationRejection: 'Recipe a retained FAILED. Recipe b retained FAILED.',
        validationRejectionFacts: { source: 'phases', executionKind: 'declared', structural: 'BOUND', rejectedRecipeIds: ['a', 'b'] } });
    assert.deepEqual(several.commands.map(entry => /--recipe-id "(\w+)"/u.exec(entry.command)?.[1]), ['a', 'b']);
});

test('a rejected native check routes to the focused run the agent declares', () => {
    const payload = route({ validationRejection: 'Foreign or stale execution facts.', validationRejectionFacts: {
        source: 'phases', executionKind: 'task-command', structural: 'BOUND', rejectedRecipeIds: [] } });
    assert.equal(payload.nextGate, 'run-intermediate-command');
    assert.match(payload.reason, /gate run-intermediate-command --task-id "T-9" --command-source targeted-test/u);
    assertAgentRecoverable(payload);
});

test('an invalid trust-boundary matrix routes to the checklist correction and names the answers file', () => {
    const payload = route({ validationRejection: 'Matrix-selected case tests/app.test.ts#status has no declared validation target.',
        answersTemplatePath: 'garda-agent-orchestrator/runtime/tmp/T-9-quality-checklist-answers.json',
        validationRejectionFacts: { source: 'phases', executionKind: 'declared', structural: 'INVALID', rejectedRecipeIds: [] } });
    assert.equal(payload.nextGate, 'quality-checklist');
    assert.match(payload.reason, /answer in "garda-agent-orchestrator\/runtime\/tmp\/T-9-quality-checklist-answers\.json"/u);
    assert.match(payload.reason, /resubmit it through quality-checklist/u);
    assertAgentRecoverable(payload);
});

test('contract conflicts, authority and approval changes, and uninspectable evidence are marked operator decisions', () => {
    assertOperatorDecision(route({ validationRejection: 'Error: Declared validation requires capable mandatory code or test review lanes. '
        + 'Task/validation contract conflict: the frozen task policy selects no mandatory code/test lane.',
    validationRejectionFacts: { source: 'review-lanes' } }), /operator decides the task scope, review lanes or validation contract/u);
    assertOperatorDecision(route({ validationRejection: 'Error: Project validation authority changed',
        validationRejectionFacts: { source: 'authority', issue: 'approval' } }), /operator must confirm or re-approve the project validation contract/u);
    // An approval change found while reading recipe evidence is not fixed by a fresh run.
    assertOperatorDecision(route({ validationRejection: 'Recipe neutral evidence rejected: Error: Approved dependency changed: driver.cjs',
        validationRejectionFacts: { source: 'phases', executionKind: 'declared', structural: 'BOUND', rejectedRecipeIds: ['neutral'],
            authorityIssue: 'approval' } }),
    /workflow set --project-validation-contract/u);
    assertOperatorDecision(route({ validationRejection: 'Error: Validation quality preflight changed',
        validationRejectionFacts: { source: 'inspection' } }), /Ask the operator to repair the reported evidence/u);
    // A rejection without structural facts is never guessed into an agent run.
    assertOperatorDecision(route({ validationRejection: 'Foreign or stale execution facts.' }), /Ask the operator/u);
});

test('current phases without a pending execution retry the rejected recipe instead of stopping', () => {
    const payload = route({ ready: true, evidenceStatus: 'current', validationPhases: {
        execution: 'REJECTED', structural: 'BOUND',
        executions: [{ recipe_id: 'neutral', snapshot_sha256: 'a', execution: 'REJECTED', attempt_id: 'x', result_status: null, result_sha256: null }]
    } as never });
    assert.match(payload.commands[0].command, /--recipe-id "neutral"/u);
    assertAgentRecoverable(payload);
});

test('the blocked grouped follow-up audit is a marked operator decision with a stated decision', () => {
    const payload = resolveGroupedFollowUpAuditBlockedRoute('Review integrity blocked final closeout: lost binding.');
    assert.equal(payload.nextGate, 'task-audit-summary');
    assertOperatorDecision(payload as NextStepDecisionRoutePayload, /Ask the operator to decide how the reported closeout evidence is repaired/u);
    assert.match(resolveGroupedFollowUpAuditBlockedRoute(null).reason, /^Final audit is blocked\./u);
});

const REFRESH = `${CLI} gate classify-change --task-id "T-9" --task-intent "Refresh" --output-path "p.json" --repo-root "."`;
const refreshPreflight = () => ({ command: REFRESH });

function routeWith(readiness: Partial<NextStepQualityChecklistReadiness>, refresh = true): NextStepDecisionRoutePayload {
    const resolved = resolveDeclaredValidationDecisionRoute({ cliPrefix: CLI, taskId: TASK_ID, preflightPath: 'runtime/current-preflight.json',
        readiness: readiness as NextStepQualityChecklistReadiness, ...(refresh ? { refreshPreflight } : {}) });
    assert.ok(resolved);
    return resolved;
}

test('rejection text naming Garda errors (user case ids, paths) never selects the route; the typed facts do', () => {
    // A user-chosen case id or path can spell any Garda diagnostic; it must not turn an agent fix into an operator stop.
    const hijack = 'Matrix-selected case tests/Project validation authority changed.ts#Native case execution record changed '
        + 'has no declared validation target. Approved dependency changed: x';
    const checklist = routeWith({ validationRejection: hijack, answersTemplatePath: 'answers.json',
        validationRejectionFacts: { source: 'phases', executionKind: 'declared', structural: 'INVALID', rejectedRecipeIds: [] } });
    assert.equal(checklist.nextGate, 'quality-checklist');
    assertAgentRecoverable(checklist);
    const recipe = routeWith({ validationRejection: `Recipe neutral retained FAILED. ${hijack}`,
        validationRejectionFacts: { source: 'phases', executionKind: 'declared', structural: 'BOUND', rejectedRecipeIds: ['neutral'] } });
    assert.match(recipe.commands[0].command, /--recipe-id "neutral"/u);
    assertAgentRecoverable(recipe);
    // The same text without typed facts stays an operator decision: nothing is guessed from it in either direction.
    assertOperatorDecision(routeWith({ validationRejection: hijack }), /could not inspect/u);
    assertOperatorDecision(routeWith({ validationRejection: hijack, validationRejectionFacts: { source: 'inspection' } }),
        /could not inspect/u);
});

test('a typed inspection race retries next-step with a fresh inspection, or refreshes a preflight the recipes did not freeze', () => {
    const retry = routeWith({ validationRejection: 'Error: Validation timeline or scope changed during batch inspection',
        validationRejectionFacts: { source: 'inspection', retry: 'next-step', retryToken: '1:' + 'a'.repeat(64) } });
    assert.equal(retry.nextGate, 'validation-inspection');
    assert.deepEqual(retry.commands.map(entry => entry.command), [`${NAVIGATOR} --inspection-retry "1:${'a'.repeat(64)}"`]);
    assert.match(retry.reason, /retry next-step with a fresh inspection/u);
    assertAgentRecoverable(retry);
    const refresh = routeWith({ validationRejection: 'Error: Validation quality preflight changed',
        validationRejectionFacts: { source: 'inspection', retry: 'classify-change' } });
    assert.equal(refresh.nextGate, 'classify-change');
    assert.deepEqual(refresh.commands.map(entry => entry.command), [REFRESH]);
    assertAgentRecoverable(refresh);
    // Without a refresh command the navigator cannot state one: an unknown way on stays the operator's.
    assertOperatorDecision(routeWith({ validationRejection: 'Error: Validation quality preflight changed',
        validationRejectionFacts: { source: 'inspection', retry: 'classify-change' } }, false), /could not inspect/u);
});

test('an authority change after an audited admission refreshes the preflight; without one it stays the operator decision', () => {
    const rejection = 'Error: Project validation authority changed; refresh preflight after audited admission';
    const readmitted = routeWith({ validationRejection: rejection, validationRejectionFacts: { source: 'authority', issue: 'readmitted' } });
    assert.equal(readmitted.nextGate, 'classify-change');
    assert.deepEqual(readmitted.commands.map(entry => entry.command), [REFRESH]);
    assert.match(readmitted.reason, /audited admission newer than the one this preflight froze/u);
    assertAgentRecoverable(readmitted);
    assertOperatorDecision(routeWith({ validationRejection: rejection, validationRejectionFacts: { source: 'authority', issue: 'approval' } }),
        /operator must confirm or re-approve/u);
    assertOperatorDecision(routeWith({ validationRejection: rejection, validationRejectionFacts: { source: 'authority', issue: 'readmitted' } },
        false), /operator must confirm or re-approve/u);
});

test('bound declared phases without a selectable execution say so instead of could-not-inspect', () => {
    const payload = route({ ready: true, evidenceStatus: 'current', validationPhases: {
        execution: 'PENDING', structural: 'BOUND',
        executions: [{ recipe_id: 'neutral', snapshot_sha256: 'a', execution: 'OBSERVED', attempt_id: 'x', result_status: 'PASSED', result_sha256: 'b' }]
    } as never });
    assertOperatorDecision(payload, /declared validation phases are bound but name no pending or rejected recipe execution/u);
    assert.doesNotMatch(payload.reason, /could not inspect/u);
});

test('readiness turns typed validation errors into rejection facts and leaves unknown exceptions to the operator', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-rejection-facts-'));
    try {
        const preflight = path.join(root, 'garda-agent-orchestrator/runtime/reviews/T-9-preflight.json');
        assert.deepEqual(readInspectionFailureFacts(new ProjectValidationAuthorityError('a', 'readmitted'), root, TASK_ID, preflight),
            { source: 'authority', issue: 'readmitted' });
        assert.deepEqual(readInspectionFailureFacts(new ProjectValidationAuthorityError('a'), root, TASK_ID, preflight),
            { source: 'authority', issue: 'approval' });
        for (const race of ['timeline', 'identities'] as const) {
            const facts = readInspectionFailureFacts(new ValidationInspectionRaceError('r', race), root, TASK_ID, preflight);
            assert.equal(facts.source === 'inspection' && facts.retry, 'next-step');
            assert.match(facts.source === 'inspection' ? String(facts.retryToken) : '', /^1:[a-f0-9]{64}$/u);
        }
        // No classified preflight names this file: only a refresh at the navigator path reconciles both reads.
        assert.deepEqual(readInspectionFailureFacts(new ValidationInspectionRaceError('r', 'preflight'), root, TASK_ID, preflight),
            { source: 'inspection', retry: 'classify-change' });
        // An untyped error spelling a race or authority message is unknown: no retry, no authority route.
        for (const message of ['Validation timeline or scope changed during batch inspection', 'Project validation authority changed'])
            assert.deepEqual(readInspectionFailureFacts(new Error(message), root, TASK_ID, preflight), { source: 'inspection' });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the inspection retry is bounded: unchanged content or a spent bound becomes a marked operator decision', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-retry-bound-'));
    try {
        const preflight = path.join(root, 'garda-agent-orchestrator/runtime/reviews/T-9-preflight.json');
        fs.mkdirSync(path.dirname(preflight), { recursive: true });
        fs.writeFileSync(preflight, '{"v":1}');
        const race = () => new ValidationInspectionRaceError('Error: Validation timeline or scope changed during batch inspection', 'timeline');
        const first = readInspectionFailureFacts(race(), root, TASK_ID, preflight);
        const token = first.source === 'inspection' ? String(first.retryToken) : '';
        assert.match(token, /^1:[a-f0-9]{64}$/u);
        // The same race again on unchanged content: not a concurrent change, never retried again.
        const unchanged = readInspectionFailureFacts(race(), root, TASK_ID, preflight, token);
        assert.deepEqual(unchanged, { source: 'inspection', stop: 'unchanged', attempts: 1 });
        assertOperatorDecision(routeWith({ validationRejection: 'Error: race', validationRejectionFacts: unchanged }),
            /repeated on unchanged preflight, timeline and recipe content/u);
        // Changed content advances the attempt until the bound is spent; a writer that never stops cannot loop either.
        fs.writeFileSync(preflight, '{"v":2}');
        const second = readInspectionFailureFacts(race(), root, TASK_ID, preflight, token);
        assert.match(second.source === 'inspection' ? String(second.retryToken) : '', /^2:[a-f0-9]{64}$/u);
        const spent = readInspectionFailureFacts(race(), root, TASK_ID, preflight, `${VALIDATION_INSPECTION_RETRY_LIMIT}:${'b'.repeat(64)}`);
        assert.deepEqual(spent, { source: 'inspection', stop: 'exhausted', attempts: VALIDATION_INSPECTION_RETRY_LIMIT });
        assertOperatorDecision(routeWith({ validationRejection: 'Error: race', validationRejectionFacts: spent }),
            new RegExp(`kept changing across ${VALIDATION_INSPECTION_RETRY_LIMIT} fresh inspections`, 'u'));
        // A malformed token is no witness: the retry starts over at the first attempt, never beyond the bound.
        const malformed = readInspectionFailureFacts(race(), root, TASK_ID, preflight, '999:zz');
        assert.match(malformed.source === 'inspection' ? String(malformed.retryToken) : '', /^1:/u);
        assertOperatorDecision(routeWith({ validationRejection: 'Error: Validation quality preflight changed',
            validationRejectionFacts: { source: 'inspection', stop: 'preflight-identity' } }),
        /stable and equal to the classification the declared recipes froze/u);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
