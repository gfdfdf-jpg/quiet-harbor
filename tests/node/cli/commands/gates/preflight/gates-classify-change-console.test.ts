import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { runCliWithCapturedOutput } from '../../gate-test-helpers';
import {
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
import { formatClassifyChangeConsoleOutput } from '../../../../../../src/cli/commands/gates';

const TASK_ID = 'T-931';
const TASK_INTENT = 'Spread a small feature over many files';
// The size the console summary must stay under for a task-sized change (token-audit target).
const SUMMARY_CHAR_LIMIT = 1500;

function changedFileList(): string[] {
    const files: string[] = [];
    for (let index = 1; index <= 10; index += 1) files.push(`src/feature/module-${index}.ts`);
    for (let index = 1; index <= 4; index += 1) files.push(`tests/feature/module-${index}.test.ts`);
    files.push('docs/feature.md', 'README.md');
    return files;
}

/**
 * Enter task mode, then commit empty placeholders so git sees the 16 planned files as edited
 * (the same order the preflight suite uses for explicit-scope classification).
 */
function prepareSixteenFileTask(repoRoot: string): string[] {
    const files = changedFileList();
    seedTaskQueue(repoRoot, TASK_ID);
    seedInitAnswers(repoRoot);
    runEnterTaskMode({ repoRoot, taskId: TASK_ID, requestedDepth: 2, effectiveDepth: 2, taskSummary: TASK_INTENT });
    assert.equal(loadTaskEntryRulePack(repoRoot, TASK_ID).exitCode, 0);
    runHandshakeForTask(repoRoot, TASK_ID);
    runShellSmokeForTask(repoRoot, TASK_ID);
    for (const file of files) {
        fs.mkdirSync(path.dirname(path.join(repoRoot, file)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, file), '', 'utf8');
    }
    initializeGitRepo(repoRoot);
    for (const file of files) {
        fs.writeFileSync(path.join(repoRoot, file), `export const value = '${file}';\n`, 'utf8');
    }
    return files;
}

function classifyArgv(repoRoot: string, files: string[], outputPath: string, extra: string[] = []): string[] {
    return [
        'gate', 'classify-change', '--repo-root', repoRoot, '--task-id', TASK_ID, '--task-intent', TASK_INTENT,
        ...files.flatMap((file) => ['--changed-file', file]), '--output-path', outputPath, '--emit-metrics', 'false',
        ...extra
    ];
}

function sha256(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

describe('cli/commands/gates — classify-change console output', () => {
    it('prints a short summary that names the preflight artifact, and the full JSON with --as-json', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const files = prepareSixteenFileTask(repoRoot);
        const outputPath = path.join(getReviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);

        const summaryRun = await runCliWithCapturedOutput(classifyArgv(repoRoot, files, outputPath), { cwd: repoRoot });
        assert.equal(summaryRun.exitCode, 0, [...summaryRun.logs, ...summaryRun.errors].join('\n'));
        const summary = summaryRun.logs.join('\n');
        const artifact = JSON.parse(fs.readFileSync(outputPath, 'utf8')) as Record<string, unknown>;
        assert.ok(summary.length <= SUMMARY_CHAR_LIMIT, `summary is ${summary.length} chars:\n${summary}`);
        assert.ok(fs.readFileSync(outputPath, 'utf8').length > summary.length * 4, 'the summary replaces a much larger JSON');
        assert.match(summary, /^CLASSIFY_CHANGE_PASSED$/mu);
        assert.match(summary, new RegExp(`^Task: ${TASK_ID}$`, 'mu'));
        assert.match(summary, new RegExp(`^Mode: ${String(artifact.mode)}$`, 'mu'));
        assert.match(summary, new RegExp(`^ScopeCategory: ${String(artifact.scope_category)}\\b`, 'mu'));
        assert.match(summary, /^ChangedFiles: 16$/mu);
        const requiredReviews = Object.entries(artifact.required_reviews as Record<string, boolean>)
            .filter(([, required]) => required).map(([id]) => id);
        assert.ok(requiredReviews.length > 0, 'the fixture change requires reviews');
        assert.match(summary, new RegExp(`^RequiredReviews: ${requiredReviews.join(', ')}$`, 'mu'));
        assert.match(summary, new RegExp(`^PreflightPath: ${outputPath.replace(/\\/gu, '/').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'mu'));
        assert.match(summary, new RegExp(`^PreflightSha256: ${sha256(outputPath)}$`, 'mu'));
        assert.doesNotMatch(summary, /"triggers"|"metrics"|"changed_files"/u, 'the summary does not echo the JSON');

        const jsonRun = await runCliWithCapturedOutput(classifyArgv(repoRoot, files, outputPath, ['--as-json']), { cwd: repoRoot });
        assert.equal(jsonRun.exitCode, 0, [...jsonRun.logs, ...jsonRun.errors].join('\n'));
        const printed = JSON.parse(jsonRun.logs.join('\n')) as Record<string, unknown>;
        assert.deepEqual(printed, JSON.parse(fs.readFileSync(outputPath, 'utf8')), '--as-json prints the published preflight');
        assert.equal((printed.changed_files as string[]).length, 16);
    });

    it('keeps the full JSON on the console when no preflight artifact is written', () => {
        const outputText = `${JSON.stringify({ mode: 'FULL_PATH', changed_files: ['src/app.ts'] }, null, 2)}\n`;
        assert.equal(formatClassifyChangeConsoleOutput(outputText, null), outputText);
        assert.equal(formatClassifyChangeConsoleOutput(outputText, path.join(createTempRepo(), 'missing.json')), outputText);
    });

    it('repeats every warning the agent acts on, bounded, and points at the artifact for the rest', () => {
        const repoRoot = createTempRepo();
        const artifactPath = path.join(repoRoot, 'preflight.json');
        const warnings = Array.from({ length: 7 }, (_, index) => `Hygiene warning ${index + 1}.`);
        const outputText = `${JSON.stringify({
            mode: 'FULL_PATH', scope_category: 'code', scope_category_reasons: ['code=1'], changed_files: ['src/app.ts'],
            required_reviews: { code: true, test: false },
            isolation_mode_violation: 'Isolation mode violation.',
            triggers: { isolation_mode_pre_task_warning: 'Isolation mode violation.' },
            workspace_hygiene_warnings: warnings,
            zero_diff_guard: { status: 'BASELINE_ONLY', completion_requires_audited_no_op: true }
        }, null, 2)}\n`;
        fs.writeFileSync(artifactPath, outputText, 'utf8');
        const summary = formatClassifyChangeConsoleOutput(outputText, artifactPath);
        assert.match(summary, /^RequiredReviews: code$/mu);
        assert.match(summary, /^ZeroDiff: BASELINE_ONLY \(completion requires an audited no-op\)$/mu);
        assert.equal(summary.match(/^Warning: Isolation mode violation\.$/gmu)?.length, 1, 'duplicate warnings print once');
        assert.match(summary, /^Warning: Hygiene warning 4\.$/mu);
        assert.doesNotMatch(summary, /Hygiene warning 5\./u);
        assert.match(summary, /^Warning: 3 more warning\(s\) are recorded in the preflight artifact\.$/mu);
        assert.match(summary, new RegExp(`^PreflightSha256: ${sha256(artifactPath)}$`, 'mu'));
    });
});
