import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { prepareOperatorTaskIntentUpdate, recordOperatorTaskIntentUpdate } from '../../../../src/gates/review-context/review-context-task-intent';
import { classifyChange, getClassificationConfig } from '../../../../src/gates/preflight/classify-change';
import { buildTaskCriteria, buildTaskCriteriaMarkdown } from '../../../../src/gates/review-context/review-context-task-criteria';
import { joinOrchestratorPath } from '../../../../src/core/orchestrator-paths';
import { assessTrustBoundaryAnalysisApplicability } from '../../../../src/core/trust-boundary-analysis';

import {
    computeTaskCriteriaBinding,
    getReviewContextTaskCriteriaViolation,
    hasTaskCriteriaChanged,
    readTaskCriteriaBinding,
    resolveRestartTaskIntent
} from '../../../../src/gates/review-context/review-context-task-criteria-binding';

const HEADER = ['| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |', '|---|---|---|---|---|---|---|---|---|'];
const CARD_LINK = '[T-1](docs/cards.md#t-1)';

function row(cells: { id?: string; status?: string; title?: string; owner?: string; updated?: string; notes?: string }): string {
    return `| ${cells.id ?? 'T-1'} | ${cells.status ?? 'TODO'} | P1 | app | ${cells.title ?? 'Change the status renderer'} | `
        + `${cells.owner ?? 'me'} | ${cells.updated ?? '2026-11-01'} | balanced | ${cells.notes ?? 'Keep the API.'} |`;
}

function withRepo(run: (repoRoot: string, write: (rows: string[], card?: string[]) => void) => void): void {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-criteria-binding-'));
    try {
        run(repoRoot, (rows, card) => {
            fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [...HEADER, ...rows, ''].join('\n'));
            if (card) {
                fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
                fs.writeFileSync(path.join(repoRoot, 'docs', 'cards.md'), ['# Cards', '', '## T-1', '', ...card, ''].join('\n'));
            }
        });
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
}

const preflight = (intent: string) => ({ task_id: 'T-1', effective_review_snapshot: { inputs: { task_intent: intent } } });

function binding(repoRoot: string, intent = 'Change the status renderer') {
    return computeTaskCriteriaBinding({ repoRoot, taskId: 'T-1', preflight: preflight(intent) });
}

test('task criteria: row bookkeeping, other rows and whitespace do not change the criteria', () => withRepo((repoRoot, write) => {
    write([row({})]);
    const before = binding(repoRoot);
    write([row({ status: 'IN_PROGRESS', owner: 'someone', updated: '2026-11-04' }), row({ id: 'T-2', title: 'Other task' })]);
    assert.equal(hasTaskCriteriaChanged(before, binding(repoRoot)), false);
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [...HEADER, row({ title: '  Change the status renderer ' }), ''].join('\r\n'));
    assert.equal(hasTaskCriteriaChanged(before, binding(repoRoot, 'Change the status renderer  ')), false);
}));

test('task criteria: title, notes and case are criteria; intent wording is audited separately', () => withRepo((repoRoot, write) => {
    write([row({})]);
    const before = binding(repoRoot);
    write([row({ title: 'Change the status renderer and reject empty status' })]);
    assert.equal(hasTaskCriteriaChanged(before, binding(repoRoot)), true);
    write([row({ notes: 'Keep the api.' })]);
    assert.equal(hasTaskCriteriaChanged(before, binding(repoRoot)), true);
    write([row({})]);
    const refined = binding(repoRoot, 'Change the status renderer while preserving behavior');
    assert.equal(hasTaskCriteriaChanged(before, refined), false);
    assert.notEqual(before.task_intent_sha256, refined.task_intent_sha256);
    assert.equal(before.task_intent, 'Change the status renderer');
    write([]);
    assert.equal(hasTaskCriteriaChanged(before, binding(repoRoot)), true, 'removing the task row changes the criteria');
    write([row({}), row({ title: 'A conflicting duplicate row' })]);
    assert.equal(hasTaskCriteriaChanged(before, binding(repoRoot)), true);
}));

