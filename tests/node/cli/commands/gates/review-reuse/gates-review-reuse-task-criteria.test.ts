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
    writePreflight
} from './gates-review-reuse-fixtures';
import { getReviewContextContractViolations } from '../../../../../../src/gates/review-context/review-context-contract';

const TEST_ONLY_REVIEWS = {
    code: false, db: false, security: false, refactor: false, api: false,
    test: true, performance: false, infra: false, dependency: false
};

/** A passed test review, then a TASK.md edit, then the review context is rebuilt for the current preflight. */
async function rebuildAfterTaskQueueEdit(taskId: string, edit: (taskQueue: string) => string,
    options: { setup?: (repoRoot: string) => void; editRepo?: (repoRoot: string) => void } = {}) {
    const repoRoot = createTempRepo();
    seedTaskQueue(repoRoot, taskId);
    options.setup?.(repoRoot);
    seedInitAnswers(repoRoot, 'Qwen');
    fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
    runEnterTaskMode({ repoRoot, taskId, taskSummary: 'Update app flow' });
    const priorPreflightPath = writePreflight(repoRoot, taskId, {
        changed_files: ['tests/app.test.ts'], metrics: { changed_lines_total: 3 }, required_reviews: TEST_ONLY_REVIEWS
    }, `${taskId}-prior-preflight.json`);
    const reviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-test-review-context.json`);
    seedReusableReviewEvidence(repoRoot, taskId, 'test', 'TEST REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:test-reviewer');
    const reviewedContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;

    const taskQueuePath = path.join(repoRoot, 'TASK.md');
    fs.writeFileSync(taskQueuePath, edit(fs.readFileSync(taskQueuePath, 'utf8')), 'utf8');
    options.editRepo?.(repoRoot);
    const preflightPath = writePreflight(repoRoot, taskId, {
        changed_files: ['tests/app.test.ts'], metrics: { changed_lines_total: 3 }, required_reviews: TEST_ONLY_REVIEWS
    });
    writeCompilePassEvidence(repoRoot, taskId, preflightPath);
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    // The check required-reviews-check, completion-gate and next-step apply to the context the review was judged on.
    const reviewedContextViolations = getReviewContextContractViolations({
        contextPath: reviewContextPath, reviewContext: reviewedContext, expectedTaskId: taskId, expectedReviewType: 'test',
        expectedPreflightPayload: preflight, repoRoot
    }).filter((violation) => violation.startsWith('Task criteria'));
    const build = await runBuildReviewContextCommand({ reviewType: 'test', depth: '2', preflightPath, outputPath: reviewContextPath, repoRoot });
    fs.rmSync(repoRoot, { recursive: true, force: true });
    return { build, reviewedContext, reviewedContextViolations };
}

describe('cli/commands/gates - review reuse after a task criteria change', () => {
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
