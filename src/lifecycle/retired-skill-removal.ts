import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    assertExistingPathIdentity,
    bindContainedDestination,
    ensureContainedDirectory,
    removeContainedPath
} from '../core/contained-filesystem';
import {
    classifyMovedRetiredSkillCopy,
    classifyRetiredSkillCopy,
    type RetiredSkillCopyClassification
} from '../runtime/retired-skill-copies';
import { RETIRED_BASELINE_SKILL_DIRECTORIES } from '../runtime/skill-manifest';
import { writeSkillsIndex } from '../runtime/skills';

/**
 * What a lifecycle did, or would do on apply, with one leftover copy of a retired
 * baseline skill under `live/skills/<id>`.
 */
export type RetiredSkillCopyAction = 'removed' | 'kept' | 'absent' | 'would-remove' | 'would-keep';

export interface RetiredSkillCopyOutcome {
    skillId: string;
    action: RetiredSkillCopyAction;
    reason: string;
}

export interface RetiredSkillRemovalFileOperations {
    rename(from: string, to: string): void;
    removeStaged(targetRoot: string, stagedPath: string): void;
}

const DEFAULT_FILE_OPERATIONS: RetiredSkillRemovalFileOperations = {
    rename: (from, to) => fs.renameSync(from, to),
    removeStaged: (targetRoot, stagedPath) => removeContainedPath(targetRoot, stagedPath, true)
};

const KEPT_MODIFIED = 'modified or unrecognised copy; ignored and still content-scanned';
const KEPT_LINK = 'link; not followed, ignored';

function keptReason(classification: RetiredSkillCopyClassification): string {
    return `${classification.state === 'link' ? KEPT_LINK : KEPT_MODIFIED} (${classification.reason})`;
}

function errorCode(error: unknown): string {
    return (error as NodeJS.ErrnoException).code || (error instanceof Error ? error.message : String(error));
}

/** Classifies each retired id; a copy that cannot even be inspected is kept untouched. */
function classifyEach(bundleRoot: string): Array<RetiredSkillCopyClassification | { skillId: string; inspectError: string }> {
    return RETIRED_BASELINE_SKILL_DIRECTORIES.map((skillId) => {
        try {
            return classifyRetiredSkillCopy(bundleRoot, skillId);
        } catch (error) {
            return { skillId, inspectError: errorCode(error) };
        }
    });
}

/** The outcome an apply would have, computed without changing anything. */
export function planRetiredSkillCopyRemoval(bundleRoot: string): RetiredSkillCopyOutcome[] {
    return classifyEach(bundleRoot).map((classification) => {
        if ('inspectError' in classification) {
            return { skillId: classification.skillId, action: 'would-keep', reason: `could not inspect (${classification.inspectError}); left intact and ignored` };
        }
        if (classification.state === 'absent') return { skillId: classification.skillId, action: 'absent', reason: 'not present' };
        if (classification.state === 'shipped') {
            return { skillId: classification.skillId, action: 'would-remove', reason: classification.reason };
        }
        return { skillId: classification.skillId, action: 'would-keep', reason: keptReason(classification) };
    });
}

/**
 * Removes every leftover retired skill copy that is byte-for-byte a copy Garda shipped.
 * Callers run it under the lifecycle lock, from an apply path that already holds a rollback
 * snapshot of `live/` or after its point of no return. Anything else is left exactly as it is.
 *
 * Each copy is first moved out of `live/skills` with one rename, so a failure leaves either the
 * intact copy or no copy, never a partial one. A rename failure keeps the copy and reports it;
 * a failure to delete the moved copy only leaves it under `runtime/`, where nothing reads it.
 * The moved copy is classified again before deletion; if it changed after the first check, it
 * is moved back and kept, or, if that fails, left in staging and reported, never deleted.
 */
export function removeShippedRetiredSkillCopies(
    targetRoot: string,
    bundleRoot: string,
    operations: RetiredSkillRemovalFileOperations = DEFAULT_FILE_OPERATIONS
): RetiredSkillCopyOutcome[] {
    const outcomes: RetiredSkillCopyOutcome[] = [];
    let liveChanged = false;
    for (const classification of classifyEach(bundleRoot)) {
        const { skillId } = classification;
        if ('inspectError' in classification) {
            outcomes.push({ skillId, action: 'kept', reason: `could not inspect (${classification.inspectError}); left intact and ignored` });
            continue;
        }
        if (classification.state === 'absent') {
            outcomes.push({ skillId, action: 'absent', reason: 'not present' });
            continue;
        }
        if (classification.state !== 'shipped' || !classification.binding) {
            outcomes.push({ skillId, action: 'kept', reason: keptReason(classification) });
            continue;
        }
        const stagingRoot = path.join(path.resolve(bundleRoot), 'runtime', 'retired-skill-removal');
        const stagedPath = path.join(stagingRoot, `${skillId}-${randomUUID()}`);
        try {
            ensureContainedDirectory(targetRoot, stagingRoot);
            bindContainedDestination(targetRoot, stagedPath);
            assertExistingPathIdentity(classification.binding);
            operations.rename(classification.skillRoot, stagedPath);
        } catch (error) {
            outcomes.push({ skillId, action: 'kept', reason: `could not remove (${errorCode(error)}); left intact and ignored` });
            continue;
        }
        liveChanged = true;
        const stagedRelative = path.relative(path.resolve(targetRoot), stagedPath).replace(/\\/g, '/');
        let staged: RetiredSkillCopyClassification | null = null;
        try {
            staged = classifyMovedRetiredSkillCopy(targetRoot, skillId, stagedPath);
        } catch {
            staged = null;
        }
        if (!staged || staged.state !== 'shipped') {
            // The copy changed between the first check and the move: it is not deleted.
            try {
                if (bindContainedDestination(targetRoot, classification.skillRoot).missingAt !== classification.skillRoot) {
                    throw new Error('live/skills entry was recreated');
                }
                operations.rename(stagedPath, classification.skillRoot);
                outcomes.push({ skillId, action: 'kept', reason: 'the copy changed during the update or setup; moved back to live/skills and kept, ignored and still content-scanned' });
            } catch (error) {
                outcomes.push({ skillId, action: 'kept', reason: `the copy changed during the update or setup; could not move it back (${errorCode(error)}), left intact at ${stagedRelative}` });
            }
            continue;
        }
        try {
            operations.removeStaged(targetRoot, stagedPath);
            outcomes.push({ skillId, action: 'removed', reason: classification.reason });
        } catch {
            outcomes.push({ skillId, action: 'removed', reason: `${classification.reason}; moved copy left at ${stagedRelative}` });
        }
    }
    // The skills headlines hash every live skill manifest, so refresh them whenever live/skills changed.
    if (liveChanged) writeSkillsIndex(bundleRoot);
    return outcomes;
}

const ACTION_LABELS: Record<RetiredSkillCopyAction, string> = {
    'removed': 'removed',
    'kept': 'kept',
    'absent': 'not present',
    'would-remove': 'would remove',
    'would-keep': 'would keep'
};

/** Human lines, one per retired id, e.g. `orchestration: removed (unmodified copy shipped by an earlier release)`. */
export function formatRetiredSkillCopyOutcomes(outcomes: readonly RetiredSkillCopyOutcome[]): string[] {
    return outcomes.map((outcome) => outcome.action === 'absent'
        ? `${outcome.skillId}: not present`
        : `${outcome.skillId}: ${ACTION_LABELS[outcome.action]} (${outcome.reason})`);
}
