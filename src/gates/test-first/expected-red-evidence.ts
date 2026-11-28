import * as path from 'node:path';
import { countNextStepWork } from '../../core/next-step-measurement';
import { readTaskQueueEntries } from '../../core/task-queue-read';
import { isPlainRecord } from '../../core/records';
import { readValidationFile } from '../../core/project-validation-identity';
import { ProjectValidationAuthorityError } from '../../core/project-validation-errors';
import { currentProjectValidationAuthority } from '../project-validation/authority';
import { readValidationEventSnapshot } from '../project-validation/attempt-evidence';
import { NativeCaseExecutionUnavailableError, readExpectedRedNativeCaseObligations } from '../review/native-case-semantics';
import type { QualityValidationObligation } from '../quality-checklist/quality-checklist-validation-phases';
import { hasTestFirstExpectedRedDeclaration } from './test-first-declaration';
import { readRecipeExpectedRedObligations, readRetainedRecipeExpectedRedRejection } from './expected-red-recipe-evidence';
import { projectExpectedRedExecutions, type ExpectedRedEvidenceOptions, type ExpectedRedExecutionEvidence } from './expected-red-native-projection';

export type { ExpectedRedExecutionEvidence } from './expected-red-native-projection';

export function taskRequiresExpectedRed(repoRoot: string, taskId: string): boolean {
    return hasTestFirstExpectedRedDeclaration(readTaskQueueEntries(repoRoot).get(taskId));
}

/** Capture precedes implementation; semantic acceptance belongs to the ordinary final review. */
export function readExpectedRedExecutionEvidence(options: ExpectedRedEvidenceOptions): ExpectedRedExecutionEvidence | null {
    return projectExpectedRedExecutions(options, true)?.evidence ?? null;
}

function projectExpectedRedReviewObligations(options: ExpectedRedEvidenceOptions,
    currentObligations: readonly QualityValidationObligation[] = []): QualityValidationObligation[] {
    const recipeRed = readRecipeExpectedRedObligations(options, currentObligations);
    const native = readExpectedRedNativeCaseObligations(options);
    if (native) return [...native, ...recipeRed];
    if (recipeRed.length) return recipeRed;
    throw new Error('Expected-RED evidence for the unchanged selected test sources is missing.');
}

export const EXPECTED_RED_RECOVERY = 'Record a fresh RED for the current test bytes when the implementation can still fail it, '
    + 'or with operator approval remove the `Test-first: expected-red` marker from TASK.md and continue the ordinary cycle; '
    + 'tests, compile, full suite and every required review remain mandatory. Do not use task-reset for this.';

export class ExpectedRedEvidenceError extends Error {
    constructor(message: string, readonly needsGreen = false) { super(message); }
}

function expectedRedError(error: unknown): ExpectedRedEvidenceError {
    return new ExpectedRedEvidenceError(`${String(error)} ${EXPECTED_RED_RECOVERY}`);
}

/** Diagnostics only: the existing projection still authenticates and selects every retained execution. */
export function readRetainedExpectedRedRejection(options: ExpectedRedEvidenceOptions): string | null {
    if (!taskRequiresExpectedRed(options.repoRoot, options.taskId)) return null;
    let snapshot: ReturnType<typeof readValidationEventSnapshot>;
    try { snapshot = readValidationEventSnapshot(options.repoRoot, options.taskId, options.inspection); }
    catch { return null; } // Startup/timeline failures retain their own blocking routes; no retained RED is proven here.
    try {
        const history = snapshot.events.filter(event => (countNextStepWork('visit:expected_red_event'), event.event_type === 'TEST_FIRST_EXPECTED_FAILURE_RECORDED'));
        if (!history.length || projectExpectedRedExecutions(options, false)) return null;
        const entry = snapshot.events.map(event => (countNextStepWork('visit:expected_red_event'), event.event_type)).lastIndexOf('TASK_MODE_ENTERED');
        const predatesEntry = history.every(event => (countNextStepWork('visit:expected_red_event'), snapshot.events.indexOf(event) < entry));
        return expectedRedError(`Retained expected-RED ${predatesEntry ? 'predates task re-entry' : 'is unavailable for the current selected sources'}: ${snapshot.changed_files.join(', ')}.`).message;
    } catch (error) { return expectedRedError(error).message; }
}

function rethrowCurrentAuthorityRejection(options: ExpectedRedEvidenceOptions, error: unknown): void {
    if (error instanceof ProjectValidationAuthorityError) throw error;
    let preflight: unknown;
    try {
        const relative = path.relative(options.repoRoot, path.resolve(options.repoRoot, options.preflightPath));
        const file = readValidationFile(options.repoRoot, relative.split(path.sep).join('/'));
        if (file.identity.sha256 !== options.preflightSha256) return;
        preflight = JSON.parse(file.bytes.toString('utf8'));
    }
    catch { return; } // An unreadable preflight keeps the original rejection below.
    if (!isPlainRecord(preflight) || preflight.task_id !== options.taskId) return;
    try { currentProjectValidationAuthority(options.repoRoot, preflight); }
    catch (authority) { if (authority instanceof ProjectValidationAuthorityError) throw authority; }
}

export function readExpectedRedReviewObligations(options: ExpectedRedEvidenceOptions,
    currentObligations: readonly QualityValidationObligation[] = []): QualityValidationObligation[] {
    try { return projectExpectedRedReviewObligations(options, currentObligations); }
    catch (error) {
        // Garda's typed authority rejection keeps its type: callers route it as such, never as a missing or stale RED.
        // A rejected current authority also governs every retained RED, so it is reported before their diagnostics.
        rethrowCurrentAuthorityRejection(options, error);
        const retainedRejection = readRetainedExpectedRedRejection(options);
        if (retainedRejection) throw new ExpectedRedEvidenceError(retainedRejection);
        const recipeRejection = readRetainedRecipeExpectedRedRejection(options);
        if (recipeRejection) throw expectedRedError(recipeRejection);
        if (error instanceof NativeCaseExecutionUnavailableError || /GREEN|successful execution/iu.test(String(error)))
            throw new ExpectedRedEvidenceError(`${String(error)} Run and record current passing focused tests (GREEN) for the unchanged selected cases, then retry review.`, true);
        throw expectedRedError(error);
    }
}

export function currentExpectedRedExecutionEvidence(repoRoot: string, taskId: string): ExpectedRedExecutionEvidence | null {
    if (!hasTestFirstExpectedRedDeclaration(readTaskQueueEntries(repoRoot).get(taskId))) return null;
    try {
        const snapshot = readValidationEventSnapshot(repoRoot, taskId);
        return readExpectedRedExecutionEvidence({ repoRoot, taskId, preflightPath: snapshot.preflight_path,
            preflightSha256: snapshot.preflight_sha256 });
    } catch { return null; }
}
