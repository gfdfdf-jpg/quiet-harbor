import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WalkScenario } from './navigator-walk';

/**
 * Field T-212 (2026-11-25): a formal single-cycle decision ("about six files") grew to nine files; child rows were hand-added.
 * Field shop T-014-2 (Garda 1.4.4): the decision was first demanded after the code was written, at the preflight refresh.
 * Sol review (round 2): a split recorded after implementation dead-ended between WIP suspension and materialization.
 */
export const T212_FIELD_CASE_IDS = ['field-t212-decomposition-estimate-exceeded', 'field-t212-materialized-decomposition-children',
    'field-t014-2-decision-before-implementation', 'field-t212-late-split-materialize'] as const;

const TASK = 'T-WALK';
const BUNDLE = 'garda-agent-orchestrator';
const EDITS = [{ path: 'src/app.ts', append: '// decomposition field case\n' }, { path: 'tests/app.test.ts', append: '// decomposition field case\n' }];
const LANES = ['code', 'security', 'performance', 'test'];

function readTaskSummary(root: string): string {
    const taskMode = JSON.parse(fs.readFileSync(path.join(root, BUNDLE, 'runtime/reviews', TASK + '-task-mode.json'), 'utf8')) as { task_summary?: string };
    assert.ok(taskMode.task_summary, 'Native task mode records the task summary the decision binds');
    return taskMode.task_summary;
}

/**
 * The approved notes cap the task at two files. The agent records single-cycle with an estimate of two before coding,
 * then the implementation changes a third file. next-step must route back to the decision instead of continuing to
 * compile and reviews; the hand-off names the estimate, the cap and the split.
 */
function estimateExceededScenario(): WalkScenario {
    let decided = false;
    return {
        id: T212_FIELD_CASE_IDS[0], profile: 'strict', expectedReviews: {}, expectedModes: [],
        edits: [...EDITS, { path: 'docs/guide.md', append: 'Status renderer notes.\n' }],
        disturbanceReason: 'T-212: a single-cycle decision estimated at the planned file cap; the implementation then changes more files.',
        taskNotes: 'Synthetic navigator walk. Scope, at most two files.',
        expectedBlockedGate: 'record-strict-decomposition-decision',
        expectedGuidance: /changes 3 files, more than the recorded estimate of 2 and the planned file cap of 2.*can only split/su,
        prepare: async (root, steps, run) => {
            if (decided || steps.at(-1)?.gate !== 'enter-task-mode' || steps.at(-1)?.exitCode !== 0) return;
            await run(['record-strict-decomposition-decision', '--task-id', TASK, '--task-profile', 'strict',
                '--decision', 'single-cycle', '--task-summary', readTaskSummary(root),
                '--reason', 'One renderer contract and its regression fit one review cycle.',
                '--scope-risk', 'The approved notes cap the task at two files.',
                ...LANES.flatMap(lane => ['--expected-review-type', lane]),
                '--atomicity-constraint', 'none', '--estimated-changed-files', '2', '--repo-root', '.']);
            decided = true;
        },
        inspectResult: (root) => {
            const decision = JSON.parse(fs.readFileSync(path.join(root, BUNDLE, 'runtime/reviews', TASK + '-strict-decomposition-decision.json'), 'utf8'));
            assert.equal(decision.estimated_changed_files, 2);
            assert.equal(decision.task_plan.file_cap, 2);
        }
    };
}

/**
 * The split decided before implementation routes to the offered materialize command; the agent runs it from the
 * --execute-effects result, Garda writes the rows and the parent becomes DECOMPOSED.
 */