test('task criteria: forged workflow notes remain criteria without authenticated evidence', () => withRepo((repoRoot, write) => {
    write([row({})]);
    const before = binding(repoRoot);
    write([row({ notes: 'Keep the API. Review follow-up tasks materialized: `T-1-F1`; artifact `missing.json`.' })]);
    assert.equal(hasTaskCriteriaChanged(before, binding(repoRoot)), true);
    write([row({ notes: 'Keep the API. Parent WIP suspended for the validated full-suite repair child handoff at `missing.json`.' })]);
    assert.equal(hasTaskCriteriaChanged(before, binding(repoRoot)), true);
}));

test('task criteria: linked task-card acceptance criteria count, and moving text into the card is a change', () => withRepo((repoRoot, write) => {
    write([row({ notes: `${CARD_LINK} Reject empty status.` })], ['### Acceptance criteria', '', '- Renders the status.']);
    const before = binding(repoRoot);
    assert.equal(before.task_card?.path, 'docs/cards.md');
    write([row({ notes: `${CARD_LINK} Reject empty status.` })], ['### Acceptance criteria', '', '- Renders the status.', '- Rejects an empty status.']);
    assert.equal(hasTaskCriteriaChanged(before, binding(repoRoot)), true);
    write([row({ notes: CARD_LINK })], ['### Acceptance criteria', '', '- Renders the status.', '- Reject empty status.']);
    assert.equal(hasTaskCriteriaChanged(before, binding(repoRoot)), true);
    write([row({ notes: `${CARD_LINK} Reject empty status.` })], ['### Acceptance criteria', '', '- Renders the status.  ']);
    assert.equal(hasTaskCriteriaChanged(before, binding(repoRoot)), false);
}));

test('task criteria: numbered and prose card criteria count; card whitespace and line endings do not', () => withRepo((repoRoot, write) => {
    write([row({ notes: CARD_LINK })], ['### Acceptance criteria', '', '1. Parser accepts JSON', '2. Errors exit 2']);
    const numbered = binding(repoRoot);
    write([row({ notes: CARD_LINK })], ['### Acceptance criteria', '', '1. Parser accepts YAML', '2. Errors exit 2']);
    assert.equal(hasTaskCriteriaChanged(numbered, binding(repoRoot)), true);
    write([row({ notes: CARD_LINK })], ['### Acceptance criteria', '', '1. Parser accepts JSON  ', '2. Errors exit 2']);
    assert.equal(hasTaskCriteriaChanged(numbered, binding(repoRoot)), false);
    write([row({ notes: CARD_LINK })], ['The parser accepts JSON and exits 2 on errors.']);
    const prose = binding(repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'docs', 'cards.md'), ['# Cards', '', '## T-1', '', 'The parser accepts JSON and exits 2 on errors.', ''].join('\r\n'));
    assert.equal(hasTaskCriteriaChanged(prose, binding(repoRoot)), false);
    fs.writeFileSync(path.join(repoRoot, 'docs', 'cards.md'), ['# Cards', '', '## T-1', '', 'The parser accepts JSON and exits 2 on errors.', ''].join('\r'));
    assert.equal(hasTaskCriteriaChanged(prose, binding(repoRoot)), false);
    write([row({ notes: CARD_LINK })], ['The parser accepts JSON and exits 0 on errors.']);
    assert.equal(hasTaskCriteriaChanged(prose, binding(repoRoot)), true);
}));

