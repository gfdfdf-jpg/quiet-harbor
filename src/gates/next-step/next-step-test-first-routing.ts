import { readRetainedRecipeExpectedRedRejection } from '../test-first/expected-red-recipe-evidence';

import {
    fileSha256,
    normalizePath
} from '../shared/helpers';
import {
    hasTestFirstExpectedRedDeclaration,
    TEST_FIRST_EXPECTED_RED_MARKER
} from '../test-first/test-first-declaration';
import { inspectRecipeExpectedRedRoute } from '../project-validation/focused';
import { isExpectedRedTestScope } from '../test-first/expected-red-scope';
import { buildCommand, quoteCommandValue } from './next-step-command-formatters';
import type { NextStepCommand } from './next-step';
import type { TaskQueueEntry } from './next-step-task-queue';
import { currentExpectedRedExecutionEvidence, readExpectedRedReviewObligations, ExpectedRedEvidenceError, readRetainedExpectedRedRejection,
    readFocusedCommandHint, readExpectedRedPreparation, EXPECTED_RED_RECOVERY } from '../test-first/expected-red-evidence';
import { readCoherentRedCheckpoint, readCoherentRedCompletionReadiness } from '../../cli/commands/gate-flows/recovery/recovery-flow-validation-checkpoint';
import { buildFocusedValidationRecoveryCommand } from './next-step-validation-routes';


export interface NextStepTestFirstExpectedFailureRoute {
    nextGate: 'test-first-expected-failure' | 'implementation' | 'restart-coherent-cycle' | 'compile-gate';
    title: string;
    reason: string;
    commands: NextStepCommand[];
}

export interface TestFirstExpectedFailureRouteOptions {
    repoRoot: string;
    reviewsRoot: string;
    eventsRoot: string;
    taskId: string;
    taskEntry: TaskQueueEntry | null;
    preflight: Record<string, unknown> | null;
    preflightPath: string;
    preflightCommandPath: string;
    cliPrefix: string;
    workspaceReady: boolean;
    currentChangedFiles?: readonly string[] | null;
}

