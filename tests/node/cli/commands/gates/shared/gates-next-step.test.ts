import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    runCliMainWithHandling
} from '../../../../../../src/cli/main';
import {
    createTempRepo,
    runCliWithCapturedOutput
} from '../../gate-test-helpers';

async function runCliWithStdoutCapture(
    argv: readonly string[],
    options: { cwd?: string } = {}
): Promise<{ exitCode: number; stdout: string; errors: string[] }> {
    const previousExitCode = process.exitCode;
    const previousCwd = process.cwd();
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalConsoleError = console.error;
    let stdout = '';
    const errors: string[] = [];
    process.exitCode = 0;
    process.stdout.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
        stdout += typeof chunk === 'string' ? chunk : chunk.toString();
        const resolvedCallback = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
        if (resolvedCallback) {
            resolvedCallback();
        }
        return true;
    }) as typeof process.stdout.write;
    console.error = (...args: unknown[]) => {
        errors.push(args.map((value) => String(value)).join(' '));
    };
    try {
        process.chdir(path.resolve(options.cwd || '.'));
        await runCliMainWithHandling(Array.from(argv));
        return {
            exitCode: process.exitCode ?? 0,
            stdout,
            errors
        };
    } finally {
        process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
        console.error = originalConsoleError;
        process.chdir(previousCwd);
        process.exitCode = previousExitCode;
    }
}