test('task criteria: this task\'s operator decisions count, other tasks\' decisions do not', () => withRepo((repoRoot, write) => {
    const decisions = (...lines: string[]) => ['', '## Operator Decisions', '', ...lines];
    write([row({}), ...decisions('- T-1 operator decision (2026-11-01): Keep the API.', '- T-2 operator decision (2026-11-01): Old.')]);
    const before = binding(repoRoot);
    assert.equal(before.task_operator_decisions.length, 1);
    write([row({}), ...decisions('- T-1 operator decision (2026-11-01): Keep the API.  ', '- T-2 operator decision (2026-11-02): New.')]);
    assert.equal(hasTaskCriteriaChanged(before, binding(repoRoot)), false);
    write([row({}), ...decisions('- T-1 operator decision (2026-11-01): Keep the API.', '- T-1 operator decision (2026-11-03): Reject empty status.')]);
    assert.equal(hasTaskCriteriaChanged(before, binding(repoRoot)), true);
    write([row({}), ...decisions('- T-1 operator decision (2026-11-01): Keep the api.')]);
    assert.equal(hasTaskCriteriaChanged(before, binding(repoRoot)), true);
    write(['- T-1 operator decision (2026-11-01): Keep the API.', row({}), ...decisions()]);
    assert.equal(hasTaskCriteriaChanged(before, binding(repoRoot)), true, 'a decision moved out of its section is a change');
}));

test('task criteria: a missing or altered recorded binding counts as a change', () => withRepo((repoRoot, write) => {
    write([row({})]);
    const current = binding(repoRoot);
    assert.equal(hasTaskCriteriaChanged(undefined, current), true);
    assert.equal(hasTaskCriteriaChanged({ ...current, task_intent: 'Something else' }, current), true);
    assert.equal(readTaskCriteriaBinding({ ...current, task_rows: [] }), null);
    assert.equal(hasTaskCriteriaChanged(current, JSON.parse(JSON.stringify(current))), false);
    assert.equal(hasTaskCriteriaChanged({ ...current, schema: 'garda.task-criteria-binding.v2' }, current), true,
        'the older normalization discarded meaningful whitespace');
}));

test('task criteria: internal spaces, indentation and line structure change the binding', () => withRepo((repoRoot, write) => {
    write([row({ notes: 'Output exactly `hello world`.' })]);
    const literal = binding(repoRoot);
    write([row({ notes: 'Output exactly `hello  world`.' })]);
    assert.equal(hasTaskCriteriaChanged(literal, binding(repoRoot)), true);
    assert.equal(hasTaskCriteriaChanged(binding(repoRoot, '    echo hello'), binding(repoRoot, '   echo hello')), false);
    assert.equal(hasTaskCriteriaChanged(binding(repoRoot, 'one\nline'), binding(repoRoot, 'one line')), false);
    write([row({ notes: CARD_LINK })], ['### Acceptance criteria', '', '    echo hello', '- first', '  - nested', 'one line']);
    const card = binding(repoRoot);
    for (const changed of [
        ['### Acceptance criteria', '', '   echo hello', '- first', '  - nested', 'one line'],
        ['### Acceptance criteria', '', '    echo hello', '- first', '- nested', 'one line'],
        ['### Acceptance criteria', '', '    echo hello', '- first', '  - nested', 'one', 'line']
    ]) {
        write([row({ notes: CARD_LINK })], changed);
        assert.equal(hasTaskCriteriaChanged(card, binding(repoRoot)), true);
    }
}));

test('task criteria: agent supplements never become criteria, even without durable scope or with new requirement words', () => withRepo((repoRoot, write) => {
    write([]);
    assert.equal(hasTaskCriteriaChanged(binding(repoRoot, 'Output JSON'), binding(repoRoot, 'Output YAML')), false);
    write([row({})]);
    const before = binding(repoRoot, 'Render the status');
    for (const supplement of ['after authorization checks', 'endpoint', 'with lower latency', 'refactor the renderer',
        'require the recorded acceptance examples to cover empty input']) {
        assert.equal(hasTaskCriteriaChanged(before, binding(repoRoot, `Render the status ${supplement}`)), false, supplement);
    }
    write([row({ title: '', notes: '' })]);
    assert.equal(hasTaskCriteriaChanged(binding(repoRoot, 'Output JSON'), binding(repoRoot, 'Output YAML')), false);
}));

