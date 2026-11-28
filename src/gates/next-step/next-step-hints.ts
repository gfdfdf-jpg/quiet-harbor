import * as path from 'node:path';

import { isPlainRecord } from '../../core/records';
import { normalizePath } from '../shared/helpers';
import { resolveMarkdownWorkingPlanPath } from '../task-mode/task-mode-plan';
import type { NextStepResult } from './next-step';
import type { NextStepResolutionContext } from './next-step-resolution-context';

/**
 * Navigator hints are printed advice only. Garda never checks them; they choose no route, add no status and block
 * nothing. Like the typed command descriptors, they stay outside the serialized result, so `--as-json` is unchanged.
 */
export type NextStepHintStep = 'implementation-start' | 'compaction-checkpoint';

export interface NextStepHintState {
    step: NextStepHintStep;
    /** True when a JSON task plan is attached to task mode or a Markdown working plan exists. */
    plan_present: boolean;
    repo_root: string;
    task_id: string;
}

export interface NextStepHintInputs {
    taskModePlanAttached: boolean;
    /**
     * Changed files of the current preflight that come with evidence of a real diff: files read from the workspace
     * (git), or explicit `--changed-file` values with changed lines or renames; 0 for a baseline or planned-only
     * classification, null when there is no preflight.
     */
    preflightChangedFileCount: number | null;
    repoRoot: string;
    taskId: string;
}

const hintStates = new WeakMap<object, NextStepHintState>();

function readNumber(record: Record<string, unknown>, key: string): number {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Classify-change records explicit `--changed-file` values under this source; it is also its default. */
const EXPLICIT_CHANGED_FILES_SOURCE = 'explicit_changed_files';

/**
 * Hint inputs from state the navigator has already read; no file is read here.
 * - Changed files read from the workspace (git auto, staged, a split checkpoint range) are a real diff, also a new
 *   empty or binary file, which has no changed lines.
 * - Explicit `--changed-file` values may be planned files before any code exists: they count only with changed
 *   lines or renames, so a planned-only classification is not a diff.
 */
export function buildNextStepHintInputs(
    context: Pick<NextStepResolutionContext, 'repoRoot' | 'taskId' | 'taskMode' | 'preflight'>
): NextStepHintInputs {
    const changedFiles = context.preflight?.changed_files;
    const zeroDiffGuard = context.preflight?.zero_diff_guard;
    const zeroDiff = isPlainRecord(zeroDiffGuard) && zeroDiffGuard.zero_diff_detected === true;
    const metrics = isPlainRecord(context.preflight?.metrics) ? context.preflight.metrics : {};
    const detectionSource = String(context.preflight?.detection_source || EXPLICIT_CHANGED_FILES_SOURCE).trim().toLowerCase();
    const realDiff = detectionSource !== EXPLICIT_CHANGED_FILES_SOURCE
        || readNumber(metrics, 'changed_lines_total') > 0 || readNumber(metrics, 'rename_count') > 0;
    return {
        taskModePlanAttached: context.taskMode?.plan !== undefined && context.taskMode?.plan !== null,
        preflightChangedFileCount: context.preflight
            ? (zeroDiff || !realDiff || !Array.isArray(changedFiles) ? 0 : changedFiles.length)
            : null,
        repoRoot: context.repoRoot,
        taskId: context.taskId
    };
}

const RULE_PACK_GATES: ReadonlySet<string> = new Set(['load-rule-pack', 'bind-rule-pack-to-preflight']);

function hasMissingArtifact(result: Pick<NextStepResult, 'missing_artifacts'>, key: string): boolean {
    return result.missing_artifacts.some((artifact) => artifact.key === key);
}

/**
 * - implementation-start: TASK_ENTRY rule loading, the last step before code in both the individual and the composite
 *   path (no preflight exists yet).
 * - compaction-checkpoint: POST_PREFLIGHT rule loading after the first classification of a real diff, before the
 *   first compile: implementation is finished and the rules are about to be read again.
 */
export function resolveNextStepHintStep(
    result: Pick<NextStepResult, 'status' | 'next_gate' | 'missing_artifacts'>,
    preflightChangedFileCount: number | null
): NextStepHintStep | null {
    if (result.status !== 'BLOCKED' || !RULE_PACK_GATES.has(result.next_gate || '')) return null;
    if (preflightChangedFileCount === null) {
        return result.next_gate === 'load-rule-pack' && hasMissingArtifact(result, 'preflight') ? 'implementation-start' : null;
    }
    return preflightChangedFileCount > 0 && hasMissingArtifact(result, 'compile-gate') ? 'compaction-checkpoint' : null;
}

export function attachNextStepHints(result: NextStepResult, inputs: NextStepHintInputs): NextStepResult {
    const step = resolveNextStepHintStep(result, inputs.preflightChangedFileCount);
    if (step) {
        hintStates.set(result, Object.freeze({
            step,
            plan_present: inputs.taskModePlanAttached || Boolean(result.markdown_working_plan),
            repo_root: inputs.repoRoot,
            task_id: inputs.taskId
        }));
    }
    return result;
}

export function readNextStepHintState(result: object): NextStepHintState | null {
    return hintStates.get(result) ?? null;
}

/**
 * The hint repeats while its step does (for example after a resume), so it is conditional on what the agent knows:
 * an agent that already compacted after the implementation just continues.
 */
export const COMPACTION_CHECKPOINT_HINT = 'Hint: if you have not compacted since the implementation, this is a good moment: '
    + 'compact and re-read the rules, or suggest it to the operator; if declined or already done, continue.';

export function buildPlanBeforeCodeHint(markdownPlanPath: string): string {
    return `Hint: no task plan is attached; write a short plan in ${markdownPlanPath} before coding.`;
}

/**
 * The plan path the navigator reads (`readOptionalMarkdownWorkingPlan`, first candidate), resolved when the hint is
 * printed: after the navigator resolution, so its bundle lookup is not part of the measured navigator work.
 */
export function resolveNextStepPlanHintPath(repoRoot: string, taskId: string): string {
    return normalizePath(path.relative(repoRoot, resolveMarkdownWorkingPlanPath(repoRoot, taskId)));
}

/** The one-line hints for this navigator result; empty for every other step. */
export function selectNextStepHints(result: object): string[] {
    const state = readNextStepHintState(result);
    if (!state) return [];
    if (state.step === 'compaction-checkpoint') return [COMPACTION_CHECKPOINT_HINT];
    return state.plan_present ? [] : [buildPlanBeforeCodeHint(resolveNextStepPlanHintPath(state.repo_root, state.task_id))];
}
