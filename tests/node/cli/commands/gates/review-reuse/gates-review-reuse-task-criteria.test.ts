import {
    describe,
    it,
    assert,
    fs,
    path,
    runBuildReviewContextCommand,
    createTempRepo,
    getReviewsRoot,
    runEnterTaskMode,
    seedInitAnswers,
    seedReusableReviewEvidence,
    seedTaskQueue,
    writeCompilePassEvidence,
    writePreflight,
    writeReviewCapabilitiesConfig
} from './gates-review-reuse-fixtures';
import { getReviewContextContractViolations } from '../../../../../../src/gates/review-context/review-context-contract';
import { computeTaskCriteriaBinding, hasTaskCriteriaChanged } from '../../../../../../src/gates/review-context/review-context-task-criteria-binding';
import { prepareOperatorTaskIntentUpdate, recordOperatorTaskIntentUpdate } from '../../../../../../src/gates/review-context/review-context-task-intent';

const TEST_ONLY_REVIEWS = {
    code: false, db: false, security: false, refactor: false, api: false,
    test: true, performance: false, infra: false, dependency: false
};

const CODE_ONLY_REVIEWS = { ...TEST_ONLY_REVIEWS, code: true, test: false };

const PASSED_REVIEWS = {
    test: { verdict: 'TEST REVIEW PASSED', reviewer: 'agent:test-reviewer', changedFile: 'tests/app.test.ts',
        content: 'it("works", () => {});\n', requiredReviews: TEST_ONLY_REVIEWS },
    code: { verdict: 'REVIEW PASSED', reviewer: 'agent:code-reviewer', changedFile: 'src/app.ts',
        content: 'export const app = 1;\n', requiredReviews: CODE_ONLY_REVIEWS }
} as const;

