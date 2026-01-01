import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TestContext } from 'node:test';
import { runGit } from '../../src/core/git-helpers';
import { writeProtectedControlPlaneManifest } from '../../src/gates/shared/helpers';
import {
    createTempRepo, initializeGitRepo, removeTempRepoWithRetry, runEnterTaskMode,
    seedInitAnswers, seedTaskQueue
} from './cli/commands/gate-test-helpers';

export function writeScopeFile(root: string, file: string, text = 'fixture\n'): void {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
}

export function scopeGitFixture(t: TestContext): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-p3-authority-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    writeScopeFile(root, 'src/app.ts', 'export const app = 1;\n');
    writeScopeFile(root, 'src/deleted.ts', 'export const deleted = 1;\n');
    writeScopeFile(root, 'src/[literal]/tracked.ts', 'export const literal = 1;\n');
    writeScopeFile(root, '.gitignore', 'src/ignored.ts\n');
    initializeGitRepo(root);
    return root;
}

export function scopeEntryFixture(t: TestContext, protectedEntry = false) {
    const root = createTempRepo();
    t.after(() => removeTempRepoWithRetry(root));
    const taskId = 'T-P3-SCOPE';
    seedInitAnswers(root);
    seedTaskQueue(root, taskId);
    writeScopeFile(root, '.gitignore', 'TASK.md\ngarda-agent-orchestrator/\n');
    writeScopeFile(root, 'package.json', JSON.stringify({ name: protectedEntry ? 'garda-agent-orchestrator' : 'p3-fixture' }));
    writeScopeFile(root, 'AGENTS.md', '# Fixture rules\n');
    writeScopeFile(root, 'src/app.ts', 'export const app = 1;\n');
    initializeGitRepo(root);
    writeProtectedControlPlaneManifest(root);
    const confirmedAt = new Date().toISOString();
    const enter = (plannedChangedFiles: string[], extra: Partial<Parameters<typeof runEnterTaskMode>[0]> = {}) => {
        const result = runEnterTaskMode({ repoRoot: root, taskId, provider: 'Codex',
            taskSummary: 'P3 scope integrity regression', plannedChangedFiles,
            orchestratorWork: protectedEntry, operatorConfirmed: 'yes', operatorConfirmedAtUtc: confirmedAt,
            emitMetrics: false, ...extra });
        assert.equal(result.exitCode, 0, result.outputLines.join('\n'));
        return result;
    };
    const artifactPath = path.join(root, 'garda-agent-orchestrator/runtime/reviews', `${taskId}-task-mode.json`);
    return { root, taskId, enter, confirmedAt, artifactPath,
        readEntry: () => JSON.parse(fs.readFileSync(artifactPath, 'utf8')),
        index: () => runGit(root, ['ls-files', '--stage', '-z']) };
}
