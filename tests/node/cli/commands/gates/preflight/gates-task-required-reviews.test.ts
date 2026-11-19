import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { runClassifyChangeCommand, runRequiredReviewsCheckCommand } from '../../../../../../src/cli/commands/gates';
import { serializeTaskPlan } from '../../../../../../src/schemas/task-plan';
import { resolveNextStep } from '../../../../../../src/gates/next-step';
import { splitCommandLine } from '../../../../../../src/core/command-line';
import { runCliWithCapturedOutput } from '../../gate-test-helpers';
import {
    captureExpectedError,
    createTempRepo,
    getReviewsRoot,
    initializeGitRepo,
    loadTaskEntryRulePack,
    runEnterTaskMode,
    runHandshakeForTask,
    runShellSmokeForTask,
    seedInitAnswers,
    seedTaskQueue
} from './gates-preflight-fixtures';

function seedBalancedProfileConfig(repoRoot: string, apiCapability: boolean, profileName = 'balanced'): void {
    const configDir = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'review-capabilities.json'), JSON.stringify({
        code: true,
        db: true,
        security: true,
        refactor: true,
        api: apiCapability,
        test: true,
        performance: true,
        infra: true,
        dependency: true
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify({
        version: 1,
        active_profile: profileName,
        built_in_profiles: {
            [profileName]: {
                description: 'Balanced',
                depth: 2,
                review_policy: {
                    code: true,
                    db: 'auto',
                    security: 'auto',
                    refactor: 'auto',
                    api: profileName === 'fast' ? false : 'auto',
                    test: 'auto',
                    performance: 'auto',
                    infra: 'auto',
                    dependency: 'auto'
                },
                token_economy: {
                    enabled: true,
                    strip_examples: true,
                    strip_code_blocks: true,
                    scoped_diffs: true,
                    compact_reviewer_output: true
                },
                skills: { auto_suggest: true }
            }
        },
        user_profiles: {}
    }, null, 2), 'utf8');
}