test('task criteria: enabling or disabling a review lane for an unchanged scope is not a criteria change', () => withRepo((repoRoot, write) => {
    write([row({})]);
    const triggers = { security: true, api: true, performance: true, refactor: true };
    const lanes = (required: Record<string, boolean>, laneTriggers: Record<string, boolean> = triggers) => computeTaskCriteriaBinding({
        repoRoot, taskId: 'T-1', preflight: { ...preflight('Change the status renderer'), triggers: laneTriggers, required_reviews: required } });
    const disabled = lanes({ code: true, security: false, api: false, performance: false, refactor: false });
    for (const lane of ['security', 'api', 'performance', 'refactor']) {
        const enabled = lanes({ code: true, security: false, api: false, performance: false, refactor: false, [lane]: true });
        assert.equal(hasTaskCriteriaChanged(disabled, enabled), false, `enabling the ${lane} lane`);
        assert.equal(hasTaskCriteriaChanged(enabled, disabled), false, `disabling the ${lane} lane`);
    }
    const untriggered = lanes({ code: true }, {});
    for (const lane of ['security', 'api', 'performance', 'refactor']) {
        assert.equal(hasTaskCriteriaChanged(untriggered, lanes({ code: true }, { [lane]: true })), true,
            `a new ${lane} trigger is a changed verification obligation`);
    }
    assert.equal(hasTaskCriteriaChanged(untriggered, lanes({ code: true, api: true }, {})), false,
        'a lane forced by review policy alone is not a task criterion');
}));

test('task criteria: only the confirmed path changes criteria, including plain rewording; agent descriptions cannot undo it', () => withRepo((repoRoot, write) => {
    write([row({})]);
    const before = binding(repoRoot);
    const operatorIntent = 'Describe the status rendering task more clearly';
    assert.equal(prepareOperatorTaskIntentUpdate({ repoRoot, taskId: 'T-1', previousIntent: before.task_intent, taskIntent: operatorIntent }), null);
    const update = prepareOperatorTaskIntentUpdate({ repoRoot, taskId: 'T-1', previousIntent: before.task_intent, taskIntent: operatorIntent,
        operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() });
    assert.ok(update);
    recordOperatorTaskIntentUpdate(repoRoot, update);
    const confirmed = binding(repoRoot, operatorIntent);
    assert.equal(hasTaskCriteriaChanged(before, confirmed), true);
    assert.equal(readTaskCriteriaBinding(confirmed)?.operator_task_intent?.task_intent, operatorIntent);
    const supplement = 'require the recorded acceptance examples to cover empty input';
    assert.equal(hasTaskCriteriaChanged(confirmed, binding(repoRoot, supplement)), false);
    const criteria = buildTaskCriteria({ repoRoot, taskId: 'T-1', preflight: preflight(supplement), taskModeEvidence: null });
    assert.equal(criteria.task_intent.text, supplement);
    assert.equal(criteria.operator_task_intent?.task_intent, operatorIntent);
    assert.equal(prepareOperatorTaskIntentUpdate({ repoRoot, taskId: 'T-1', previousIntent: supplement,
        taskIntent: operatorIntent, operatorConfirmed: 'yes' }), null, 'confirming existing operator criteria does not reset reviews');
    assert.match(buildTaskCriteriaMarkdown(criteria).join('\n'), /Operator-confirmed task intent.*Describe the status rendering/u);
    const nextUpdate = prepareOperatorTaskIntentUpdate({ repoRoot, taskId: 'T-1', previousIntent: supplement, taskIntent: before.task_intent,
        operatorConfirmed: 'yes' });
    assert.ok(nextUpdate);
    recordOperatorTaskIntentUpdate(repoRoot, nextUpdate);
    assert.equal(hasTaskCriteriaChanged(before, binding(repoRoot)), true, 'returning to earlier wording must not revive an old criteria epoch');
}));