/** A passed review (test by default), then a TASK.md edit, then the review context is rebuilt for the current preflight. */
async function rebuildAfterTaskQueueEdit(taskId: string, edit: (taskQueue: string) => string,
    options: { setup?: (repoRoot: string) => void; editRepo?: (repoRoot: string) => void; reviewType?: keyof typeof PASSED_REVIEWS;
        priorPreflight?: Record<string, unknown>; currentPreflight?: Record<string, unknown>; builds?: number; legacyReceipt?: boolean } = {}) {
    const reviewType = options.reviewType ?? 'test';
    const passed = PASSED_REVIEWS[reviewType];
    const repoRoot = createTempRepo();
    seedTaskQueue(repoRoot, taskId);
    options.setup?.(repoRoot);
    seedInitAnswers(repoRoot, 'Qwen');
    fs.mkdirSync(path.join(repoRoot, path.dirname(passed.changedFile)), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, passed.changedFile), passed.content, 'utf8');
    runEnterTaskMode({ repoRoot, taskId, taskSummary: 'Update app flow' });
    const priorPreflightPath = writePreflight(repoRoot, taskId, {
        changed_files: [passed.changedFile], metrics: { changed_lines_total: 3 }, required_reviews: passed.requiredReviews,
        ...options.priorPreflight
    }, `${taskId}-prior-preflight.json`);
    const reviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`);
    seedReusableReviewEvidence(repoRoot, taskId, reviewType, passed.verdict, priorPreflightPath, reviewContextPath, passed.reviewer,
        { omitTaskCriteriaBinding: options.legacyReceipt });
    const reviewedContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;

    const taskQueuePath = path.join(repoRoot, 'TASK.md');
    fs.writeFileSync(taskQueuePath, edit(fs.readFileSync(taskQueuePath, 'utf8')), 'utf8');
    options.editRepo?.(repoRoot);
    const preflightPath = writePreflight(repoRoot, taskId, {
        changed_files: [passed.changedFile], metrics: { changed_lines_total: 3 }, required_reviews: passed.requiredReviews,
        ...options.currentPreflight
    });
    writeCompilePassEvidence(repoRoot, taskId, preflightPath);
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    // The check required-reviews-check, completion-gate and next-step apply to the context the review was judged on.
    const reviewedContextViolations = getReviewContextContractViolations({
        contextPath: reviewContextPath, reviewContext: reviewedContext, expectedTaskId: taskId, expectedReviewType: reviewType,
        expectedPreflightPayload: preflight, repoRoot
    }).filter((violation) => violation.startsWith('Task criteria'));
    const builds = [];
    for (let attempt = 0; attempt < (options.builds ?? 1); attempt++) {
        builds.push(await runBuildReviewContextCommand({ reviewType, depth: '2', preflightPath, outputPath: reviewContextPath, repoRoot }));
    }
    const build = builds[0];
    const priorPreflight = JSON.parse(fs.readFileSync(priorPreflightPath, 'utf8')) as Record<string, unknown>;
    fs.rmSync(repoRoot, { recursive: true, force: true });
    return { build, builds, reviewedContext, reviewedContextViolations,
        requiredReviews: { prior: priorPreflight.required_reviews as Record<string, boolean>, current: preflight.required_reviews as Record<string, boolean> } };
}

describe('cli/commands/gates - review reuse after a task criteria change', () => {
    for (const legacyReceipt of [false, true]) for (const change of ['task row', 'operator intent'] as const) it(`R2-1: repeated context builds cannot revive a ${legacyReceipt ? 'legacy' : 'current'} PASS after changing ${change}`, async () => {
        const result = await rebuildAfterTaskQueueEdit(`T-criteria-repeat-${change === 'task row' ? 'row' : 'intent'}`,
            text => change === 'task row' ? text.replace('Update app flow', 'Update app flow and reject empty status') : text, {
                reviewType: 'code', builds: 4, legacyReceipt,
                editRepo: change === 'operator intent' ? repoRoot => {
                    const update = prepareOperatorTaskIntentUpdate({ repoRoot, taskId: 'T-criteria-repeat-intent',
                        previousIntent: 'Update app flow', taskIntent: 'Reject empty status', operatorConfirmed: 'yes' });
                    assert.ok(update);
                    recordOperatorTaskIntentUpdate(repoRoot, update);
                } : undefined
            });
        assert.equal(result.reviewedContextViolations.length, 1);
        for (const [attempt, built] of result.builds.entries()) {
            assert.equal(built.reusedReviewEvidence, false, `Build ${attempt + 1}: ${built.outputLines.join('\n')}`);
            assert.doesNotMatch(built.outputLines.join('\n'), /ReviewReuseDecision: accepted|CurrentPassReviewEvidence: True/u);
        }
    });
    it('invalidates the recorded criteria when attached plan bytes change, even if entry metadata is unchanged', async () => {
        const taskId = 'T-criteria-plan';
        const planPath = (repoRoot: string) => path.join(getReviewsRoot(repoRoot), `${taskId}-task-plan.json`);
        const result = await rebuildAfterTaskQueueEdit(taskId, text => text, {
            setup: repoRoot => {
                fs.mkdirSync(path.dirname(planPath(repoRoot)), { recursive: true });
                fs.writeFileSync(planPath(repoRoot), JSON.stringify({ schema_version: 1, task_id: taskId, status: 'approved',
                    goal: 'Update app flow', scope_files: ['tests/app.test.ts'], risk_level: 'low',
                    acceptance_criteria: ['Reject empty status'], steps: [{ id: 'S1', title: 'Check status' }] }));
            },
            editRepo: repoRoot => {
                const before = computeTaskCriteriaBinding({ repoRoot, taskId, preflight: { task_intent: 'Update app flow' } });
                assert.ok(before.task_plan);
                fs.writeFileSync(planPath(repoRoot), fs.readFileSync(planPath(repoRoot), 'utf8').replace('Reject empty status', 'Accept empty status'));
                const after = computeTaskCriteriaBinding({ repoRoot, taskId, preflight: { task_intent: 'Update app flow' } });
                assert.equal(hasTaskCriteriaChanged(before, after), true);
            }
        });
        assert.equal(result.build.reusedReviewEvidence, false, result.build.outputLines.join('\n'));
        assert.equal(result.reviewedContextViolations.length, 1);
        assert.match(result.reviewedContextViolations[0], /Every review repeats in FULL/u);
    });
    it('rejects reuse when an exact-output criterion gains a meaningful space', async () => {
        const result = await rebuildAfterTaskQueueEdit('T-criteria-literal-space', text => text.replace('hello world', 'hello  world'), {
            setup: repoRoot => {
                const queue = path.join(repoRoot, 'TASK.md');
                fs.writeFileSync(queue, fs.readFileSync(queue, 'utf8').replace('| fixture |', '| Output exactly `hello world`. |'));
            }
        });
        assert.equal(result.build.reusedReviewEvidence, false, result.build.outputLines.join('\n'));
        assert.doesNotMatch(result.build.outputLines.join('\n'), /ReviewReuseDecision: accepted|CurrentPassReviewEvidence: True/u);
        assert.equal(result.reviewedContextViolations.length, 1);
    });
    it('keeps the passed review when the task criteria are unchanged', async () => {
        const result = await rebuildAfterTaskQueueEdit('T-criteria-unchanged', (text) => text);
        assert.equal(result.build.reusedReviewEvidence, true, result.build.outputLines.join('\n'));
        assert.deepEqual(result.reviewedContextViolations, []);
        assert.match(String((result.reviewedContext.task_criteria_binding as Record<string, unknown>).sha256), /^[a-f0-9]{64}$/u);
    });

    it('keeps legacy receipt evidence with unchanged criteria through repeated context builds', async () => {
        const result = await rebuildAfterTaskQueueEdit('T-criteria-legacy-unchanged', text => text, { legacyReceipt: true, builds: 4 });
        for (const built of result.builds) assert.equal(built.reusedReviewEvidence, true, built.outputLines.join('\n'));
        assert.deepEqual(result.reviewedContextViolations, []);
    });

    it('keeps the passed review when another task row in TASK.md changes', async () => {
        const result = await rebuildAfterTaskQueueEdit('T-criteria-other-row', (text) =>
            text + '\n| T-other | TODO | P2 | docs | Rewrite the unrelated guide | unassigned | 2026-11-04 | default | other task |\n');
        assert.equal(result.build.reusedReviewEvidence, true, result.build.outputLines.join('\n'));
        assert.deepEqual(result.reviewedContextViolations, []);
    });

    it('keeps the passed review for line-ending and padding changes of the task row', async () => {
        const result = await rebuildAfterTaskQueueEdit('T-criteria-whitespace', (text) =>
            text.replace(/\n/gu, '\r\n').replace('| Update app flow |', '|   Update app flow   |'));
        assert.equal(result.build.reusedReviewEvidence, true, result.build.outputLines.join('\n'));
        assert.deepEqual(result.reviewedContextViolations, []);
    });

    it('repeats the review when the task row criteria change', async () => {
        const result = await rebuildAfterTaskQueueEdit('T-criteria-changed', (text) =>
            text.replace('Update app flow', 'Update app flow and reject empty status'));
        assert.equal(result.build.reusedReviewEvidence, false, result.build.outputLines.join('\n'));
        assert.equal(result.reviewedContextViolations.length, 1);
        assert.match(result.reviewedContextViolations[0], /Every review repeats in FULL/u);
    });

    it('repeats the review when only the case of the task criteria changes', async () => {
        const result = await rebuildAfterTaskQueueEdit('T-criteria-case', (text) => text.replace('| fixture |', '| FIXTURE |'));
        assert.equal(result.build.reusedReviewEvidence, false, result.build.outputLines.join('\n'));
        assert.equal(result.reviewedContextViolations.length, 1);
    });

    it('keeps the passed review when another task\'s operator decision changes', async () => {
        const decisions = '\n\n## Operator Decisions\n\n- T-criteria-other-decision operator decision (2026-11-01): Keep the API.\n'
            + '- T-other operator decision (2026-11-01): Accept the old format.\n';
        const result = await rebuildAfterTaskQueueEdit('T-criteria-other-decision',
            (text) => text.replace('Accept the old format.', 'Reject the old format.'),
            { setup: (repoRoot) => fs.appendFileSync(path.join(repoRoot, 'TASK.md'), decisions) });
        assert.equal(result.build.reusedReviewEvidence, true, result.build.outputLines.join('\n'));
        assert.deepEqual(result.reviewedContextViolations, []);
    });

    it('repeats the review when this task gets a new operator decision', async () => {
        const result = await rebuildAfterTaskQueueEdit('T-criteria-own-decision',
            (text) => text + '- T-criteria-own-decision operator decision (2026-11-03): Also reject an empty status.\n',
            { setup: (repoRoot) => fs.appendFileSync(path.join(repoRoot, 'TASK.md'),
                '\n\n## Operator Decisions\n\n- T-criteria-own-decision operator decision (2026-11-01): Keep the API.\n') });
        assert.equal(result.build.reusedReviewEvidence, false, result.build.outputLines.join('\n'));
        assert.equal(result.reviewedContextViolations.length, 1);
        assert.match(result.reviewedContextViolations[0], /Every review repeats in FULL/u);
    });
});

/** A task whose TASK.md row links a task card; the card is edited after the passed review. */
function withCard(taskId: string, card: string[]) {
    const cardPath = (repoRoot: string) => path.join(repoRoot, 'docs', 'cards.md');
    return {
        setup: (repoRoot: string) => {
            fs.mkdirSync(path.dirname(cardPath(repoRoot)), { recursive: true });
            fs.writeFileSync(cardPath(repoRoot), ['# Cards', '', `## ${taskId}`, '', ...card, '', '## T-next', '', 'Other card.', ''].join('\n'), 'utf8');
            const queue = path.join(repoRoot, 'TASK.md');
            fs.writeFileSync(queue, fs.readFileSync(queue, 'utf8')
                .replace('| fixture |', `| [${taskId}](docs/cards.md#${taskId.toLowerCase()}) fixture |`), 'utf8');
        },
        editCard: (change: (text: string) => string) => (repoRoot: string) =>
            fs.writeFileSync(cardPath(repoRoot), change(fs.readFileSync(cardPath(repoRoot), 'utf8')), 'utf8')
    };
}