function prepareTask(
    repoRoot: string,
    taskId: string,
    notes: string,
    apiCapability: boolean,
    profileName = 'balanced',
    planRequiredReviews: string[] | null = null
): void {
    seedBalancedProfileConfig(repoRoot, apiCapability, profileName);
    fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'export const suite = true;\n', 'utf8');
    seedTaskQueue(
        repoRoot,
        taskId,
        'TODO',
        profileName,
        notes,
        'Add guarded local UI policy API flow'
    );
    seedInitAnswers(repoRoot);
    let planPath: string | undefined;
    if (planRequiredReviews) {
        planPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-plan.json`);
        fs.mkdirSync(path.dirname(planPath), { recursive: true });
        fs.writeFileSync(planPath, serializeTaskPlan({
            schema_version: 1,
            task_id: taskId,
            status: 'approved',
            goal: 'Add guarded local profile preview flow',
            scope_files: ['src/app.ts', 'tests/app.test.ts'],
            risk_level: 'medium',
            required_reviews: planRequiredReviews,
            steps: [{ id: 'implement', title: 'Implement the flow' }]
        }), 'utf8');
    }
    runEnterTaskMode({
        repoRoot,
        taskId,
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: 'Add guarded local profile preview flow',
        ...(planPath ? { planPath } : {})
    });
    assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
    runHandshakeForTask(repoRoot, taskId);
    runShellSmokeForTask(repoRoot, taskId);
}

describe('classify-change task required-review metadata', () => {
    for (const hasPreflight of [false, true]) {
        it(`navigator adopts an enabled task-required lane with existing preflight=${hasPreflight}`, async () => {
            const repoRoot = createTempRepo(), taskId = 'T-enable-required-api';
            try {
                prepareTask(repoRoot, taskId, hasPreflight ? 'Required reviews: code, test.'
                    : 'Required reviews: code, api, test.', false);
                initializeGitRepo(repoRoot);
                if (hasPreflight) {
                    classify(repoRoot, taskId);
                    const taskPath = path.join(repoRoot, 'TASK.md');
                    fs.writeFileSync(taskPath, fs.readFileSync(taskPath, 'utf8')
                        .replace('Required reviews: code, test.', 'Required reviews: code, api, test.'));
                }
                const refusal = resolveNextStep({ repoRoot, taskId });
                assert.equal(refusal.next_gate, 'task-metadata-validation');
                assert.match(refusal.reason, /review-capabilities enable/u);
                assert.deepEqual(refusal.commands, []);
                const skillDir = path.join(repoRoot, 'garda-agent-orchestrator/live/skills/api-review');
                fs.mkdirSync(skillDir, { recursive: true });
                fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# API review\n');
                const enabled = await runCliWithCapturedOutput(
                    ['review-capabilities', 'enable', 'api', '--target-root', repoRoot, '--json'], { cwd: repoRoot });
                assert.equal(enabled.exitCode, 0, [...enabled.logs, ...enabled.errors].join('\n'));
                const offered = resolveNextStep({ repoRoot, taskId });
                assert.equal(offered.next_gate, 'enter-task-mode', offered.reason);
                assert.equal(offered.commands.length, 1);
                const command = offered.commands[0].command;
                assert.match(command, /--adopt-changed-review-policy "[a-f0-9]{64}"/u);
                assert.match(command, /--operator-confirmed-at-utc "<ISO-8601 timestamp>"/u);
                const unapproved = await runCliWithCapturedOutput(splitCommandLine(command
                    .replace('--operator-confirmed yes', '--operator-confirmed no')
                    .replace('<ISO-8601 timestamp>', new Date().toISOString())).slice(2), { cwd: repoRoot });
                assert.notEqual(unapproved.exitCode, 0, 'the policy still needs fresh operator approval');
                const adopted = await runCliWithCapturedOutput(splitCommandLine(command
                    .replace('<ISO-8601 timestamp>', new Date().toISOString())).slice(2), { cwd: repoRoot });
                assert.equal(adopted.exitCode, 0, [...adopted.logs, ...adopted.errors].join('\n'));
                const next = resolveNextStep({ repoRoot, taskId });
                assert.notEqual(next.next_gate, 'enter-task-mode', next.reason);
                assert.notEqual(next.next_gate, 'task-metadata-validation', next.reason);
                const progress = await runCliWithCapturedOutput(splitCommandLine(next.commands[0].command).slice(2), { cwd: repoRoot });
                assert.equal(progress.exitCode, 0, [...progress.logs, ...progress.errors].join('\n'));
            } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
        });
    }

    it('navigator progresses when the operator changes the unavailable task requirement', async () => {
        const repoRoot = createTempRepo(), taskId = 'T-change-required-api';
        try {
            prepareTask(repoRoot, taskId, 'Required reviews: code, test.', false);
            initializeGitRepo(repoRoot);
            classify(repoRoot, taskId);
            const taskPath = path.join(repoRoot, 'TASK.md');
            const original = fs.readFileSync(taskPath, 'utf8');
            fs.writeFileSync(taskPath, original.replace('Required reviews: code, test.', 'Required reviews: code, api, test.'));
            const refusal = resolveNextStep({ repoRoot, taskId });
            assert.match(refusal.reason, /operator.*change.*task's required reviews/u);
            assert.deepEqual(refusal.commands, []);
            fs.writeFileSync(taskPath, original);
            const next = resolveNextStep({ repoRoot, taskId });
            assert.notEqual(next.next_gate, 'task-metadata-validation', next.reason);
            const progress = await runCliWithCapturedOutput(splitCommandLine(next.commands[0].command).slice(2), { cwd: repoRoot });
            assert.equal(progress.exitCode, 0, [...progress.logs, ...progress.errors].join('\n'));
            assert.notEqual(resolveNextStep({ repoRoot, taskId }).next_gate, 'task-metadata-validation');
        } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
    });

    for (const previouslySelected of [false, true]) {
        it(`navigator refuses an unavailable required lane with retained preflight selection=${previouslySelected}`, () => {
            const repoRoot = createTempRepo(), taskId = 'T-navigate-api-disabled';
            try {
                prepareTask(repoRoot, taskId, previouslySelected
                    ? 'Reviews: api; Required reviews: code, test.' : 'Required reviews: code, test.', true);
                initializeGitRepo(repoRoot);
                const preflight = classify(repoRoot, taskId);
                assert.equal(preflight.required_reviews.api, previouslySelected);
                seedBalancedProfileConfig(repoRoot, false);
                const taskPath = path.join(repoRoot, 'TASK.md');
                if (!previouslySelected) fs.writeFileSync(taskPath, fs.readFileSync(taskPath, 'utf8')
                    .replace('Required reviews: code, test.', 'Reviews: api; Required reviews: code, test.'));
                const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
                const retained = fs.readFileSync(preflightPath, 'utf8');
                const notes = fs.readFileSync(taskPath, 'utf8');
                for (let call = 0; call < 2; call++) {
                    const result = resolveNextStep({ repoRoot, taskId });
                    assert.equal(result.status, 'BLOCKED');
                    assert.equal(result.next_gate, 'task-metadata-validation');
                    assert.match(result.title, /unavailable required review capability/u);
                    assert.match(result.reason, /review lane 'api' is unavailable/u);
                    assert.match(result.reason, /review-capabilities enable/u);
                    assert.match(result.reason, /operator.*change.*task's required reviews/u);
                    assert.deepEqual(result.commands, [], 'do not offer a classify-change that must fail');
                }
                assert.equal(fs.readFileSync(preflightPath, 'utf8'), retained);
                assert.equal(fs.readFileSync(taskPath, 'utf8'), notes);
            } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
        });
    }

    it('navigator refreshes omitted task review lanes and progresses on the next call', async () => {
        const repoRoot = createTempRepo(), taskId = 'T-navigate-api';
        try {
            prepareTask(repoRoot, taskId, 'Required reviews: code, test.', true);
            initializeGitRepo(repoRoot);
            classify(repoRoot, taskId);
            const taskPath = path.join(repoRoot, 'TASK.md');
            fs.writeFileSync(taskPath, fs.readFileSync(taskPath, 'utf8').replace('Required reviews: code, test.',
                'Reviews: api; Required reviews: code, test.'));
            const first = resolveNextStep({ repoRoot, taskId });
            assert.equal(first.next_gate, 'task-metadata-validation');
            assert.equal(first.commands.length, 1);
            assert.match(first.commands[0].command, /gate classify-change/u);
            const recovery = await runCliWithCapturedOutput(splitCommandLine(first.commands[0].command).slice(2), { cwd: repoRoot });
            assert.equal(recovery.exitCode, 0, [...recovery.logs, ...recovery.errors].join('\n'));
            const refreshed = JSON.parse(fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`), 'utf8'));
            assert.equal(refreshed.required_reviews.api, true);
            const second = resolveNextStep({ repoRoot, taskId });
            assert.notEqual(second.next_gate, 'task-metadata-validation', second.reason);
            assert.ok(second.review.required_reviews.includes('api'));
        } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
    });

    it('native required-reviews gate refuses an old preflight that omitted a current legacy requirement', { concurrency: false }, () => {
        const repoRoot = createTempRepo(), taskId = 'T-old-preflight-api';
        try {
            prepareTask(repoRoot, taskId, 'Required reviews: code, test.', true);
            const payload = classify(repoRoot, taskId);
            assert.notEqual(payload.required_reviews.api, true);
            const taskPath = path.join(repoRoot, 'TASK.md');
            fs.writeFileSync(taskPath, fs.readFileSync(taskPath, 'utf8').replace('Required reviews: code, test.',
                'Reviews: api; Required reviews: code, test.'));
            const error = captureExpectedError(() => runRequiredReviewsCheckCommand({ repoRoot, taskId,
                preflightPath: path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`), emitMetrics: false }));
            assert.match(error.message, /preflight omits currently declared required reviews: api/u);
        } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
    });

    it('keeps legacy API requirements when a narrower canonical declaration is added', { concurrency: false }, () => {
        const repoRoot = createTempRepo(), taskId = 'T-legacy-api';
        try {
            prepareTask(repoRoot, taskId,
                'Depends on: T-previous; Reviews: security, api; Lane: B:application. Required reviews: code, security, test.', true, 'fast');
            const payload = classify(repoRoot, taskId);
            assert.deepEqual(payload.task_required_review_declaration.applied_reviews, ['security', 'api', 'code', 'test']);
            assert.equal(payload.required_reviews.api, true);
            assert.ok(payload.budget_forecast.required_reviews.includes('api'));
            assert.equal(payload.effective_review_snapshot.lanes.find((lane: Record<string, unknown>) => lane.id === 'api').selection, 'required');
        } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
    });

    it('refuses the OnlineStore legacy/canonical conflict without publishing a successful preflight', { concurrency: false }, () => {
        const repoRoot = createTempRepo(), taskId = 'T-legacy-api-disabled';
        try {
            prepareTask(repoRoot, taskId,
                'Depends on: T-previous; Reviews: security, api; Lane: B:application. Required reviews: code, security, test.', false);
            const error = captureExpectedError(() => classify(repoRoot, taskId));
            assert.match(error.message, /review-capabilities.api is not enabled/u);
            assert.match(error.message, /Do not remove or narrow/u);
            assert.equal(fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`)), false);
        } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
    });

    it('keeps an explicit API lane even when fast profile defaults disable it', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-required-api-fast';
        try {
            prepareTask(repoRoot, taskId, 'Required reviews: code, api, test.', true, 'fast');
            const result = runClassifyChangeCommand({
                repoRoot,
                taskId,
                taskIntent: 'Change local diagnostics',
                changedFiles: ['src/app.ts', 'tests/app.test.ts'],
                outputPath: path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`),
                emitMetrics: false
            });
            const payload = JSON.parse(result.outputText) as Record<string, any>;
            assert.equal(payload.required_reviews.api, true);
            const apiLane = payload.effective_review_snapshot.lanes.find((lane: Record<string, unknown>) => lane.id === 'api');
            assert.equal(apiLane.profile.state, 'disabled');
            assert.equal(apiLane.selection, 'required');
            assert.ok(payload.effective_review_snapshot.review_dependency_graph.nodes.includes('api'));
            assert.ok(payload.budget_forecast.required_reviews.includes('api'));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('keeps explicit available lanes under balanced profile policy', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-33-3-shaped';
        try {
            prepareTask(
                repoRoot,
                taskId,
                'Scope: local UI action flow. Required reviews: code, api, test. Parent guard preserved.',
                true
            );

            const result = runClassifyChangeCommand({
                repoRoot,
                taskId,
                taskIntent: 'Add guarded local profile preview flow',
                changedFiles: ['src/app.ts', 'tests/app.test.ts'],
                outputPath: path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`),
                emitMetrics: false
            });
            const payload = JSON.parse(result.outputText) as Record<string, any>;

            assert.equal(payload.triggers.api_intent, false);
            assert.deepEqual(payload.task_required_review_declaration, {
                source: 'task_queue_notes',
                declared_reviews: ['code', 'api', 'test'],
                applied_reviews: ['code', 'api', 'test']
            });
            assert.equal(payload.required_reviews.code, true);
            assert.equal(payload.required_reviews.api, true);
            assert.equal(payload.required_reviews.test, true);
            assert.equal(
                payload.profile_guardrails.decisions.find(
                    (decision: Record<string, unknown>) => decision.review_type === 'api'
                )?.decision,
                'preflight_required'
            );
            assert.deepEqual(payload.budget_forecast.required_reviews.sort(), ['api', 'code', 'test']);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('fails preflight with the unavailable lane reason instead of dropping it', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-required-api-unavailable';
        try {
            prepareTask(repoRoot, taskId, 'Required reviews: code, api, test.', false);

            const error = captureExpectedError(() => runClassifyChangeCommand({
                repoRoot,
                taskId,
                taskIntent: 'Add guarded local profile preview flow',
                changedFiles: ['src/app.ts', 'tests/app.test.ts'],
                outputPath: path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`),
                emitMetrics: false
            }));

            assert.match(
                error.message,
                /Task 'T-required-api-unavailable' required-review declaration cannot be honored: review lane 'api' is unavailable because review-capabilities\.api is not enabled\./
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
function classify(repoRoot: string, taskId: string): Record<string, any> {
        return JSON.parse(runClassifyChangeCommand({
            repoRoot,
            taskId,
            taskIntent: 'Add guarded local profile preview flow',
            changedFiles: ['src/app.ts', 'tests/app.test.ts'],
            outputPath: path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`),
            emitMetrics: false
        }).outputText) as Record<string, any>;
    }

    it('applies review lanes declared in the approved attached task plan', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-plan-required-api';
        try {
            prepareTask(repoRoot, taskId, 'Scope: local UI action flow.', true, 'balanced', ['code', 'api', 'test']);
            const payload = classify(repoRoot, taskId);
            assert.equal(payload.triggers.api_intent, false);
            assert.deepEqual(payload.task_required_review_declaration, {
                source: 'task_plan',
                declared_reviews: ['code', 'api', 'test'],
                applied_reviews: ['code', 'api', 'test']
            });
            assert.equal(payload.required_reviews.api, true);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('combines Notes and plan declarations', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-plan-and-notes-required';
        try {
            prepareTask(repoRoot, taskId, 'Required reviews: code, test.', true, 'balanced', ['api']);
            const payload = classify(repoRoot, taskId);
            assert.equal(payload.task_required_review_declaration.source, 'task_queue_notes_and_task_plan');
            assert.deepEqual(payload.task_required_review_declaration.applied_reviews, ['code', 'test', 'api']);
            for (const lane of ['code', 'test', 'api']) assert.equal(payload.required_reviews[lane], true, lane);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('fails preflight when the plan declares an unavailable lane', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-plan-required-api-unavailable';
        try {
            prepareTask(repoRoot, taskId, 'Scope: local UI action flow.', false, 'balanced', ['code', 'api']);
            const error = captureExpectedError(() => classify(repoRoot, taskId));
            assert.match(error.message, /review lane 'api' is unavailable because review-capabilities.api is not enabled./);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});