test('task criteria: classification still requires intent-triggered lanes without resetting accepted lanes', () => withRepo((repoRoot, write) => {
    write([row({})]);
    const classified = (intent: string) => ({ ...classifyChange({ classificationConfig: getClassificationConfig(repoRoot),
        normalizedFiles: ['src/status.ts'], taskIntent: intent }), task_intent: intent });
    const original = classified('Render the status');
    const supplemented = classified('Refactor the status endpoint after authorization checks with lower latency');
    assert.equal(original.triggers.security_intent, false);
    assert.equal(supplemented.triggers.security_intent, true);
    assert.equal(supplemented.triggers.api_intent, true);
    assert.equal(supplemented.triggers.performance_intent, true);
    assert.equal(supplemented.triggers.refactor_intent, true);
    assert.equal(hasTaskCriteriaChanged(computeTaskCriteriaBinding({ repoRoot, taskId: 'T-1', preflight: original }),
        computeTaskCriteriaBinding({ repoRoot, taskId: 'T-1', preflight: supplemented })), false);
}));

test('intent obligations: an agent description cannot remove operator authorization or trust-boundary requirements', () => withRepo((repoRoot, write) => {
    write([row({ title: 'Render status', notes: '' })]);
    const operatorIntent = 'Enforce the authorization boundary before rendering status';
    const update = prepareOperatorTaskIntentUpdate({ repoRoot, taskId: 'T-1', previousIntent: 'Render status',
        taskIntent: operatorIntent, operatorConfirmed: 'yes' });
    assert.ok(update);
    recordOperatorTaskIntentUpdate(repoRoot, update);
    const classified = (intent: string) => {
        const options = { repoRoot, taskId: 'T-1', classificationConfig: getClassificationConfig(repoRoot),
            normalizedFiles: ['src/status.ts'], taskIntent: intent };
        return { ...classifyChange(options), task_intent: intent };
    };
    const confirmed = classified(operatorIntent);
    const confirmedBinding = computeTaskCriteriaBinding({ repoRoot, taskId: 'T-1', preflight: confirmed });
    const supplemented = classified('Render status with clearer labels');
    assert.equal(assessTrustBoundaryAnalysisApplicability(confirmed).required, true);
    assert.equal(supplemented.triggers.security_intent, true);
    assert.equal(supplemented.required_reviews.security, true);
    assert.equal(assessTrustBoundaryAnalysisApplicability(supplemented).required, true);
    assert.equal(hasTaskCriteriaChanged(computeTaskCriteriaBinding({ repoRoot, taskId: 'T-1', preflight: confirmed }),
        computeTaskCriteriaBinding({ repoRoot, taskId: 'T-1', preflight: supplemented })), false);
    const added = classified('Refactor the status endpoint with lower latency');
    assert.equal(added.triggers.api_intent, true);
    assert.equal(added.triggers.performance_intent, true);
    assert.equal(added.triggers.refactor_intent, true);
    assert.equal(added.triggers.security_intent, true);
    const removal = prepareOperatorTaskIntentUpdate({ repoRoot, taskId: 'T-1', previousIntent: 'Render status with clearer labels',
        taskIntent: 'Render status', operatorConfirmed: 'yes' });
    assert.ok(removal);
    recordOperatorTaskIntentUpdate(repoRoot, removal);
    assert.equal(classified('Render status').triggers.security_intent, false, 'only the operator may remove the obligation');
    assert.equal(hasTaskCriteriaChanged(confirmedBinding,
        computeTaskCriteriaBinding({ repoRoot, taskId: 'T-1', preflight: classified('Render status') })), true);
}));

