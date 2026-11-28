import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DEFAULT_BUNDLE_NAME } from '../../../../src/core/constants';
import { PROJECT_MEMORY_REQUIRED_FILE_NAMES } from '../../../../src/core/project-memory';
import { splitCommandLine } from '../../../../src/core/command-line';
import { handleSetup } from '../../../../src/cli/commands/setup';
import { runAgentInit } from '../../../../src/lifecycle/agent-init';
import { resolveNextStep } from '../../../../src/gates/next-step';
import { UPDATE_CHECK_OPT_OUT_ENV } from '../../../../src/lifecycle/update-availability/update-availability-types';
import { initializeGitRepo, runGit } from './gate-test-helpers';
import { runCliWithCapturedOutput } from './gate-test-cli-capture';

export const TASK_ID = 'T-COMPOSITE-1';
export const OTHER_TASK_ID = 'T-COMPOSITE-2';
export const TASK_TITLE = 'Exercise composite startup through the real navigator';
export const PROVIDER_ARGS = ['--provider', 'Codex', '--routed-to', 'AGENTS.md'];

/** One initialized template per suite; every case works on its own disposable copy. */
export interface CompositeFixture {
    clone(): string;
    dispose(): void;
}

function findRepoRoot(): string {
    let dir = __dirname;
    while (dir !== path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, 'VERSION')) && fs.existsSync(path.join(dir, 'template'))) return dir;
        dir = path.dirname(dir);
    }
    throw new Error('Cannot find repo root');
}

function writeTextFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

async function quiet<T>(action: () => Promise<T>): Promise<T> {
    const originalLog = console.log;
    console.log = () => undefined;
    try { return await action(); } finally { console.log = originalLog; }
}

