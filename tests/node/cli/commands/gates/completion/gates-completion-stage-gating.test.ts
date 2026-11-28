import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeBudgetOutputFilters, writeReceiptBackedReviewArtifact } from '../../gate-test-helpers';
import {
    buildCurrentReviewCycleCaseResolutions,
    prepareCurrentReviewCycleValidation,
    TRUST_BOUNDARY_FIXTURE_EVIDENCE_PATH,
    writeCurrentReviewCycleValidationSource
} from '../review-cycle/gates-review-cycle-fixtures';

import {
    runClassifyChangeCommand,
    runCompileGateCommand,
    runDocImpactGateCommand,
    runLoadRulePackCommand
} from '../../../../../../src/cli/commands/gates';
import { runCompletionGate } from '../../../../../../src/gates/completion';
import { appendTaskEvent } from '../../../../../../src/gate-runtime/task-events';
import { splitCommandLine } from '../../../../../../src/core/command-line';
import { resolveNextStep } from '../../../../gates/next-step/next-step-test-support';
import { runCliWithCapturedOutput } from '../../gate-test-cli-capture';
import { buildSharedStartTaskWorkflowContent } from '../../../../../../src/materialization/content-builders';
import { writeProtectedControlPlaneManifest } from '../../../../../../src/gates/shared/helpers';

const taskEvents = require('../../../../../../src/gate-runtime/timeline/task-events-io') as
    typeof import('../../../../../../src/gate-runtime/timeline/task-events-io');
const rulePackTimeline = require('../../../../../../src/gates/rule-pack/rule-pack-timeline') as
    typeof import('../../../../../../src/gates/rule-pack/rule-pack-timeline');

import {
    createTempRepo,
    escapeRegExp,
    getOrchestratorRoot,
    getReviewsRoot,
    initializeGitRepo,
    loadTaskEntryRulePack,
    loadPostPreflightRulePack,
    readTaskQueueStatusFromTaskFile,
    runRequiredReviewsCheckCommand,
    runEnterTaskMode,
    runHandshakeForTask,
    runShellSmokeForTask,
    seedInitAnswers,
    seedTaskQueue,
    writeCleanReviewArtifact,
    writeCompilePassEvidence,
    writePreflight
} from './gates-completion-fixtures';