function normalizeFileList(values: readonly unknown[]): string[] {
    return [...new Set(
        values
            .map((entry) => normalizePath(String(entry || '').trim()).replace(/^\.\/?/u, ''))
            .filter(Boolean)
    )].sort();
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/** Reuse the same authenticated RED/GREEN projection as review; reporter text has no authority. */
function inspectNativeExpectedFailureProgress(options: TestFirstExpectedFailureRouteOptions): {
    progress: 'complete' | 'needs-green'; reason?: string;
} | null {
    try {
        const obligations = readExpectedRedReviewObligations({ ...options, preflightSha256: fileSha256(options.preflightPath) });
        return obligations.some(obligation => obligation.case_execution?.expected_failure) ? { progress: 'complete' } : null;
    } catch (error) {
        return error instanceof ExpectedRedEvidenceError && error.needsGreen
            ? { progress: 'needs-green', reason: error.message } : null;
    }
}

export function buildTestFirstExpectedFailureRoute(
    options: TestFirstExpectedFailureRouteOptions
): NextStepTestFirstExpectedFailureRoute | null {
    if (options.preflight && options.workspaceReady) {
        try {
            const pending = readCoherentRedCheckpoint(options.repoRoot, options.taskId);
            if (pending && !pending.completedArtifactPath) {
                const readiness = readCoherentRedCompletionReadiness(options.repoRoot, options.taskId, pending);
                if (readiness.ready) return { nextGate: 'restart-coherent-cycle', title: 'Finalize the prepared coherent transition.',
                    reason: readiness.reason + ' Resume the existing checkpoint; do not enter another task mode.',
                    commands: [buildCommand('Finalize prepared coherent recovery', `${options.cliPrefix} gate restart-coherent-cycle`
                        + ` --task-id ${quoteCommandValue(options.taskId)}`
                        + (typeof pending.record.request.taskModePath === 'string'
                            ? ` --task-mode-path ${quoteCommandValue(pending.record.request.taskModePath)}` : '')
                        + (typeof pending.record.request.preflightPath === 'string'
                            ? ` --preflight-path ${quoteCommandValue(pending.record.request.preflightPath)}` : '')
                        + (typeof pending.record.request.preflightOutputPath === 'string'
                            ? ` --preflight-output-path ${quoteCommandValue(pending.record.request.preflightOutputPath)}` : '')
                        + ' --repo-root "."')] };
                if (readiness.compileRequired) return { nextGate: 'compile-gate',
                    title: 'Compile the prepared transition with its retained output filters.', reason: readiness.reason,
                    commands: [buildCommand('Run retained coherent compile', `${options.cliPrefix} gate compile-gate`
                        + ` --task-id ${quoteCommandValue(options.taskId)}`
                        + ` --task-mode-path ${quoteCommandValue(pending.record.task_mode_path)}`
                        + ` --preflight-path ${quoteCommandValue(options.preflightCommandPath)}`
                        + ` --output-filters-path ${quoteCommandValue(readiness.compileRequired.outputFiltersPath)}`
                        + ' --repo-root "."')] };
                if (hasTestFirstExpectedRedDeclaration(options.taskEntry) && options.preflight.scope_category !== 'test-only') {
                    const red = readExpectedRedPreparation({ repoRoot: options.repoRoot, taskId: options.taskId,
                        preflightPath: options.preflightPath, preflightSha256: fileSha256(options.preflightPath) });
                    if (!red) {
                        const rejection = readRetainedExpectedRedRejection({ ...options, preflightSha256: fileSha256(options.preflightPath) })
                            ?? readRetainedRecipeExpectedRedRejection(options) ?? '';
                        return { nextGate: 'test-first-expected-failure', title: 'Prepare legitimate test-only RED before coherent compile.',
                        reason: rejection + (rejection.includes('predates task re-entry') && !rejection.includes(EXPECTED_RED_RECOVERY)
                            ? ` ${EXPECTED_RED_RECOVERY}` : '')
                            + ' Coherent recovery has no current RED. Prepare a legitimate test-only baseline through the ordinary workflow; '
                            + 'a mixed or already implemented scope cannot run --expect-failure, and recovery never rewinds or silently narrows source.',
                        commands: [] };
                    }
                }
            }
        } catch (error) {
            return { nextGate: 'test-first-expected-failure', title: 'Resolve coherent recovery checkpoint rejection.',
                reason: String(error), commands: [] };
        }
    }
    if (
        !options.preflight
        || !hasTestFirstExpectedRedDeclaration(options.taskEntry)
        || String(options.preflight.task_id || '').trim() !== options.taskId
        || !isExpectedRedTestScope(options.preflight, options.repoRoot, options.taskId)
        || !options.workspaceReady
    ) {
        return null;
    }
    const preflightChangedFiles = normalizeFileList(
        Array.isArray(options.preflight.changed_files) ? options.preflight.changed_files : []
    );
    const currentChangedFiles = normalizeFileList(options.currentChangedFiles || preflightChangedFiles);
    if (!sameStringList(preflightChangedFiles, currentChangedFiles)) {
        return null;
    }
    const recipeRoute = inspectRecipeExpectedRedRoute({ repoRoot: options.repoRoot, taskId: options.taskId,
        preflight: options.preflight, preflightSha256: fileSha256(options.preflightPath) });
    const genericCommands = [buildCommand('Record the declared task command expected RED',
        `${options.cliPrefix} gate run-intermediate-command --task-id ${quoteCommandValue(options.taskId)}`
        + ' --command-source targeted-test --command "<task-test-command>" --expect-failure'
        + ` --preflight-path ${quoteCommandValue(options.preflightCommandPath)} --repo-root "."`)];
    const expectedRed = currentExpectedRedExecutionEvidence(options.repoRoot, options.taskId);
    if (expectedRed) {
        return { nextGate: 'implementation',
            title: 'Implement the behavior after retaining the current failing test execution.',
            reason: 'Native evidence retains the exact source, selected cases and actual nonzero execution. Assertion semantics remain pending the ordinary independent review after implementation. Preserve these test sources, obtain complete current GREEN, and let the existing review verify both executions before task acceptance.',
            commands: [] };
    }
    const nativeProgress = inspectNativeExpectedFailureProgress(options);
    if (nativeProgress?.progress === 'complete') return null;
    if (nativeProgress?.progress === 'needs-green') return {
        nextGate: 'test-first-expected-failure', title: 'Record current GREEN for the retained RED command.',
        reason: `${nativeProgress.reason} Retained RED is bound to unchanged task test sources. Run the same declared command and targets successfully; assertion semantics remain pending independent review.`,
        commands: genericCommands.map(command => ({ ...command, label: 'Record current GREEN',
            command: command.command.replace(' --expect-failure', '') }))
    };
    if (recipeRoute && recipeRoute.recipeIds.length > 0 && !recipeRoute.violation) {
        if (!recipeRoute.expectedFailure && !recipeRoute.violation) {
            const rejection = readRetainedRecipeExpectedRedRejection(options);
            if (rejection) return { nextGate: 'test-first-expected-failure',
                title: 'Record fresh current recipe RED after resolving the retained evidence rejection.',
                reason: `${rejection} Fresh RED requires the current test-only setup.`,
                commands: recipeRoute.recipeIds.length ? [buildCommand('Record fresh declared recipe RED',
                    `${options.cliPrefix} gate run-intermediate-command --task-id ${quoteCommandValue(options.taskId)}`
                    + ` --recipe-id ${quoteCommandValue(recipeRoute.recipeIds[0])} --expect-failure --repo-root "."`)] : genericCommands };
        }
        return {
            nextGate: recipeRoute.expectedFailure ? 'implementation' : 'test-first-expected-failure',
            title: recipeRoute.expectedFailure ? 'Implement the behavior after retaining the declared recipe failure.'
                : 'Record genuine expected-red evidence from the admitted recipe.',
            reason: recipeRoute.violation ?? (recipeRoute.expectedFailure
                ? 'Native evidence retains the declared targets and complete nonzero execution. The ordinary post-implementation review must verify assertion semantics alongside current GREEN.'
                : 'TASK.md declares expected red. Run the current admitted recipe; unexpected pass, interrupted execution and superseded evidence cannot advance implementation.'),
            commands: recipeRoute.expectedFailure ? [] : [buildCommand(
                'Record declared recipe expected-red failure', `${options.cliPrefix} gate run-intermediate-command`
                + ` --task-id ${quoteCommandValue(options.taskId)} --recipe-id ${quoteCommandValue(recipeRoute.nextRecipeId ?? recipeRoute.recipeIds[0])}`
                + ' --expect-failure --repo-root "."')]
        };
    }
    // Source names do not establish a runnable command or its result reporter.
    const testPaths = normalizeFileList(Array.isArray(options.preflight.changed_files) ? options.preflight.changed_files : []);
    if (testPaths.length === 0) {
        return {
            nextGate: 'test-first-expected-failure',
            title: 'A runnable changed test is required for expected-red evidence.',
            reason:
                `TASK.md declares ${TEST_FIRST_EXPECTED_RED_MARKER}, but the current test-only preflight has no concrete changed source. `
                + 'Materialize and classify the intended test; compile and task test remain fail-closed.',
            commands: [buildCommand('Classify the materialized task tests', `${options.cliPrefix} gate classify-change`
                + ` --task-id ${quoteCommandValue(options.taskId)} --changed-files "<task-test-source>" --repo-root "."`)]
        };
    }
    const rejection = readRetainedExpectedRedRejection({ ...options, preflightSha256: fileSha256(options.preflightPath) });
    let hint: ReturnType<typeof readFocusedCommandHint>;
    try { hint = readFocusedCommandHint(options.repoRoot, options.taskId, { expectedFailureOnly: true }); }
    catch (error) { return { nextGate: 'test-first-expected-failure', title: 'Resolve current RED evidence inspection failure.',
        reason: String(error), commands: [] }; }
    if (rejection && !/predates task re-entry|Selected command source identity is no longer current|test\/support input bytes or scope changed|is unavailable for the current selected sources/u.test(rejection)) hint = null;
    if (rejection || hint) return { nextGate: 'test-first-expected-failure',
        title: 'Record genuine current RED; prior execution cannot cross the task-mode boundary.',
        reason: rejection ?? 'The retained invocation is a command hint only. Run it again under the current test-only preflight.',
        commands: hint ? [buildCommand('Record fresh focused RED', buildFocusedValidationRecoveryCommand({
            cliPrefix: options.cliPrefix, taskId: options.taskId, preflightPath: options.preflightCommandPath,
            hint, expectedFailure: true }))] : genericCommands };
    return {
        nextGate: 'test-first-expected-failure',
        title: 'Declare the actual task test command and targets.',
        reason:
            (recipeRoute?.violation ? `Optional recipe cannot apply: ${recipeRoute.violation} ` : '')
            + `TASK.md declares ${TEST_FIRST_EXPECTED_RED_MARKER}. No command or reporter is inferred from source names or build manifests. `
            + 'Use gate run-intermediate-command with --command-source targeted-test, the actual project --command, '
            + '--expect-failure and the current --preflight-path. Bind opaque selectors with --selected-case; retained output and exact source identities reach the ordinary independent review after implementation. '
            + 'Alternatively, declare the actual project command, target association and supported result format through an admitted recipe. '
            + 'Process failure alone cannot establish assertion semantics or final acceptance; current source and retained output authentication remain required.',
        commands: genericCommands
    };
}
