import { handleGate } from '../../../../src/cli/commands/gate-command';
import { splitCommandLine } from '../../../../src/core/command-line';
import type { WalkStep } from './navigator-walk';
import { captureWalkOutput } from './walk-output';
import { nativeWalkCommand } from './walk-native';

/**
 * The modeled operator answers a printed approval command: only the operator-owned values (a stated intent, the
 * approval time) are filled in, then the command runs through the public gate entry exactly as printed.
 */
export async function runOperatorApprovedCommand(step: WalkStep, values: Array<[RegExp | string, string]>): Promise<void> {
    let command = step.command ?? '';
    for (const [placeholder, value] of values) command = command.replace(placeholder, value);
    if (/<[^>]+>/u.test(command)) throw new Error('Only operator-owned values may be placeholders: ' + command);
    const argv = splitCommandLine(command);
    const gate = argv.indexOf('gate');
    step.command = command;
    if (process.env.GARDA_SYNTHETIC_WALK_DIAGNOSTICS) {
        const executed = nativeWalkCommand(argv.slice(gate));
        step.exitCode = executed.exitCode;
        step.output = executed.output;
        return;
    }
    const output: string[] = [];
    const previousExitCode = process.exitCode;
    try {
        process.exitCode = 0;
        await captureWalkOutput(output, () => handleGate(argv.slice(gate + 1)));
        step.exitCode = Number(process.exitCode ?? 0);
        step.output = output.join('\n');
    } finally { process.exitCode = previousExitCode; }
}