describe('cli/commands/gates', () => {
    for (const variant of ['standard', 'legacy', 'custom'] as const) test({
        standard: 'passes completion gate only after task mode entry, review gate, and doc impact gate',
        legacy: 'upgrades a reviewed task with digestless rules, reruns startup through the navigator, and completes',
        custom: 'keeps a reloaded custom rule pack through navigator compile, required reviews and completion'
    }[variant], async t => {
        const repoRoot = createTempRepo();
        t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
        const taskId = 'T-903a';
        const customRulePackPath = 'garda-agent-orchestrator/runtime/reviews/custom rules for T-903a.json';
        const rulePackPath = variant === 'custom' ? customRulePackPath : undefined;
        const navigate = () => resolveNextStep({ repoRoot, taskId });
        const readRouteGate = (gate: string) => {
            const route = navigate();
            assert.equal(route.next_gate, gate, route.reason);
            const command = route.commands[0];
            assert.ok(command, route.reason);
            const argv = splitCommandLine(command.command.slice(command.command.indexOf(`gate ${gate}`)));
            return { argv, command };
        };
        const runRouteGate = async (gate: string) => {
            const { argv } = readRouteGate(gate);
            const result = await runCliWithCapturedOutput(argv, { cwd: repoRoot });
            assert.equal(result.exitCode, 0, [...result.logs, ...result.errors].join('\n'));
        };
        const assertCustomRoute = (gate: string) => {
            const { argv, command } = readRouteGate(gate);
            assert.ok(argv.includes('--rule-pack-path'), command.command);
            assert.equal(argv[argv.indexOf('--rule-pack-path') + 1], customRulePackPath);
            return argv;
        };
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = variant === 'standard' ? writePreflight(repoRoot, taskId)
            : path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
        const commandsPath = path.join(repoRoot, 'commands.md');
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');
        if (variant !== 'standard') {
            const bundle = getOrchestratorRoot(repoRoot);
            fs.mkdirSync(path.join(bundle, 'bin'), { recursive: true });
            fs.writeFileSync(path.join(bundle, 'bin/garda.js'),
                `require(${JSON.stringify(path.join(process.cwd(), '.node-build/src/cli/main.js'))})`
                + `.runCliMainWithHandling(process.argv.slice(2), ${JSON.stringify(process.cwd())});\n`);
            fs.writeFileSync(path.join(bundle, 'VERSION'), fs.readFileSync('VERSION'));
            fs.mkdirSync(path.join(bundle, 'live/skills/code-review'), { recursive: true });
            fs.writeFileSync(path.join(bundle, 'live/skills/code-review/SKILL.md'), '# code-review fixture\n');
            fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# Codex fixture\n');
            fs.mkdirSync(path.join(repoRoot, '.agents/workflows'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, '.agents/workflows/start-task.md'), buildSharedStartTaskWorkflowContent('AGENTS.md'));
            fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n');
            writeProtectedControlPlaneManifest(repoRoot);
        }

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Update app flow'
        });
        const rules = ['00-core.md', '15-project-memory.md', '40-commands.md', '80-task-workflow.md', '90-skill-catalog.md'];
        const append = taskEvents.appendMandatoryTaskEvent;
        const compare = rulePackTimeline.compareRulePackStageWithEvent;
        if (variant === 'legacy') {
            // Seed the pre-upgrade history through the ordinary gates with the original rule-pack format.
            t.mock.method(taskEvents, 'appendMandatoryTaskEvent', (
                ...args: Parameters<typeof append>
            ) => {
                if (args[2] === 'RULE_PACK_LOADED') {
                    const { stage_sha256: _omitted, ...legacyDetails } = args[5] as Record<string, unknown>;
                    args[5] = legacyDetails;
                }
                return append(...args);
            });
            t.mock.method(rulePackTimeline, 'compareRulePackStageWithEvent', (...args: Parameters<typeof compare>) => {
                const result = compare(...args);
                return result.recorded === null ? { ...result, matches: true } : result;
            });
        }
        if (rulePackPath) {
            const loaded = runLoadRulePackCommand({ repoRoot, taskId, stage: 'TASK_ENTRY', artifactPath: rulePackPath,
                loadedRuleFiles: rules, emitMetrics: false });
            assert.equal(loaded.exitCode, 0, loaded.outputLines.join('\n'));
        } else {
            loadTaskEntryRulePack(repoRoot, taskId);
        }
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        if (variant !== 'standard') {
            fs.appendFileSync(path.join(repoRoot, 'src/app.ts'), '\nexport const changed = 1;\n');
            runClassifyChangeCommand({ repoRoot, taskId, taskIntent: 'Update app flow', changedFiles: ['src/app.ts'],
                rulePackPath, outputPath: preflightPath, emitMetrics: false });
            assert.ok(fs.existsSync(preflightPath));
        }
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath, variant === 'standard', rulePackPath, '',
            { synchronizeScope: variant === 'standard' });
        if (rulePackPath) {
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'RULE_PACK_LOADED', 'PASS', 'Legacy POST_PREFLIGHT rules.', {
                stage: 'POST_PREFLIGHT', artifact_path: path.resolve(repoRoot, rulePackPath).replace(/\\/gu, '/'),
                preflight_path: preflightPath.replace(/\\/gu, '/')
            }, { actor: 'gate' });
            await runRouteGate('load-rule-pack');
            assertCustomRoute('compile-gate');
        }

        const compile = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            rulePackPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compile.exitCode, 0, compile.outputLines.join('\n'));

        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_PHASE_STARTED',
            'INFO',
            'Review phase started.',
            { review_type: 'code' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_SELECTED',
            'INFO',
            'Skill selected: code-review',
            { skill_id: 'code-review', trigger_reason: 'required_review' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_REFERENCE_LOADED',
            'INFO',
            'Reference loaded: garda-agent-orchestrator/live/skills/code-review/SKILL.md',
            {
                skill_id: 'code-review',
                reference_path: 'garda-agent-orchestrator/live/skills/code-review/SKILL.md',
                trigger_reason: 'review_skill'
            }
        );

        if (variant === 'standard') {
            writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');
        } else {
            writeReceiptBackedReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED', undefined, {
                authenticatedNavigatorLaunch: true, skipReceipt: true, caseResolutions: {}
            });
            const launchPath = path.join(getOrchestratorRoot(repoRoot), 'runtime/tmp/reviews', taskId, 'code/reviewer-launch.json');
            const launch = JSON.parse(fs.readFileSync(launchPath, 'utf8')) as { review_output_path: string; reviewer_identity: string };
            const outputPath = path.resolve(repoRoot, launch.review_output_path);
            fs.copyFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-code.md`), outputPath);
            const recorded = await runCliWithCapturedOutput(['gate', 'record-review-result', '--task-id', taskId, '--review-type', 'code',
                '--preflight-path', preflightPath, '--review-context-path', path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`),
                '--review-output-path', outputPath, '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', launch.reviewer_identity, '--repo-root', repoRoot], { cwd: repoRoot });
            assert.equal(recorded.exitCode, 0, [...recorded.logs, ...recorded.errors].join('\n'));
        }
        if (rulePackPath) assertCustomRoute('required-reviews-check');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            rulePackPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, reviewResult.outputLines.join('\n'));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Internal cleanup only, no public behavior change.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        if (variant === 'legacy') {
            t.mock.reset();
            await runRouteGate('load-rule-pack');
            loadPostPreflightRulePack(repoRoot, taskId, preflightPath, false, '', '', { synchronizeScope: false });
            const stale = runCompletionGate({ repoRoot, preflightPath, taskId });
            assert.equal(stale.outcome, 'FAIL');
            assert.match(stale.violations.join('\n'), /predates the latest RULE_PACK_LOADED for TASK_ENTRY/u);
            await runRouteGate('handshake-diagnostics');
            await runRouteGate('shell-smoke-preflight');
            await runRouteGate('completion-gate');
            assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');
            return;
        }
        if (rulePackPath) assertCustomRoute('completion-gate');
        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            rulePackPath,
            taskId
        });
        assert.equal(completionResult.outcome, 'PASS');
        assert.equal(completionResult.status, 'PASSED');
        assert.match(String(completionResult.task_mode_path || ''), /T-903a-task-mode\.json$/);
        // Verify stage_sequence_evidence is present.
        assert.ok(completionResult.stage_sequence_evidence);
        assert.equal(completionResult.stage_sequence_evidence.code_changed, true);
        assert.ok(completionResult.stage_sequence_evidence.observed_order.includes('PREFLIGHT_CLASSIFIED'));
        assert.ok(completionResult.stage_sequence_evidence.observed_order.includes('IMPLEMENTATION_STARTED'));
        assert.ok(completionResult.stage_sequence_evidence.observed_order.includes('REVIEW_PHASE_STARTED'));
        assert.ok(completionResult.stage_sequence_evidence.observed_order.includes('REVIEW_RECORDED'));
        assert.deepEqual(completionResult.stage_sequence_evidence.review_skill_ids, ['code-review']);
        assert.equal(completionResult.stage_sequence_evidence.review_skill_reference_paths.length, 1);
        assert.equal(completionResult.stage_sequence_evidence.violations.length, 0);

    });

    test('passes completion gate when a later coherent cycle exists despite stale early task-entry ordering noise', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-recovery';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const commandsPath = path.join(repoRoot, 'commands-completion-recovery.md');
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Record stale early startup ordering noise'
        });
        runHandshakeForTask(repoRoot, taskId);
        loadTaskEntryRulePack(repoRoot, taskId);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Recover a later coherent completion cycle'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = writePreflight(repoRoot, taskId, {
            metrics: { changed_lines_total: 3, changed_files_count: 1 },
            changed_files: ['src/app.ts'],
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_PHASE_STARTED',
            'INFO',
            'Review phase started.',
            { review_type: 'code' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_SELECTED',
            'INFO',
            'Skill selected: code-review',
            { skill_id: 'code-review', trigger_reason: 'required_review' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_REFERENCE_LOADED',
            'INFO',
            'Reference loaded: garda-agent-orchestrator/live/skills/code-review/SKILL.md',
            {
                skill_id: 'code-review',
                reference_path: 'garda-agent-orchestrator/live/skills/code-review/SKILL.md',
                trigger_reason: 'review_skill'
            }
        );

        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, reviewResult.outputLines.join('\n'));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Internal lifecycle recovery only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.outcome, 'PASS');
        assert.equal(completionResult.status, 'PASSED');
        assert.equal(completionResult.stage_sequence_evidence.violations.length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('fails completion gate when the latest cycle is misordered and would need compile backfill from an older cycle', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-recovery-negative';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId, {
            metrics: { changed_lines_total: 3, changed_files_count: 1 },
            changed_files: ['src/app.ts'],
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        const commandsPath = path.join(repoRoot, 'commands-completion-recovery-negative.md');
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject cross-cycle compile backfill in completion gate'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_PHASE_STARTED',
            'INFO',
            'Initial review phase started.',
            { review_type: 'code' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_SELECTED',
            'INFO',
            'Skill selected: code-review',
            { skill_id: 'code-review', trigger_reason: 'required_review' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_REFERENCE_LOADED',
            'INFO',
            'Reference loaded: garda-agent-orchestrator/live/skills/code-review/SKILL.md',
            {
                skill_id: 'code-review',
                reference_path: 'garda-agent-orchestrator/live/skills/code-review/SKILL.md',
                trigger_reason: 'review_skill'
            }
        );

        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const firstReviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(firstReviewResult.exitCode, 0);

        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'PREFLIGHT_CLASSIFIED',
            'INFO',
            'New preflight started for a later cycle.',
            { mode: 'FULL_PATH', changed_files_count: 1, changed_lines_total: 3, required_reviews: { code: true } }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'IMPLEMENTATION_STARTED',
            'INFO',
            'Implementation started for later cycle.',
            {}
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_PHASE_STARTED',
            'INFO',
            'Review phase started too early for later cycle.',
            { review_type: 'code' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'COMPILE_GATE_PASSED',
            'PASS',
            'Compile gate passed too late in later cycle.',
            {}
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_GATE_PASSED',
            'PASS',
            'Later review gate appeared to pass.',
            {}
        );

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.outcome, 'FAIL');
        assert.ok(completionResult.stage_sequence_evidence.violations.some((item) => item.includes("Do not backfill 'COMPILE_GATE_PASSED' from an older execution cycle.")));
        const restartCommand = String((completionResult as Record<string, unknown>).coherent_cycle_restart_command || '');
        assert.match(restartCommand, /restart-coherent-cycle/);
        assert.match(restartCommand, new RegExp(escapeRegExp(taskId)));
        assert.match(restartCommand, new RegExp(escapeRegExp(outputFiltersPath.replace(/\\/g, '/'))));
        assert.ok(restartCommand.includes(`--task-intent 'Seed reusable review evidence for ${taskId}'`), restartCommand);
        assert.ok(!restartCommand.includes("--task-intent 'Recover a later coherent completion cycle'"), restartCommand);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('protected completion coherent-cycle recovery command includes operator placeholders', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-protected-recovery-command';
        fs.writeFileSync(
            path.join(repoRoot, 'package.json'),
            JSON.stringify({ name: 'garda-agent-orchestrator' }, null, 2),
            'utf8'
        );
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'src', 'gates', 'completion'), { recursive: true });
        fs.writeFileSync(
            path.join(repoRoot, 'src', 'gates', 'completion', 'completion.ts'),
            'export const protectedCompletionFixture = true;\n',
            'utf8'
        );
        fs.mkdirSync(path.dirname(path.join(repoRoot, TRUST_BOUNDARY_FIXTURE_EVIDENCE_PATH)), { recursive: true });
        writeCurrentReviewCycleValidationSource(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId, {
            metrics: { changed_lines_total: 3, changed_files_count: 1 },
            changed_files: ['src/gates/completion/completion.ts'],
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Protected recovery command needs operator placeholders',
            plannedChangedFiles: ['src/gates/completion/completion.ts'],
            orchestratorWork: true,
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString()
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        await prepareCurrentReviewCycleValidation(repoRoot, taskId, preflightPath);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_PHASE_STARTED',
            'INFO',
            'Review phase started.',
            { review_type: 'code' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_SELECTED',
            'INFO',
            'Skill selected: code-review',
            { skill_id: 'code-review', trigger_reason: 'required_review' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_REFERENCE_LOADED',
            'INFO',
            'Reference loaded: garda-agent-orchestrator/live/skills/code-review/SKILL.md',
            {
                skill_id: 'code-review',
                reference_path: 'garda-agent-orchestrator/live/skills/code-review/SKILL.md',
                trigger_reason: 'review_skill'
            }
        );
        writeReceiptBackedReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED', undefined, {
            caseResolutions: buildCurrentReviewCycleCaseResolutions(repoRoot, taskId)
        });
        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, reviewResult.outputLines.join('\n'));
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'PREFLIGHT_CLASSIFIED',
            'INFO',
            'New preflight started for a later protected cycle.',
            { mode: 'FULL_PATH', changed_files_count: 1, changed_lines_total: 3, required_reviews: { code: true } }
        );

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        const command = String((completionResult as Record<string, unknown>).coherent_cycle_restart_command || '');

        assert.equal(completionResult.outcome, 'FAIL');
        assert.match(command, /restart-coherent-cycle/);
        assert.match(command, /--operator-confirmed yes/);
        assert.match(command, /--operator-confirmed-at-utc '<ISO-8601 timestamp>'/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('fails completion gate when the latest cycle has review evidence but no same-cycle implementation or compile', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-recovery-missing-prereq';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId, {
            metrics: { changed_lines_total: 3, changed_files_count: 1 },
            changed_files: ['src/app.ts'],
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        const commandsPath = path.join(repoRoot, 'commands-completion-recovery-missing-prereq.md');
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject missing same-cycle compile backfill in completion gate'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_PHASE_STARTED',
            'INFO',
            'Initial review phase started.',
            { review_type: 'code' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_SELECTED',
            'INFO',
            'Skill selected: code-review',
            { skill_id: 'code-review', trigger_reason: 'required_review' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_REFERENCE_LOADED',
            'INFO',
            'Reference loaded: garda-agent-orchestrator/live/skills/code-review/SKILL.md',
            {
                skill_id: 'code-review',
                reference_path: 'garda-agent-orchestrator/live/skills/code-review/SKILL.md',
                trigger_reason: 'review_skill'
            }
        );

        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const firstReviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(firstReviewResult.exitCode, 0);

        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'PREFLIGHT_CLASSIFIED',
            'INFO',
            'New preflight started for a later cycle.',
            { mode: 'FULL_PATH', changed_files_count: 1, changed_lines_total: 3, required_reviews: { code: true } }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_PHASE_STARTED',
            'INFO',
            'Later review phase started without same-cycle implementation or compile.',
            { review_type: 'code' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_RECORDED',
            'PASS',
            'Later review recorded.',
            { review_type: 'code' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_GATE_PASSED',
            'PASS',
            'Later review gate appeared to pass.',
            {}
        );

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.outcome, 'FAIL');
        assert.ok(completionResult.stage_sequence_evidence.violations.some((item) => item.includes("Do not backfill 'IMPLEMENTATION_STARTED' from an older execution cycle.")));
        assert.ok(completionResult.stage_sequence_evidence.violations.some((item) => item.includes("Do not backfill 'COMPILE_GATE_PASSED' from an older execution cycle.")));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('completion-gate rejects stale task-mode artifacts after review pass when runtime identity metadata is removed', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-task-mode-identity-missing-at-completion';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject completion when pinned task-mode identity metadata is removed after review pass',
            provider: 'Codex',
            routedTo: 'AGENTS.md'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, JSON.stringify(reviewResult, null, 2));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Runtime identity regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const taskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const tamperedTaskMode = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
        delete tamperedTaskMode.canonical_source_of_truth;
        delete tamperedTaskMode.execution_provider_source;
        delete tamperedTaskMode.runtime_identity_status;
        fs.writeFileSync(taskModePath, JSON.stringify(tamperedTaskMode, null, 2) + '\n', 'utf8');

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.status, 'FAILED', JSON.stringify(completionResult, null, 2));
        assert.equal(completionResult.outcome, 'FAIL');
        assert.ok(completionResult.violations.some((entry) => entry.includes('missing canonical_source_of_truth')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('completion-gate fails when workspace canonical ownership drifts after task-mode identity was pinned', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-completion-runtime-identity-drift';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Fail completion when workspace canonical SourceOfTruth drifts after task-mode entry',
            provider: 'Antigravity',
            routedTo: '.antigravity/agents/orchestrator.md'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, JSON.stringify(reviewResult, null, 2));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Runtime identity drift regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        seedInitAnswers(repoRoot, 'Qwen');

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.status, 'FAILED', JSON.stringify(completionResult, null, 2));
        assert.equal(completionResult.outcome, 'FAIL');
        assert.ok(completionResult.violations.some((entry) => entry.includes('contradicts task-mode canonical_source_of_truth')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
