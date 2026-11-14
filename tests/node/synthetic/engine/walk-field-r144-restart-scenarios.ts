import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WalkResult, WalkScenario, WalkStep } from './navigator-walk';
import { splitCommandLine } from '../../../../src/core/command-line';
import { handleGate } from '../../../../src/cli/commands/gate-command';
import { handleSet } from '../../../../src/cli/commands/workflow/workflow-command-set';
import { captureWalkOutput } from './walk-output';
import { nativeWalkCommand } from './walk-native';
import { LEGACY_BROAD_COMMAND, LEGACY_TASK_TARGET } from './walk-legacy-task-contract';

// Sources: fix-intent2.stand-request.md (R2-1/T-468) and fix144-protected.report.md.
// C6.1.3/C6.1.4: building context cannot confer PASS authority. C6.2.1/C6.2.4:
// unchanged criteria preserve reviews; an operator criterion repeats every mandatory lane FULL.
const TASK = 'T-WALK';
const REVIEWS = 'garda-agent-orchestrator/runtime/reviews/';
const PREFLIGHT = REVIEWS + TASK + '-preflight.json';
const TIMELINE = 'garda-agent-orchestrator/runtime/task-events/' + TASK + '.jsonl';
const TITLE = 'Change the status renderer';
const SUPPLEMENT = TITLE + '; the agent also covers empty input';
const CHANGED_INTENT = TITLE + '; reject empty status';
const DESCRIPTION_ANALYSIS = [
    'Reviewer finding: none, the current code and test reports both passed',
    'Intended fix: clarify only the agent description, without changing any implementation or operator requirement',
    'Affected files and contracts: src/app.ts and tests/app.test.ts retain their reviewed bytes and behavior',
    'Runtime and test impact: no new behavior, command, target or execution obligation',
    'Possible side effects: accidentally treating descriptive wording as operator authority would waste fresh reviews',
    'Required targeted checks: preserve the criteria digest and both accepted receipts through the native restart',
    'Scope or review-type changes: none, the existing code and test lanes remain mandatory',
    'Related blocker or follow-up decision: no unresolved finding and no additional task is needed'
].join('; ');
const EDITS = [{ path: 'src/app.ts', append: '// field r144\n' }, { path: 'tests/app.test.ts', append: '// field r144\n' }];
const BASE = { reviewerSelfCheck: true, profile: 'balanced' as const, mode: 'code_first_optional' as const,
    selectionTargets: [LEGACY_TASK_TARGET], testSelectionCommand: LEGACY_BROAD_COMMAND };
const read = (root: string, file: string) => fs.readFileSync(path.resolve(root, file));
const json = (root: string, file: string) => JSON.parse(read(root, file).toString('utf8'));
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const events = (root: string): Array<{ event_type: string; details: Record<string, unknown> }> =>
    read(root, TIMELINE).toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
const updates = (root: string) => events(root).filter(event => event.event_type === 'TASK_INTENT_UPDATED');
const scope = (root: string) => json(root, PREFLIGHT).changed_files;
const intent = (root: string) => json(root, PREFLIGHT).effective_review_snapshot.inputs.task_intent;
const passed = (step: WalkStep | undefined, gate: string, lane?: string) => step?.gate === gate && step.exitCode === 0
    && (!lane || splitCommandLine(step.command!).includes(lane));
const gateArgv = (command: string) => { const argv = splitCommandLine(command); return argv.slice(argv.indexOf('gate') + 1); };
const contextFile = (lane: string) => REVIEWS + TASK + '-' + lane + '-review-context.json';
const receiptFile = (lane: string) => REVIEWS + TASK + '-' + lane + '-receipt.json';
const restartArgs = (gate: string, wording: string) => [gate, '--task-id', TASK, '--repo-root', '.',
    '--preflight-path', PREFLIGHT, '--task-intent', wording, ...EDITS.flatMap(edit => ['--changed-file', edit.path])];