describe('cli/commands/gates - review reuse after a linked task-card change', () => {
    it('repeats the review when numbered card criteria change', async () => {
        const card = withCard('T-card-numbered', ['### Acceptance criteria', '', '1. Parser accepts JSON', '2. Errors exit 2']);
        const result = await rebuildAfterTaskQueueEdit('T-card-numbered', (text) => text, {
            setup: card.setup, editRepo: card.editCard((text) => text.replace('accepts JSON', 'accepts YAML').replace('exit 2', 'exit 0'))
        });
        assert.equal(result.build.reusedReviewEvidence, false, result.build.outputLines.join('\n'));
        assert.equal(result.reviewedContextViolations.length, 1);
        assert.match(result.reviewedContextViolations[0], /Every review repeats in FULL/u);
    });

    it('repeats the review when prose card criteria change', async () => {
        const card = withCard('T-card-prose', ['The parser accepts JSON and exits 2 on errors.']);
        const result = await rebuildAfterTaskQueueEdit('T-card-prose', (text) => text, {
            setup: card.setup, editRepo: card.editCard((text) => text.replace('exits 2', 'exits 0'))
        });
        assert.equal(result.build.reusedReviewEvidence, false, result.build.outputLines.join('\n'));
        assert.equal(result.reviewedContextViolations.length, 1);
    });

    it('keeps the passed review for whitespace-only card edits and edits of another card', async () => {
        const card = withCard('T-card-whitespace', ['### Acceptance criteria', '', '1. Parser accepts JSON', '2. Errors exit 2']);
        const result = await rebuildAfterTaskQueueEdit('T-card-whitespace', (text) => text, {
            setup: card.setup,
            editRepo: card.editCard((text) => text.replace('1. Parser accepts JSON', '1. Parser accepts JSON  ')
                .replace('Other card.', 'Another task changed its card.').replace(/\n/gu, '\r\n'))
        });
        assert.equal(result.build.reusedReviewEvidence, true, result.build.outputLines.join('\n'));
        assert.deepEqual(result.reviewedContextViolations, []);
        assert.notEqual((result.reviewedContext.task_criteria_binding as Record<string, unknown>).task_card, null);
    });
});

