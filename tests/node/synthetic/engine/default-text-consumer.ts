import assert from 'node:assert/strict';
import { splitCommandLine } from '../../../../src/core/command-line';
import { formatNextStepRecommendedActionLabel } from '../../../../src/gates/next-step/next-step-recommended-action';
import { MULTIPLE_COMMANDS_HEADING } from '../../../../src/gates/next-step/next-step-command-formatters';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cli, TASK_ID, writeTaskEdit } from '../../cli/commands/task-composite-test-fixture';

/**
 * The smallest consumer of the DEFAULT navigator text that the backfill checks need (not a walker): it reads the real
 * stdout of `next-step`, extracts the printed commands the way an agent reading the text would, and executes a printed
 * command verbatim. Only values the modeled agent or operator owns (a `<placeholder>` token) may be substituted.
 */
export interface PrintedCommand { label: string; text: string; argv: string[] }
export interface ParsedNavigatorText {
    raw: string;
    status: string;
    nextGate: string;
    reason: string;
    /** The one stated action (`Run mechanical steps`, `Start the task`, ...), when the text states one. */
    primary: PrintedCommand | null;
    /** The labeled entries under a `Commands` heading. */
    commands: PrintedCommand[];
    headingAlternatives: boolean;
    commandsNone: boolean;
    hints: string[];
}

const RECOMMENDED_KINDS = ['mechanical', 'entry', 'reviewer-started', 'reviewer-returned', 'closeout', 'attestation'] as const;
const RECOMMENDED_LABELS: string[] = RECOMMENDED_KINDS.map((kind) => formatNextStepRecommendedActionLabel({ mode: 'advance', kind, command: '' }));

/** The command lines a default navigator text states for the agent to run (not rationale or recovery examples). */
export function statedCommands(text: string): string[] {
    const nextAction = /^Next action: (.+)$/mu.exec(text)?.[1];
    if (nextAction) return [nextAction];
    return text.split(/\r?\n/u).flatMap(line => {
        const match = /^(?: {2}[^:]+|Start the task|Run mechanical steps|Run closeout(?: with your review authorship attestation)?): (node .+)$/u.exec(line);
        return match ? [match[1]] : [];
    });
}

/** CLI arguments of a stated command: the root command and everything after the launcher. */
export function cliArgs(command: string): string[] {
    const [node, launcher, rootCommand, ...args] = splitCommandLine(command);
    assert.equal(node, 'node', command);
    assert.match(launcher, /(?:^|\/)garda(?:-[\w-]+)?\.js$/u, command);
    return [rootCommand, ...args];
}

export const printedArgv = cliArgs;

function printed(label: string, text: string): PrintedCommand {
    return { label, text, argv: printedArgv(text) };
}

export function parseNavigatorText(raw: string): ParsedNavigatorText {
    const lines = raw.split(/\r?\n/u);
    const field = (name: string): string => lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2) ?? '';
    let primary: PrintedCommand | null = null;
    for (const label of RECOMMENDED_LABELS) {
        const line = lines.find((entry) => entry.startsWith(`${label}: `));
        if (line) {
            assert.equal(primary, null, 'The text states one primary action, not several');
            primary = printed(label, line.slice(label.length + 2));
        }
    }
    const commands: PrintedCommand[] = [];
    const heading = lines.findIndex((line) => line === 'Commands:' || line === MULTIPLE_COMMANDS_HEADING);
    if (heading >= 0) {
        for (const line of lines.slice(heading + 1)) {
            const match = /^ {2}([^:]+): (.+)$/u.exec(line);
            if (!match) break;
            commands.push(printed(match[1], match[2]));
        }
    }
    return {
        raw, status: field('Status'), nextGate: field('NextGate'), reason: field('Reason'), primary, commands,
        headingAlternatives: lines.includes(MULTIPLE_COMMANDS_HEADING), commandsNone: !primary && commands.length === 0,
        hints: lines.filter((line) => line.startsWith('Hint: '))
    };
}

/** Real default stdout of `next-step`, with the navigator's own invocation arguments. */
export async function readDefaultText(root: string, taskId: string): Promise<ParsedNavigatorText> {
    const result = await cli(root, ['next-step', taskId, '--repo-root', '.']);
    assert.equal(result.exitCode, 0, result.text);
    return parseNavigatorText(result.text);
}

/** The command the text offers for the agent to run: its primary action, else its single command. */
export function offeredCommand(parsed: ParsedNavigatorText): PrintedCommand {
    const command = parsed.primary ?? (parsed.commands.length === 1 ? parsed.commands[0] : null);
    assert.ok(command, `The text offers exactly one command to run:\n${parsed.raw}`);
    return command;
}

/** A token only the agent or operator can fill: an angle-bracket placeholder or the provider environment reference. */
export const PLACEHOLDER_TOKEN = /^(?:<[^>]+>|\$(?:env:)?GARDA_EXECUTION_PROVIDER)$/u;

/** Substitute only placeholder tokens the modeled agent owns; any other placeholder keeps the command unexecutable. */
export function fillPlaceholders(command: PrintedCommand, values: Record<string, string> = {}): string[] {
    return command.argv.map((token) => {
        if (!PLACEHOLDER_TOKEN.test(token)) return token;
        const value = values[token];
        assert.ok(value !== undefined, `Unfilled placeholder ${token} in: ${command.text}`);
        return value;
    });
}

export async function runPrinted(root: string, command: PrintedCommand, values: Record<string, string> = {}): Promise<{ exitCode: number; text: string }> {
    return cli(root, fillPlaceholders(command, values));
}

