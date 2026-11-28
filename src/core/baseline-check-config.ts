import { inspectValidationCommand } from './validation-command-contract';

/** workflow-config section that opts project checks into a baseline run at task entry. */
export const BASELINE_CHECKS_CONFIG_KEY = 'baseline_checks';
export const MAX_BASELINE_CHECKS = 8;
const MAX_BASELINE_CHECK_COMMAND_LENGTH = 4096;

/**
 * Declared baseline checks are literal commands: one executable with arguments, no shell operators, redirection,
 * `&&` chains or environment assignments (the same contract as other validation commands).
 */
export function parseBaselineCheckCommands(value: unknown, label = `workflow-config.${BASELINE_CHECKS_CONFIG_KEY}.commands`): string[] {
    if (!Array.isArray(value)) throw new Error(`${label} must be an array of literal check commands.`);
    if (value.length > MAX_BASELINE_CHECKS) throw new Error(`${label} accepts at most ${MAX_BASELINE_CHECKS} commands.`);
    const commands = value.map((entry, index) => {
        const command = typeof entry === 'string' ? entry.trim() : '';
        if (!command || command.length > MAX_BASELINE_CHECK_COMMAND_LENGTH) {
            throw new Error(`${label}[${index}] must be a non-empty command of at most ${MAX_BASELINE_CHECK_COMMAND_LENGTH} characters.`);
        }
        const admission = inspectValidationCommand(command, 'validation');
        if (!admission.supported) throw new Error(`${label}[${index}] is not a literal command: ${admission.violation}`);
        return command;
    });
    if (new Set(commands).size !== commands.length) throw new Error(`${label} must not repeat a command.`);
    return commands;
}

/** Validates the whole section: `{ "commands": [...] }` and nothing else. */
export function parseBaselineChecksSection(value: unknown): { commands: string[] } {
    const label = `workflow-config.${BASELINE_CHECKS_CONFIG_KEY}`;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
    const unknown = Object.keys(value).filter(key => key !== 'commands');
    if (unknown.length) throw new Error(`${label} has unknown keys: ${unknown.join(', ')}.`);
    return { commands: parseBaselineCheckCommands((value as Record<string, unknown>).commands) };
}