const confirmation = () => ['--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString()];

interface SavedPass {
    lane: string;
    context: ReturnType<typeof json>;
    receipt: ReturnType<typeof json>;
    files: Array<{ file: string; bytes: Buffer; sha256: string }>;
}
function savePass(root: string, lane: string): SavedPass {
    const baseline = json(root, REVIEWS + TASK + '-' + lane + '-remediation-baseline.json');
    const files = [contextFile(lane), ...Object.values(baseline.bindings as Record<string, { snapshot_path?: string }>)
        .flatMap(binding => binding.snapshot_path ? [binding.snapshot_path] : [])]
        .map(file => ({ file, bytes: read(root, file), sha256: digest(read(root, file)) }));
    const receipt = json(root, receiptFile(lane));
    assert.notEqual(receipt.reused_existing_review, true, 'Capture a fresh native PASS');
    return { lane, context: json(root, contextFile(lane)), receipt, files };
}
function assertSnapshots(root: string, saved: SavedPass): void {
    // The mutable context is expected to change. Every original immutable binding must retain its bytes and SHA.
    for (const file of saved.files.slice(1)) {
        assert.deepEqual(read(root, file.file), file.bytes, 'Original snapshot changed: ' + file.file);
        assert.equal(digest(read(root, file.file)), file.sha256);
    }
}
function assertNoReuse(root: string, saved: SavedPass, since: number, sourceBytes: Buffer[], originalScope: unknown): void {
    assert.ok(!events(root).slice(since).some(event => event.event_type === 'REVIEW_RECORDED'
        && event.details.review_type === saved.lane && event.details.reused_existing_review === true),
    'Changed criteria must never materialize an old PASS on either context build');
    const receiptPath = path.resolve(root, receiptFile(saved.lane));
    if (fs.existsSync(receiptPath)) assert.notEqual(json(root, receiptFile(saved.lane)).reused_existing_review, true,
        'Changed criteria must not replace the mutable receipt with reused authority');
    assertSnapshots(root, saved);
    assert.deepEqual(EDITS.map(edit => read(root, edit.path)), sourceBytes, 'Only criteria change, never source bytes');
    assert.deepEqual(scope(root), originalScope, 'Review scope stays unchanged');
    const current = json(root, contextFile(saved.lane));
    assert.notEqual(current.task_criteria_binding.sha256, saved.context.task_criteria_binding.sha256);
    assert.equal(current.review_execution.mode, 'FULL', 'A changed criterion always requires FULL');
}

/** Execute only the printed command, filling the modeled operator's current confirmation timestamp. */
async function approveProtectedRestart(_root: string, step: WalkStep): Promise<boolean> {
    if (step.gate !== 'restart-coherent-cycle' || !step.command?.includes('<ISO-8601 timestamp>')) return false;
    step.command = step.command.replace('<ISO-8601 timestamp>', new Date().toISOString());
    step.userApproval = true;
    const argv = gateArgv(step.command);
    if (process.env.GARDA_SYNTHETIC_WALK_DIAGNOSTICS) {
        const result = nativeWalkCommand(['gate', ...argv]);
        step.exitCode = result.exitCode; step.output = result.output;
    } else {
        const output: string[] = [], previous = process.exitCode;
        try {
            process.exitCode = 0;
            await captureWalkOutput(output, () => handleGate(argv));
            step.exitCode = Number(process.exitCode ?? 0); step.output = output.join('\n');
        } finally { process.exitCode = previous; }
    }
    assert.equal(step.exitCode, 0, step.output);
    return true;
}

export function criteriaDoubleContext(id: string, operatorIntent: boolean): WalkScenario {
    let original: SavedPass | undefined, since = 0, builds = 0, sourceBytes: Buffer[] = [], originalScope: unknown;
    let repeatedCommand = '';
    return { ...BASE, id, edits: [...EDITS], expectedReviews: { code: 2, test: 1 },
        expectedModes: ['code:FULL', 'code:FULL', 'test:FULL'],
        expectedGates: [...operatorIntent ? [] : ['restart-coherent-cycle'], 'build-review-context', 'required-reviews-check'],
        disturbanceReason: 'R2-1/T-468 (C6.2.4): after code PASS the operator changes ' + (operatorIntent ? 'confirmed intent' : 'the TASK.md requirement')
            + '; the agent builds the same new code context twice without any intervening reviewer.',
        prepare: async (root, steps, run) => {
            const last = steps.at(-1);
            if (!steps.length) { original = undefined; builds = 0; repeatedCommand = ''; }
            if (!original && passed(last, 'record-review-result', 'code')) {
                original = savePass(root, 'code'); since = events(root).length;
                sourceBytes = EDITS.map(edit => read(root, edit.path)); originalScope = scope(root);
                if (operatorIntent) await run([...restartArgs('restart-coherent-cycle', CHANGED_INTENT), ...confirmation()]);
                else {
                    const file = path.join(root, 'TASK.md'), before = fs.readFileSync(file, 'utf8');
                    assert.equal(before.split(TITLE).length, 2, 'Exactly one task title');
                    fs.writeFileSync(file, before.replace(TITLE, CHANGED_INTENT));
                }
            }
            if (original && builds === 0 && passed(last, 'build-review-context', 'code')) {
                assertNoReuse(root, original, since, sourceBytes, originalScope);
                const current = json(root, contextFile('code')).task_criteria_binding;
                if (operatorIntent) { assert.equal(current.operator_task_intent.task_intent, CHANGED_INTENT); assert.equal(updates(root).length, 1); }
                else assert.ok(current.task_rows.some((row: { title: string }) => row.title === CHANGED_INTENT));
                builds++;
                repeatedCommand = last!.command!;
                await run(gateArgv(repeatedCommand));
                assertNoReuse(root, original, since, sourceBytes, originalScope);
                builds++;
            }
        },
        inspectResult: (root, result) => {
            assert.equal(result.outcome, 'done', result.detail);
            assert.ok(original && repeatedCommand); assert.equal(builds, 2, 'Both identical builds must be checked before a new launch');
            assertSnapshots(root, original);
            const current = json(root, receiptFile('code'));
            assert.notEqual(current.reused_existing_review, true);
            assert.ok(current.reviewer_provenance?.reviewer_launch_artifact_sha256);
            assert.notEqual(current.reviewer_provenance.reviewer_launch_artifact_sha256,
                original.receipt.reviewer_provenance.reviewer_launch_artifact_sha256, 'Changed criteria need a new launch');
            assert.notEqual(current.reviewer_provenance.event_sha256,
                original.receipt.reviewer_provenance.event_sha256, 'Changed criteria need a new authenticated invocation');
            assert.deepEqual(result.reviews.map(review => review.lane + ':' + review.mode), ['code:FULL', 'code:FULL', 'test:FULL']);
        } };
}

/** An explicit operator command is recorded in preparation, rather than offered as a navigator step. */
export function assertProtectedOperatorRestartTrace(result: Pick<WalkResult, 'steps' | 'events'>, supplement: boolean): void {
    const expectedIntent = supplement ? SUPPLEMENT : CHANGED_INTENT;
    const commands = result.steps.flatMap(step => step.preparation ?? []).map(entry => entry.command)
        .filter(command => command.startsWith('restart-coherent-cycle '));
    assert.equal(commands.length, 1, 'The operator executes the public coherent restart exactly once');
    assert.ok(commands[0].includes('--task-intent ' + expectedIntent + ' --changed-file '));
    assert.ok(commands[0].includes('--operator-confirmed yes '));
    const restarts = result.events.filter(event => event.type === 'COHERENT_CYCLE_RESTARTED');
    assert.equal(restarts.length, 1); assert.equal(restarts[0].details.status, 'PASSED');
    const intentUpdates = result.events.filter(event => event.type === 'TASK_INTENT_UPDATED');
    assert.equal(intentUpdates.length, 1);
    assert.equal(intentUpdates[0].details.task_intent, expectedIntent);
    assert.equal(intentUpdates[0].details.operator_confirmed, true);
}

export function protectedRestart(id: string, supplement: boolean, operatorControl = false): WalkScenario {
    let originals: SavedPass[] = [], originalScope: unknown, sourceBytes: Buffer[] = [], criteria = '', wording = '', disturbed = false, recovered = false;
    return { ...BASE, id, edits: [...EDITS], approveReviewRestart: true,
        // An installed application denies protected agent work by default. The modeled operator deliberately
        // authorizes this disposable maintenance fixture before agent-init freezes its installation.
        configure: root => { handleSet({ targetRoot: root, gardaSelfGuard: 'off', operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString(), json: true }); },
        expectedReviews: operatorControl ? { code: 2, test: 2 } : { code: 1, test: 1 },
        expectedModes: operatorControl ? ['code:FULL', 'test:FULL', 'code:FULL', 'test:FULL'] : ['code:FULL', 'test:FULL'],
        expectedGates: [...operatorControl ? [] : ['restart-coherent-cycle'], 'required-reviews-check'], execute: approveProtectedRestart,
        disturbanceReason: 'R2-1/protected restart (fix144-protected, C6.2.1/C6.2.4): ' + (operatorControl
            ? 'the operator explicitly confirms ' + (supplement ? 'the identical earlier agent supplement' : 'new intent') + '; all mandatory lanes repeat FULL.'
            : 'after code/test PASS' + (supplement ? ' and an agent supplement' : '') + ', lost handshake/compile evidence requires the navigator restart; criteria and PASS stay accepted.'),
        prepare: async (root, steps, run) => {
            const last = steps.at(-1);
            if (!steps.length) {
                originals = []; disturbed = false; recovered = false;
                await run(['enter-task-mode', '--task-id', TASK, '--repo-root', '.', '--provider', 'Codex',
                    '--entry-mode', 'EXPLICIT_TASK_EXECUTION', '--requested-depth', '2', '--task-summary', TITLE,
                    ...EDITS.flatMap(edit => ['--planned-changed-file', edit.path]), '--orchestrator-work', ...confirmation()]);
            }
            if (!disturbed && passed(last, 'record-review-result', 'test')) {
                originals = ['code', 'test'].map(lane => savePass(root, lane));
                criteria = originals[0].context.task_criteria_binding.sha256;
                originalScope = scope(root); sourceBytes = EDITS.map(edit => read(root, edit.path));
                assert.equal(updates(root).length, 0);
                if (supplement) {
                    await run([...restartArgs('restart-review-cycle', SUPPLEMENT), '--impact-analysis', DESCRIPTION_ANALYSIS]);
                    assert.equal(updates(root).length, 0, 'An agent supplement has no operator authority');
                }
                wording = supplement ? SUPPLEMENT : TITLE;
                if (operatorControl) {
                    // The same public path is deliberately used by an operator who states an intent.
                    await run([...restartArgs('restart-coherent-cycle', supplement ? SUPPLEMENT : CHANGED_INTENT),
                        ...confirmation(), '--review-restart-approved', 'yes', '--review-restart-approved-at-utc', new Date().toISOString()]);
                    assert.equal(updates(root).length, 1, 'Exactly one explicit operator criterion');
                    recovered = true;
                } else {
                    fs.unlinkSync(path.join(root, REVIEWS, TASK + '-handshake.json'));
                    fs.unlinkSync(path.join(root, REVIEWS, TASK + '-compile-gate.json'));
                }
                disturbed = true;
            }
            if (disturbed && !recovered && passed(last, 'restart-coherent-cycle')) {
                assert.equal(updates(root).length, 0, 'A protected navigator restart cannot promote agent wording into an operator criterion');
                assert.equal(intent(root), wording, 'The classified description survives protected re-entry');
                recovered = true;
            }
            if (recovered && passed(last, 'build-review-context')) {
                const lane = gateArgv(last!.command!)[gateArgv(last!.command!).indexOf('--review-type') + 1];
                const current = json(root, contextFile(lane)).task_criteria_binding;
                if (operatorControl) assert.notEqual(current.sha256, criteria);
                else { assert.equal(current.sha256, criteria, 'Protected re-entry keeps the criteria digest'); assert.equal(current.operator_task_intent, null); }
            }
        },
        inspectNavigation: result => {
            if (!disturbed || recovered || result.next_gate !== 'restart-coherent-cycle') return;
            assert.ok(result.commands.length, 'Lost startup evidence must offer an executable coherent restart');
            assert.ok(result.commands[0].command.includes('--operator-confirmed yes'), 'Protected re-entry still needs its confirmation');
        },
        inspectResult: (root, result) => {
            assert.equal(result.outcome, 'done', result.detail); assert.ok(disturbed && recovered);
            if (operatorControl) assertProtectedOperatorRestartTrace(result, supplement);
            assert.equal(updates(root).length, operatorControl ? 1 : 0);
            assert.deepEqual(scope(root), originalScope); assert.deepEqual(EDITS.map(edit => read(root, edit.path)), sourceBytes);
            for (const original of originals) {
                assertSnapshots(root, original);
                const current = json(root, contextFile(original.lane)).task_criteria_binding;
                if (operatorControl) assert.notEqual(current.sha256, criteria);
                else {
                    assert.equal(current.sha256, criteria);
                    const receipt = json(root, receiptFile(original.lane));
                    assert.equal(receipt.reused_existing_review, true, 'Both passed lanes must be natively reused');
                    assert.equal(receipt.review_artifact_sha256, original.receipt.review_artifact_sha256);
                    assert.equal(receipt.reused_from_review_context_sha256, original.receipt.review_context_sha256);
                }
            }
        } };
}