async function createTemplate(): Promise<string> {
    const sourceRoot = findRepoRoot();
    const packageJson = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-composite-template-'));
    const bundleRoot = path.join(root, DEFAULT_BUNDLE_NAME);
    runGit(root, ['init']);
    writeTextFile(path.join(bundleRoot, 'runtime', 'init-answers.json'), `${JSON.stringify({
        AssistantLanguage: 'English', AssistantBrevity: 'concise', SourceOfTruth: 'Codex', EnforceNoAutoCommit: 'false',
        ClaudeOrchestratorFullAccess: 'false', TokenEconomyEnabled: 'true', ProviderMinimalism: 'false',
        CollectedVia: 'CLI_NONINTERACTIVE', ActiveAgentFiles: 'AGENTS.md'
    }, null, 2)}\n`);
    await quiet(() => handleSetup(
        ['--target-root', root, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--source-of-truth', 'Codex'],
        packageJson, sourceRoot));
    writeTextFile(path.join(root, 'package.json'), `${JSON.stringify({ name: 'composite-fixture', private: true }, null, 2)}\n`);
    writeTextFile(path.join(root, 'src', 'app.ts'), 'export const status = "ready";\n');
    writeTextFile(path.join(root, 'scripts', 'build-check.cjs'), 'console.log("build ok");\n');
    const commandsPath = path.join(bundleRoot, 'live', 'docs', 'agent-rules', '40-commands.md');
    fs.writeFileSync(commandsPath, fs.readFileSync(commandsPath, 'utf8')
        .replace(/<[a-z][a-z -]* command>/gu, 'node scripts/build-check.cjs'), 'utf8');
    for (const fileName of PROJECT_MEMORY_REQUIRED_FILE_NAMES) {
        writeTextFile(path.join(bundleRoot, 'live', 'docs', 'project-memory', fileName), `# ${fileName}\n\nComposite fixture memory.\n`);
    }
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, Record<string, unknown>>;
    config.compile_gate.command = 'node scripts/build-check.cjs';
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')) as {
        built_in_profiles: Record<string, { task_decomposition?: { enabled?: boolean } }>;
    };
    profiles.built_in_profiles.balanced.task_decomposition = { enabled: false };
    fs.writeFileSync(profilesPath, `${JSON.stringify(profiles, null, 2)}\n`, 'utf8');
    const init = runAgentInit({
        targetRoot: root, activeAgentFiles: 'AGENTS.md', projectRulesUpdated: 'yes', skillsPrompted: 'yes',
        ordinaryDocPaths: 'CHANGELOG.md', verifyRunner: () => ({ passed: true }), manifestRunner: () => ({ passed: true })
    });
    assert.equal(init.readyForTasks, true, JSON.stringify(init.state, null, 2));
    fs.writeFileSync(path.join(root, 'TASK.md'), [
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${TASK_ID} | 🟦 TODO | P1 | testing/composite | ${TASK_TITLE} | fixture | 2026-11-15 | balanced | Composite fixture. |`,
        `| ${OTHER_TASK_ID} | 🟦 TODO | P1 | testing/composite | Second composite fixture task | fixture | 2026-11-15 | balanced | Composite fixture. |`,
        ''
    ].join('\n'), 'utf8');
    initializeGitRepo(root);
    return root;
}

/**
 * Installed runtime code that no composite case writes: about 3,000 of the template's 3,300 files and 45 of its
 * 50 MB. A clone hard-links these files instead of copying them, so each one stays a regular file inside the clone
 * (same real path, same bytes, same hashes) at a fraction of the copy cost. Every other file, including all of
 * `live/`, `runtime/`, `.git/`, TASK.md and the project sources, is copied, so cases may change them freely.
 * A case must never write to a linked file: that would change the template and every later clone.
 */
const LINKED_BUNDLE_DIRECTORIES: readonly string[] = ['bin', 'dist', 'docs', 'src', 'template']
    .map((directory) => path.join(DEFAULT_BUNDLE_NAME, directory));

function cloneTree(sourceRoot: string, targetRoot: string): void {
    const visit = (relativeDirectory: string, linked: boolean): void => {
        fs.mkdirSync(path.join(targetRoot, relativeDirectory), { recursive: true });
        for (const entry of fs.readdirSync(path.join(sourceRoot, relativeDirectory), { withFileTypes: true })) {
            const relativePath = path.join(relativeDirectory, entry.name);
            const source = path.join(sourceRoot, relativePath);
            const target = path.join(targetRoot, relativePath);
            if (entry.isDirectory()) {
                visit(relativePath, linked || LINKED_BUNDLE_DIRECTORIES.includes(relativePath));
            } else if (linked) {
                try {
                    fs.linkSync(source, target);
                } catch {
                    fs.copyFileSync(source, target);
                }
            } else {
                fs.copyFileSync(source, target);
            }
        }
    };
    visit('', false);
}

export async function createCompositeFixture(): Promise<CompositeFixture> {
    const previousUpdateCheck = process.env[UPDATE_CHECK_OPT_OUT_ENV];
    process.env[UPDATE_CHECK_OPT_OUT_ENV] = '0';
    const templateRoot = await createTemplate();
    const workspaces: string[] = [];
    return {
        clone(): string {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-composite-'));
            cloneTree(templateRoot, root);
            workspaces.push(root);
            return root;
        },
        dispose(): void {
            if (previousUpdateCheck === undefined) delete process.env[UPDATE_CHECK_OPT_OUT_ENV];
            else process.env[UPDATE_CHECK_OPT_OUT_ENV] = previousUpdateCheck;
            for (const root of [templateRoot, ...workspaces]) fs.rmSync(root, { recursive: true, force: true });
        }
    };
}

export function timelineEvents(repoRoot: string, taskId = TASK_ID): string[] {
    const timelinePath = path.join(repoRoot, DEFAULT_BUNDLE_NAME, 'runtime', 'task-events', `${taskId}.jsonl`);
    if (!fs.existsSync(timelinePath)) return [];
    return fs.readFileSync(timelinePath, 'utf8').split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as { event_type: string; outcome: string })
        .map((event) => `${event.event_type}:${event.outcome}`);
}

export function countEvents(repoRoot: string, eventType: string): number {
    return timelineEvents(repoRoot).filter((entry) => entry.startsWith(`${eventType}:`)).length;
}

export async function cli(repoRoot: string, argv: string[]): Promise<{ exitCode: number; text: string }> {
    const result = await runCliWithCapturedOutput(argv, { cwd: repoRoot });
    return { exitCode: result.exitCode, text: [...result.logs, ...result.errors].join('\n') };
}

/** Runs the single command the navigator prints, the way an agent would, from its gate argument onward. */
export async function runPrintedCommand(repoRoot: string, expectedGate: string, replacements: Record<string, string> = {}): Promise<void> {
    const next = resolveNextStep({ taskId: TASK_ID, repoRoot });
    assert.equal(next.next_gate, expectedGate, next.reason);
    assert.equal(next.commands.length, 1);
    const argv = splitCommandLine(next.commands[0].command);
    const gateArgv = argv.slice(argv.indexOf('gate'));
    for (const [flag, value] of Object.entries(replacements)) {
        const index = gateArgv.indexOf(flag);
        if (index >= 0) gateArgv[index + 1] = value;
        else gateArgv.push(flag, value);
    }
    const result = await cli(repoRoot, gateArgv);
    assert.equal(result.exitCode, 0, `${expectedGate} failed:\n${result.text}`);
}

export function writeTaskEdit(repoRoot: string): void {
    fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const done = "done";\n', 'utf8');
}