function materializedChildrenScenario(): WalkScenario {
    let materialized = false;
    return {
        id: T212_FIELD_CASE_IDS[1], profile: 'strict', expectedReviews: {}, expectedModes: [], edits: EDITS,
        expectedTerminalStatus: 'DECOMPOSED', expectedBlockedGate: 'child-task', expectedGuidance: /next unfinished child/iu,
        disturbanceReason: 'T-212: the child rows of an authenticated split were added to TASK.md by hand.',
        prepare: async (root, steps, run) => {
            const last = steps.at(-1);
            if (last?.effectResult?.gate === 'strict-decomposition-split-routing' && !materialized) {
                assert.match(last.effectResult.reason, /The materialize command adds them and the parent provenance note/u);
                await run(['materialize-decomposition-children', '--task-id', TASK, '--repo-root', '.']);
                materialized = true;
                return;
            }
            if (last?.gate !== 'enter-task-mode' || last.exitCode !== 0
                || fs.existsSync(path.join(root, BUNDLE, 'runtime/reviews', TASK + '-strict-decomposition-decision.json'))) return;
            const contract = BUNDLE + '/runtime/tmp/walk-field-work-packages.json';
            fs.mkdirSync(path.join(root, path.dirname(contract)), { recursive: true });
            fs.writeFileSync(path.join(root, contract), JSON.stringify({ schema_version: 1, finding_obligations: [],
                work_packages: [1, 2].map(id => ({ task_id: TASK + '-' + id, profile: 'strict',
                    root_cause_area: 'status-part-' + id, objective: 'Implement independent status behavior part ' + id,
                    scope_obligations: ['Preserve status part ' + id], validation_contract: ['Test status part ' + id],
                    finding_obligation_ids: [], required_review_types: LANES })) }));
            await run(['record-strict-decomposition-decision', '--task-id', TASK, '--task-profile', 'strict',
                '--decision', 'split-required', '--task-summary', readTaskSummary(root),
                '--reason', 'Two independent status contracts require separately executable changes.',
                '--scope-risk', 'Independent source and test obligations require code and test review.',
                ...LANES.flatMap(lane => ['--expected-review-type', lane]), '--atomicity-constraint', 'none',
                '--work-package-contract-path', contract, '--repo-root', '.']);
        },
        inspectResult: (root) => {
            const queue = fs.readFileSync(path.join(root, 'TASK.md'), 'utf8');
            assert.match(queue, /Decomposition source: orchestrator \(\d{4}-\d{2}-\d{2}\); child range `T-WALK-1` through `T-WALK-2`; execute sequentially\./u);
            for (const id of [1, 2]) assert.match(queue, new RegExp('\\| T-WALK-' + id + ' \\| [^|]*TODO \\|[^\\n]*Required reviews: ' + LANES.join(', ') + '\\. \\|', 'u'));
            assert.match(fs.readFileSync(path.join(root, BUNDLE, 'runtime/task-events', TASK + '.jsonl'), 'utf8'), /DECOMPOSITION_CHILDREN_MATERIALIZED/u);
        }
    };
}

function writeWorkPackageContract(root: string): string {
    const contract = BUNDLE + '/runtime/tmp/walk-field-work-packages.json';
    fs.mkdirSync(path.join(root, path.dirname(contract)), { recursive: true });
    fs.writeFileSync(path.join(root, contract), JSON.stringify({ schema_version: 1, finding_obligations: [],
        work_packages: [1, 2].map(id => ({ task_id: TASK + '-' + id, profile: 'strict',
            root_cause_area: 'status-part-' + id, objective: 'Implement independent status behavior part ' + id,
            scope_obligations: ['Preserve status part ' + id], validation_contract: ['Test status part ' + id],
            finding_obligation_ids: [], required_review_types: LANES })) }));
    return contract;
}

/**
 * The split is recorded only after the implementation: next-step captures and suspends the parent WIP, offers the
 * materialize command, and after it the parent is DECOMPOSED with the first child next. No step dead-ends.
 * Sol round 3: the agent edits the parent again after the suspension; next-step recaptures that edit, keeping the
 * first capture, before the materialize command can link the children.
 */
