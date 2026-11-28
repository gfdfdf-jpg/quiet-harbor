import * as path from 'node:path';

import { quoteCommandValue } from '../../../../core/command-quoting';
import { resolveGardaCliPrefix } from '../../../../core/garda-cli-prefix';
import { readPostPreflightRulePackReadiness } from '../../../../gates/next-step/next-step-preflight-recovery';
import { normalizePath } from '../../../../gates/shared/helpers';
import { runBindRulePackToPreflightCommand } from '../task-mode/task-mode-record-commands';
import { getErrorMessage } from './gate-flow-helpers';
import {
    runClassifyChangeCommand,
    type ClassifyChangeCommandOptions,
    type ClassifyChangeCommandResult
} from './compile-flow-classify';

export interface ClassifyChangeRulePackRebind {
    passed: boolean;
    outputLines: string[];
}

export interface ClassifyChangeWithRulePackRebindResult extends ClassifyChangeCommandResult {
    /** The POST_PREFLIGHT rebinding this run attempted; null when none was due or possible. */
    rulePackRebind: ClassifyChangeRulePackRebind | null;
}

interface RebindEvidencePaths {
    repoRoot: string;
    taskId: string;
    preflightPath: string;
    taskModePath: string;
    rulePackPath: string;
}

function displayPath(repoRoot: string, value: string): string {
    const relative = path.relative(repoRoot, path.resolve(repoRoot, value));
    return quoteCommandValue(normalizePath(relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : value));
}

/**
 * The recovery after a failed inline rebinding, with the same preflight, task-mode and rule-pack paths this
 * classification used, so a custom preflight or rule pack is never sent to the default evidence. The navigator
 * accepts the preflight path but not a custom rule pack, so a custom rule pack retries the bind gate itself.
 */
function buildRebindRecoveryLine(paths: RebindEvidencePaths): string {
    const cliPrefix = resolveGardaCliPrefix(paths.repoRoot);
    const preflight = `--preflight-path ${displayPath(paths.repoRoot, paths.preflightPath)}`;
    const bind = [`${cliPrefix} gate bind-rule-pack-to-preflight --task-id ${quoteCommandValue(paths.taskId)}`, preflight,
        ...(paths.taskModePath ? [`--task-mode-path ${displayPath(paths.repoRoot, paths.taskModePath)}`] : []),
        ...(paths.rulePackPath ? [`--artifact-path ${displayPath(paths.repoRoot, paths.rulePackPath)}`] : []),
        '--repo-root "."'].join(' ');
    if (paths.rulePackPath) {
        return `NextStep: the preflight is recorded; retry the binding on the same evidence with ${bind}. If it refuses, run `
            + 'the Remediation command it prints: it reads the rule files again for this preflight and rule pack.';
    }
    const navigator = `${cliPrefix} next-step ${quoteCommandValue(paths.taskId)} ${preflight} --repo-root "."`;
    return `NextStep: the preflight is recorded; run ${navigator} and follow its rule-pack route `
        + `(bind-rule-pack-to-preflight or load-rule-pack), or retry the binding directly with ${bind}.`;
}

function failedRebind(lines: string[], paths: RebindEvidencePaths): ClassifyChangeRulePackRebind {
    return { passed: false, outputLines: [...lines, buildRebindRecoveryLine(paths)] };
}

/**
 * classify-change as the agent and the composite run it. A refreshed preflight whose required downstream rule files
 * and their hashes are unchanged in the current task-mode cycle needs only its POST_PREFLIGHT binding refreshed, so
 * the same step records it: the ordinary bind-rule-pack-to-preflight gate runs with its own checks and appends its
 * usual RULE_PACK_LOADED event and artifact. The decision is the navigator's own: a binding that is already current
 * (for example after byte-identical preflight evidence was restored) is never rebound. A rebinding that fails or
 * throws is reported as a failure with its recovery command; load-rule-pack appends its event before it publishes
 * the artifact, so a throw never leaves a published stage without its event and nothing needs restoring here.
 */
export function runClassifyChangeWithRulePackRebind(options: ClassifyChangeCommandOptions,
    bindRulePack: typeof runBindRulePackToPreflightCommand = runBindRulePackToPreflightCommand): ClassifyChangeWithRulePackRebindResult {
    const result = runClassifyChangeCommand(options);
    const taskId = String(options.taskId || '').trim();
    if (!taskId || !result.preflightPath) return { ...result, rulePackRebind: null };
    const paths: RebindEvidencePaths = { repoRoot: path.resolve(String(options.repoRoot || '.')), taskId,
        preflightPath: result.preflightPath, taskModePath: String(options.taskModePath || ''),
        rulePackPath: String(options.rulePackPath || '') };
    let canBind = false;
    try {
        const readiness = readPostPreflightRulePackReadiness(paths.repoRoot, taskId, paths.preflightPath, paths.rulePackPath,
            paths.taskModePath);
        canBind = !readiness.ready && readiness.rebind?.can_bind === true;
    } catch {
        // The navigator reports the rule-pack state through its own load or bind route.
    }
    if (!canBind) return { ...result, rulePackRebind: null };
    try {
        const bind = bindRulePack({ repoRoot: paths.repoRoot, taskId, preflightPath: paths.preflightPath,
            ...(paths.taskModePath ? { taskModePath: paths.taskModePath } : {}),
            ...(paths.rulePackPath ? { artifactPath: paths.rulePackPath } : {}) });
        return { ...result, rulePackRebind: bind.exitCode === 0
            ? { passed: true, outputLines: bind.outputLines }
            : failedRebind(bind.outputLines, paths) };
    } catch (error: unknown) {
        return { ...result, rulePackRebind: failedRebind(['RULE_PACK_BIND_FAILED', 'Stage: POST_PREFLIGHT',
            `Reason: ${getErrorMessage(error)}`], paths) };
    }
}