describe('cli/commands/gates - review reuse after an approved review-lane policy change', () => {
    // The changed scope already triggers these lanes; only the operator's lane enablement changes between the preflights.
    // Task ids and the seeded intent avoid lane keywords, so no lane is required by intent alone.
    const LANE_TRIGGERS = { api: true, performance: true, refactor: true };
    const capabilities = (overrides: Record<string, boolean>) => (repoRoot: string) => { writeReviewCapabilitiesConfig(repoRoot, overrides); };
    const lanePreflight = (lanes: Record<string, boolean>) => ({ triggers: LANE_TRIGGERS, required_reviews: { ...CODE_ONLY_REVIEWS, ...lanes } });
    for (const [index, lane] of (['api', 'performance', 'refactor'] as const).entries()) {
        it(`keeps the passed code review when the ${lane} lane is enabled for an unchanged scope`, async () => {
            const result = await rebuildAfterTaskQueueEdit(`T-lane-${index}-enabled`, (text) => text, {
                reviewType: 'code', setup: capabilities({ [lane]: false }), editRepo: capabilities({}),
                priorPreflight: lanePreflight({}), currentPreflight: lanePreflight({ [lane]: true })
            });
            assert.deepEqual([result.requiredReviews.prior[lane], result.requiredReviews.current[lane]], [false, true],
                'precondition: only the lane enablement changed');
            assert.equal(result.build.reusedReviewEvidence, true, result.build.outputLines.join('\n'));
            assert.deepEqual(result.reviewedContextViolations, []);
        });
    }

    it('keeps the passed code review when an enabled lane is disabled', async () => {
        const result = await rebuildAfterTaskQueueEdit('T-lane-disabled', (text) => text, {
            reviewType: 'code', setup: capabilities({}), editRepo: capabilities({ api: false }),
            priorPreflight: lanePreflight({ api: true }), currentPreflight: lanePreflight({})
        });
        assert.deepEqual([result.requiredReviews.prior.api, result.requiredReviews.current.api], [true, false]);
        assert.equal(result.build.reusedReviewEvidence, true, result.build.outputLines.join('\n'));
        assert.deepEqual(result.reviewedContextViolations, []);
    });

    it('still repeats the review when the scope gains a lane trigger', async () => {
        const result = await rebuildAfterTaskQueueEdit('T-lane-triggered', (text) => text, {
            reviewType: 'code', priorPreflight: { ...lanePreflight({}), triggers: { ...LANE_TRIGGERS, api: false } },
            currentPreflight: lanePreflight({ api: true })
        });
        assert.equal(result.build.reusedReviewEvidence, false, result.build.outputLines.join('\n'));
        assert.equal(result.reviewedContextViolations.length, 1);
        assert.match(result.reviewedContextViolations[0], /Every review repeats in FULL/u);
    });

    it('still repeats the review when the requirements text changes together with the lane', async () => {
        const result = await rebuildAfterTaskQueueEdit('T-lane-and-criteria', (text) =>
            text.replace('Update app flow', 'Update app flow and reject empty status'), {
            reviewType: 'code', setup: capabilities({ api: false }), editRepo: capabilities({}),
            priorPreflight: lanePreflight({}), currentPreflight: lanePreflight({ api: true })
        });
        assert.equal(result.build.reusedReviewEvidence, false, result.build.outputLines.join('\n'));
        assert.equal(result.reviewedContextViolations.length, 1);
        assert.match(result.reviewedContextViolations[0], /Every review repeats in FULL/u);
    });
});