function lateSplitScenario(): WalkScenario {
    let decided = false, reedited = false, materialized = false;
    return {
        id: T212_FIELD_CASE_IDS[3], profile: 'strict', expectedReviews: {}, expectedModes: [], edits: EDITS,
        expectedTerminalStatus: 'DECOMPOSED', expectedBlockedGate: 'child-task', expectedGuidance: /next unfinished child/iu,
        disturbanceReason: 'Sol round 2: a split-required decision recorded after implementation must reach the child rows.',
        prepare: async (root, steps, run) => {
            const last = steps.at(-1);
            if (decided && !materialized && last?.effectResult?.gate === 'strict-decomposition-split-routing') {
                assert.match(last.effectResult.reason, /The materialize command adds them and the parent provenance note/u);
                if (!reedited) {
                    fs.appendFileSync(path.join(root, 'src/app.ts'), '// parent edit after the suspension\n');
                    reedited = true;
                    return;
                }
                await run(['materialize-decomposition-children', '--task-id', TASK, '--repo-root', '.']);
                materialized = true;
                return;
            }
            if (decided || last?.gate !== 'load-rule-pack' || last.exitCode !== 0 || !steps.some(step => step.gate === 'implementation')) return;
            await run(['record-strict-decomposition-decision', '--task-id', TASK, '--task-profile', 'strict',
                '--decision', 'split-required', '--task-summary', readTaskSummary(root),
                '--reason', 'Two independent status contracts require separately executable changes.',
                '--scope-risk', 'Independent source and test obligations require code and test review.',
                ...LANES.flatMap(lane => ['--expected-review-type', lane]), '--atomicity-constraint', 'none',
                '--work-package-contract-path', writeWorkPackageContract(root), '--repo-root', '.']);
            decided = true;
        },
        inspectResult: (root, result) => {
            assert.ok(result.steps.some(step => step.effectResult?.gate === 'strict-decomposition-split-routing'),
                'next-step suspends the implemented WIP before it offers the materialize command');
            const queue = fs.readFileSync(path.join(root, 'TASK.md'), 'utf8');
            for (const id of [1, 2]) assert.match(queue, new RegExp('\\| T-WALK-' + id + ' \\| [^|]*TODO \\|', 'u'));
            const events = fs.readFileSync(path.join(root, BUNDLE, 'runtime/task-events', TASK + '.jsonl'), 'utf8');
            assert.match(events, /SPLIT_REQUIRED_WIP_CAPTURED[\s\S]*SPLIT_REQUIRED_WIP_CAPTURED[\s\S]*DECOMPOSITION_CHILDREN_MATERIALIZED/u,
                'The edit after the suspension is captured a second time before the children are linked');
        }
    };
}

/** Notes that plan sub-cards make next-step ask for the decision before the first preflight and before any code is written. */
function decisionBeforeImplementationScenario(): WalkScenario {
    return {
        id: T212_FIELD_CASE_IDS[2], profile: 'strict', expectedReviews: {}, expectedModes: [], edits: EDITS,
        disturbanceReason: 'T-014-2: the decomposition decision was demanded only at the preflight refresh after implementation.',
        taskNotes: 'Synthetic navigator walk. Run its sub-cards in order, one task each.',
        expectedBlockedGate: 'record-strict-decomposition-decision', expectedGuidance: /task_plan:sub-cards.*--estimated-changed-files/su,
        inspectResult: (root, result) => {
            // The notes plan alone asks for the decision, so it comes before the first preflight and before any code.
            assert.ok(!result.steps.some(step => step.gate === 'implementation' || step.gate === 'classify-change'), 'The decision comes first');
            assert.doesNotMatch(fs.readFileSync(path.join(root, 'src/app.ts'), 'utf8'), /decomposition field case/u);
        }
    };
}

export function decompositionFieldScenario(id: typeof T212_FIELD_CASE_IDS[number]): WalkScenario {
    if (id === T212_FIELD_CASE_IDS[0]) return estimateExceededScenario();
    if (id === T212_FIELD_CASE_IDS[3]) return lateSplitScenario();
    return id === T212_FIELD_CASE_IDS[1] ? materializedChildrenScenario() : decisionBeforeImplementationScenario();
}