describe('cli/commands/gates next-step', () => {
    it('prints dedicated help for the next-step gate', async () => {
        const result = await runCliWithCapturedOutput(['gate', 'next-step', '--help'], {
            cwd: path.join(path.resolve('.'), 'src', 'cli')
        });

        assert.equal(result.exitCode, 0);
        assert.equal(result.errors.length, 0);
        const output = result.logs.join('\n');
        assert.ok(output.includes('gate next-step'));
        assert.ok(output.includes('next-step "<task-id>"'));
        assert.ok(output.includes('--task-id "<task-id>"'));
        assert.ok(output.includes('--preflight-path'));
        assert.ok(output.includes('--as-json'));
        assert.ok(output.includes('--events-root'));
        assert.ok(output.includes('--reviews-root'));
        assert.ok(output.includes('review launchable batch'));
        assert.ok(output.includes('blocked lanes'));
        assert.ok(output.includes('legacy NextReview compatibility'));
    });

    it('prints JSON next-step output from the public gate command', async () => {
        const repoRoot = createTempRepo();
        try {
            const configDir = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(
                path.join(configDir, 'workflow-config.json'),
                JSON.stringify({
                    full_suite_validation: {
                        enabled: true,
                        command: 'npm test'
                    },
                    review_execution_policy: {
                        mode: 'code_first_optional'
                    }
                }, null, 2),
                'utf8'
            );

            const result = await runCliWithStdoutCapture([
                'gate',
                'next-step',
                '--task-id',
                'T-CLI-NEXT',
                '--as-json',
                '--repo-root',
                '.'
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0);
            assert.equal(result.errors.length, 0);
            const payload = JSON.parse(result.stdout) as Record<string, unknown>;
            assert.equal(payload.task_id, 'T-CLI-NEXT');
            assert.equal(payload.next_gate, 'enter-task-mode');
            const fullSuite = payload.full_suite_validation as Record<string, unknown>;
            assert.equal(fullSuite.enabled, true);
            // Before the task selects its tests, the shared project command is not offered as the task's command.
            assert.equal(fullSuite.command, '');
            assert.equal(fullSuite.config_source, 'project_command_reference');
            assert.doesNotMatch(JSON.stringify(payload), /npm test/u);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('prints human-readable next-step output from the public gate command', async () => {
        const repoRoot = createTempRepo();
        try {
            const result = await runCliWithStdoutCapture([
                'gate',
                'next-step',
                '--task-id',
                'T-CLI-HUMAN',
                '--repo-root',
                '.'
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0);
            assert.equal(result.errors.length, 0);
            assert.ok(result.stdout.startsWith('GARDA_NEXT_STEP\nTask: T-CLI-HUMAN\nStatus: BLOCKED\nNextGate: enter-task-mode\nNext: '));
            assert.ok(result.stdout.includes('\nReason: '));
            assert.ok(result.stdout.includes('\nRequiredReviews: '));
            // The one stated action is the composite start; the gate command is only in --verbose and JSON.
            assert.match(result.stdout, /^Start the task: node garda-agent-orchestrator\/bin\/garda\.js task "T-CLI-HUMAN" start --provider /mu);
            assert.match(result.stdout, /^Single step: --verbose\.$/mu);
            assert.doesNotMatch(result.stdout, /gate enter-task-mode|^Commands/mu);
            assert.ok(result.stdout.includes('\nNavigator: '));
            assert.ok(result.stdout.includes('\nDetails: rerun with --verbose for the full text or --as-json for structured output.\n'));
            assert.doesNotMatch(result.stdout, /^(?:Next action:|Loop:|TaskTestValidation:)/mu);

            const verbose = await runCliWithStdoutCapture(['gate', 'next-step', '--task-id', 'T-CLI-HUMAN', '--verbose', '--repo-root', '.'], { cwd: repoRoot });
            assert.equal(verbose.exitCode, 0);
            assert.ok(verbose.stdout.startsWith('Next action:\n'));
            assert.ok(verbose.stdout.includes('GARDA_NEXT_STEP'));
            assert.ok(verbose.stdout.includes('Loop: run the Navigator first and after each command or failure; run its recommended composite when offered, otherwise its single-step command (choose exactly one alternative).'));
            assert.ok(verbose.stdout.includes('NextGate: enter-task-mode'));
            assert.ok(verbose.stdout.includes('TaskTestValidation:'));
            assert.ok(verbose.stdout.includes('Single-step alternative:\n  Enter task mode: node garda-agent-orchestrator/bin/garda.js gate enter-task-mode '));
            assert.ok(verbose.stdout.length > result.stdout.length);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('prints the command once and keeps the compact CLI pointer out of command steps; JSON keeps compact_hint', async () => {
        const repoRoot = createTempRepo();
        try {
            const text = await runCliWithStdoutCapture(['gate', 'next-step', 'T-CLI-ONCE', '--repo-root', '.'], { cwd: repoRoot });
            const json = await runCliWithStdoutCapture(['gate', 'next-step', 'T-CLI-ONCE', '--as-json', '--repo-root', '.'], { cwd: repoRoot });

            assert.equal(text.exitCode, 0);
            const payload = JSON.parse(json.stdout) as {
                commands: Array<{ command: string }>; compact_hint?: string; recommended_action?: { command: string };
            };
            assert.equal(payload.commands.length, 1);
            assert.ok(payload.recommended_action);
            assert.equal(text.stdout.split(payload.recommended_action.command).length - 1, 1, text.stdout);
            assert.equal(text.stdout.split(payload.commands[0].command).length - 1, 0, 'no second action in the default text');
            assert.match(payload.compact_hint || '', /^Compact: /u);
            assert.doesNotMatch(text.stdout, /^Compact: /mu);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('keeps --as-json as the full structured result, also with --verbose', async () => {
        const repoRoot = createTempRepo();
        try {
            const plain = await runCliWithStdoutCapture(['gate', 'next-step', 'T-CLI-JSON', '--as-json', '--repo-root', '.'], { cwd: repoRoot });
            const verbose = await runCliWithStdoutCapture(['gate', 'next-step', 'T-CLI-JSON', '--as-json', '--verbose', '--repo-root', '.'], { cwd: repoRoot });
            const stable = (stdout: string) => ({ ...(JSON.parse(stdout) as Record<string, unknown>), generated_utc: '<generated>' });

            assert.deepEqual(stable(verbose.stdout), stable(plain.stdout));
            assert.deepEqual(Object.keys(JSON.parse(plain.stdout) as object), [
                'schema_version', 'task_id', 'generated_utc', 'navigator_command', 'status', 'next_gate', 'title', 'reason', 'commands',
                'missing_artifacts', 'present_artifacts', 'full_suite_validation', 'project_memory', 'review', 'task_queue_status_contract',
                'audit_status', 'profile', 'markdown_working_plan', 'optional_skill_selection', 'task_start_guidance', 'quality_checklist',
                'warnings', 'invalidation_impact', 'known_non_blocking_signals', 'review_cycle_block', 'final_report', 'recommended_action',
                'compact_hint'
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('accepts a positional task id for the gate next-step command', async () => {
        const repoRoot = createTempRepo();
        try {
            const result = await runCliWithStdoutCapture([
                'gate',
                'next-step',
                'T-CLI-POSITIONAL',
                '--repo-root',
                '.'
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0);
            assert.equal(result.errors.length, 0);
            assert.ok(result.stdout.includes('Task: T-CLI-POSITIONAL'));
            assert.ok(result.stdout.includes('NextGate: enter-task-mode'));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('accepts the top-level next-step alias with a positional task id', async () => {
        const repoRoot = createTempRepo();
        try {
            const result = await runCliWithStdoutCapture([
                'next-step',
                'T-CLI-TOPLEVEL',
                '--target-root',
                '.'
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0);
            assert.equal(result.errors.length, 0);
            assert.ok(result.stdout.includes('Task: T-CLI-TOPLEVEL'));
            assert.ok(result.stdout.includes('NextGate: enter-task-mode'));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('can infer the task id and reviews root from a preflight path', async () => {
        const repoRoot = createTempRepo();
        try {
            const preflightPath = path.join('garda-agent-orchestrator', 'runtime', 'reviews', 'T-CLI-PREFLIGHT-preflight.json');
            fs.mkdirSync(path.dirname(path.join(repoRoot, preflightPath)), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, preflightPath), JSON.stringify({ task_id: 'T-CLI-PREFLIGHT' }), 'utf8');

            const result = await runCliWithStdoutCapture([
                'gate',
                'next-step',
                '--preflight-path',
                preflightPath,
                '--repo-root',
                '.'
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0);
            assert.equal(result.errors.length, 0);
            assert.ok(result.stdout.includes('Task: T-CLI-PREFLIGHT'));
            assert.ok(result.stdout.includes('NextGate: enter-task-mode'));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('uses the fixed default bundle name in generated commands', async () => {
        const repoRoot = createTempRepo();
        try {
            const result = await runCliWithStdoutCapture([
                'gate',
                'next-step',
                '--task-id',
                'T-CUSTOM-BUNDLE',
                '--repo-root',
                '.'
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0);
            assert.equal(result.errors.length, 0);
            assert.ok(result.stdout.includes('node garda-agent-orchestrator/bin/garda.js task "T-CUSTOM-BUNDLE" start'));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