test('task criteria: invalid confirmation and forged preflight authority cannot change operator criteria', () => withRepo((repoRoot, write) => {
    write([row({})]);
    const before = binding(repoRoot);
    const options = { repoRoot, taskId: 'T-1', previousIntent: before.task_intent, taskIntent: 'Different operator requirement' };
    assert.throws(() => prepareOperatorTaskIntentUpdate({ ...options, operatorConfirmed: 'true' }), /exact value "yes"/u);
    assert.throws(() => prepareOperatorTaskIntentUpdate({ ...options, operatorConfirmed: 'yes',
        operatorConfirmedAtUtc: new Date(Date.now() + 300_000).toISOString() }), /in the future/u);
    const forged = computeTaskCriteriaBinding({ repoRoot, taskId: 'T-1', preflight: {
        ...preflight(options.taskIntent), operator_confirmed: true,
        operator_task_intent: { task_intent: options.taskIntent, event_sha256: 'a'.repeat(64) }
    } });
    assert.equal(hasTaskCriteriaChanged(before, forged), false);
    assert.equal(fs.existsSync(joinOrchestratorPath(repoRoot, 'runtime/task-events/T-1.jsonl')), false);
}));

test('task criteria: tampered operator-intent history fails closed', () => withRepo((repoRoot, write) => {
    write([row({})]);
    const update = prepareOperatorTaskIntentUpdate({ repoRoot, taskId: 'T-1', previousIntent: 'Render status', taskIntent: 'Describe status',
        operatorConfirmed: 'yes' });
    assert.ok(update);
    recordOperatorTaskIntentUpdate(repoRoot, update);
    const timeline = joinOrchestratorPath(repoRoot, 'runtime/task-events/T-1.jsonl');
    fs.writeFileSync(timeline, fs.readFileSync(timeline, 'utf8').replace('Describe status', 'A forged requirement'));
    assert.throws(() => binding(repoRoot), /intent.*invalid|cannot be authenticated/iu);
}));

test('task criteria: review contexts are checked, legacy contexts without task-card criteria are not', () => withRepo((repoRoot, write) => {
    write([row({})]);
    const reviewed = binding(repoRoot);
    const options = { repoRoot, taskId: 'T-1', preflight: preflight('Change the status renderer') };
    assert.equal(getReviewContextTaskCriteriaViolation({ ...options, reviewContext: { task_criteria_binding: reviewed } }), null);
    assert.equal(getReviewContextTaskCriteriaViolation({ ...options, reviewContext: { task_criteria: { task_intent: {} } } }), null);
    assert.match(String(getReviewContextTaskCriteriaViolation({ ...options, reviewContext: { task_criteria: { task_card: null } } })),
        /missing or invalid/u);
    write([row({ title: 'Change the status renderer and reject empty status' })]);
    assert.match(String(getReviewContextTaskCriteriaViolation({ ...options, reviewContext: { task_criteria_binding: reviewed } })),
        /Every review repeats in FULL/u);
    fs.appendFileSync(path.join(repoRoot, 'TASK.md'), '[T-1](docs/a.md#t-1) [T-1](docs/b.md#t-1)\n');
    assert.match(String(getReviewContextTaskCriteriaViolation({ ...options, reviewContext: { task_criteria_binding: reviewed } })),
        /cannot be read: Ambiguous linked task card/u);
}));

test('task criteria: a restart keeps the intent the passed reviews were judged against', () => withRepo((repoRoot, write) => {
    // A preflight can use an intent different from both the task title and task-mode summary.
    write([row({ title: 'Add parser' })]);
    const taskMode = { task_summary: 'Implement config parser' };
    const classified = preflight('Parse config files');
    const restartIntent = resolveRestartTaskIntent({ repoRoot, taskId: 'T-1', preflight: classified, taskMode });
    assert.equal(restartIntent, 'Parse config files');
    assert.equal(hasTaskCriteriaChanged(binding(repoRoot, 'Parse config files'), binding(repoRoot, restartIntent)), false);
    assert.equal(resolveRestartTaskIntent({ repoRoot, taskId: 'T-1', preflight: null, taskMode }), 'Add parser');
    // Without a TASK.md row: the preflight intent, then the task-mode summary.
    assert.equal(resolveRestartTaskIntent({ repoRoot, taskId: 'T-9', preflight: preflight('Custom  intent'), taskMode }), 'Custom  intent');
    assert.equal(resolveRestartTaskIntent({ repoRoot, taskId: 'T-9', preflight: null, taskMode }), 'Implement config parser');
}));