/** Every command string a text prints appears exactly once (the navigator/after-command lines name another command). */
export function assertEachCommandPrintedOnce(parsed: ParsedNavigatorText): void {
    const all = [...(parsed.primary ? [parsed.primary] : []), ...parsed.commands];
    assert.equal(new Set(all.map((entry) => entry.text)).size, all.length, `No command is repeated:\n${parsed.raw}`);
    for (const entry of all) {
        assert.equal(parsed.raw.split(entry.text).length - 1, 1, `Command printed once: ${entry.label}\n${parsed.raw}`);
    }
    assert.equal(new Set(parsed.commands.map((entry) => entry.label)).size, parsed.commands.length, 'Alternatives carry distinct labels');
}

export async function run(root: string, args: string[], expectedCode = 0): Promise<string> {
    const { text, exitCode } = await cli(root, args);
    assert.equal(exitCode, expectedCode, args.join(' ') + '\n' + text);
    return text;
}

export function fillAnswers(root: string, answersPath: string): void {
    const file = path.resolve(root, answersPath);
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { answers: Array<{ status: string; answer: string }> };
    for (const answer of data.answers) {
        if (!answer.answer) {
            answer.status = 'PASS';
            answer.answer = 'The fixture change is bounded and has no new contracts or unrelated behavior.';
        }
    }
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

export function requireSingleActionFooter(text: string): void {
    const footers = [...text.matchAll(/^Next action: (node .+)$/gmu)];
    assert.equal(footers.length, 1, `Expected one executable next-action footer:\n${text}`);
    assert.equal(text.split(footers[0][1]).length, 2, `The footer command must appear once:\n${text}`);
}

/** Default-text (or JSON) walk of an ordinary task to its first agent-owned boundary; returns the boundary and the last text. */
export async function walkOrdinaryTask(root: string, rendered: boolean, docs: boolean,
    hooks: { onText?: (text: string) => void; docsPath?: string } = {}): Promise<{ outcome: string; output: string }> {
    let output = '';
    let edited = false;
    for (let index = 0; index < 24; index++) {
        let actions: string[], gate: string | undefined, reason: string;
        if (rendered) {
            if (/StopKind: terminal/u.test(output)) return { outcome: 'DONE', output };
            if (!statedCommands(output).length && !/^Instruction: fill /mu.test(output))
            { output = await run(root, ['next-step', TASK_ID]); hooks.onText?.(output); }
            if (/^Status: DONE$/mu.test(output)) return { outcome: 'DONE', output };
            actions = statedCommands(output);
            gate = /^NextGate: (.+)$/mu.exec(output)?.[1];
            reason = output;
        } else {
            const route = JSON.parse(await run(root, ['next-step', TASK_ID, '--as-json']));
            if (route.status === 'DONE') return { outcome: 'DONE', output };
            actions = route.recommended_action ? [route.recommended_action.command] : route.commands.map(({ command }: { command: string }) => command);
            gate = route.next_gate;
            reason = route.reason;
        }
        if (gate === 'record-reviewer-delegation-started'
            || actions.some(action => action.includes('--reviewer-phase started'))) return { outcome: 'reviewer-boundary', output };
        if (gate === 'quality-checklist' && !actions.length) {
            const answers = /([\w./-]+-quality-checklist-answers\.json)/u.exec(reason)?.[1];
            assert.ok(answers, reason);
            fillAnswers(root, answers);
            output = '';
            continue;
        }
        assert.ok(actions.length === 1, reason);
        const args = cliArgs(actions[0]).map(arg => /^\$(?:env:)?GARDA_EXECUTION_PROVIDER$/u.test(arg) ? 'Codex' : arg);
        if (args[0] === 'task' && args[2] === 'start' && args.includes('<provider>')) {
            args[args.indexOf('<provider>')] = 'Codex';
        }
        output = await run(root, args);
        if (rendered && ((args[0] === 'task' && args[2] === 'start')
            || (args[0] === 'gate' && args[1] === 'load-rule-pack' && args.includes('TASK_ENTRY')))) {
            requireSingleActionFooter(output);
        }
        hooks.onText?.(output);
        if (!edited && args.includes('TASK_ENTRY')) {
            if (docs) fs.appendFileSync(path.join(root, hooks.docsPath ?? 'CHANGELOG.md'), '\n- Documented the fixture.\n');
            else writeTaskEdit(root);
            edited = true;
            // An intervening source edit made the preceding gate's preview stale.
            output = '';
        }
    }
    throw new Error('Default text walk did not reach its expected boundary:\n' + output);
}


/**
 * The project-memory advice a text prints must match the argv it prints (f6f9478a): a confirmation without any
 * --updated-memory-file is described as a review without edits, never as an update, and every pointer it names is
 * a candidate file the command lists. Vacuous when the text has no confirming project-memory command.
 */
export function assertMemoryAdviceMatchesArgv(text: string): boolean {
    const command = statedCommands(text).find(entry => entry.includes('gate project-memory-impact'));
    if (!command || !command.includes('--confirm-updated')) return false;
    const updated = command.split('--updated-memory-file').length - 1;
    const skipped = command.split('--skipped-memory-file').length - 1;
    const withoutEdits = text.includes('No candidate memory file is edited.');
    assert.equal(withoutEdits, updated === 0, `Advice and argv disagree about edited memory files:\n${text}`);
    if (updated === 0) {
        assert.ok(skipped > 0, `A review without edits lists its candidates as skipped:\n${command}`);
        assert.match(text, /records a review without edits/u);
    }
    for (const pointer of text.matchAll(/([\w./-]+\.md):\d+ \(/gu)) {
        assert.ok(command.includes(pointer[1]), `A pointer names a candidate the command lists: ${pointer[1]}`);
    }
    return true;
}
