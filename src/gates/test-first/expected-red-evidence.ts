import * as fs from 'node:fs';
import * as path from 'node:path';
import { countNextStepWork } from '../../core/next-step-measurement';
import { readTaskQueueEntries } from '../../core/task-queue-read';
import { readTaskQueueStatusToken } from '../../core/task-queue/task-queue-status';
import { isPlainRecord } from '../../core/records';
import { readValidationFile, validationDigest } from '../../core/project-validation-identity';
import { ProjectValidationAuthorityError } from '../../core/project-validation-errors';
import { currentProjectValidationAuthority } from '../project-validation/authority';
import { assertCurrentIntermediateSelection, isIntermediateSelection, latestMatchingIntermediateAttempt,
    selectionMatchesCase } from '../../core/intermediate-selected-cases';
import { parseValidationReportFiles, type ValidationReportFile } from '../../core/validation-report-contract';
import { readValidationEventSnapshot } from '../project-validation/attempt-evidence';
import { NativeCaseExecutionUnavailableError, readExpectedRedNativeCaseObligations } from '../review/native-case-semantics';
import type { QualityValidationObligation } from '../quality-checklist/quality-checklist-validation-phases';
import { getCurrentIntermediateTestTargets } from '../../cli/commands/gate-flows/command-run/intermediate-command-scope';
import { requiredExpectedRedFiles, expectedRedInputFiles } from './expected-red-scope';
import { hasTestFirstExpectedRedDeclaration } from './test-first-declaration';
import { readRecipeExpectedRedObligations, readRecipeExpectedRedPreparation, readRetainedRecipeExpectedRedRejection } from './expected-red-recipe-evidence';
import { projectExpectedRedExecutions, type ExpectedRedEvidenceOptions, type ExpectedRedExecutionEvidence } from './expected-red-native-projection';

export type { ExpectedRedExecutionEvidence } from './expected-red-native-projection';

export function taskRequiresExpectedRed(repoRoot: string, taskId: string): boolean {
    return hasTestFirstExpectedRedDeclaration(readTaskQueueEntries(repoRoot).get(taskId));
}

/** Capture precedes implementation; semantic acceptance belongs to the ordinary final review. */
export function readExpectedRedExecutionEvidence(options: ExpectedRedEvidenceOptions): ExpectedRedExecutionEvidence | null {
    return projectExpectedRedExecutions(options, true)?.evidence ?? null;
}

/** Current-run RED preparation only; later GREEN and semantic review remain separate mandatory proofs. */
export function readExpectedRedPreparation(options: ExpectedRedEvidenceOptions): ExpectedRedExecutionEvidence | null {
    if (!taskRequiresExpectedRed(options.repoRoot, options.taskId)) return null;
    const snapshot = readValidationEventSnapshot(options.repoRoot, options.taskId, options.inspection);
    if (snapshot.preflight_sha256 !== options.preflightSha256
        || path.resolve(snapshot.preflight_path) !== path.resolve(options.repoRoot, options.preflightPath)) return null;
    const red = projectExpectedRedExecutions(options, false)?.evidence;
    const recipe = readRecipeExpectedRedPreparation(options);
    const obligations = [...(red?.obligations ?? []), ...recipe];
    if (!obligations.length) return null;
    const preflight = JSON.parse(readValidationFile(options.repoRoot,
        path.relative(options.repoRoot, path.resolve(options.repoRoot, options.preflightPath)).replace(/\\/gu, '/')).bytes.toString('utf8'));
    const inputs = new Set(expectedRedInputFiles(preflight, options.repoRoot));
    const required = requiredExpectedRedFiles(preflight, options.repoRoot).filter(file => typeof file !== 'string' || inputs.has(file));
    if (!required.length || !required.every(file => obligations.some(item => item.source_identity.path === file))) return null;
    if (readValidationEventSnapshot(options.repoRoot, options.taskId, options.inspection).timeline_sha256 !== snapshot.timeline_sha256)
        throw new Error('Expected-RED preparation changed during projection.');
    const value = { schema_version: 1 as const, task_id: options.taskId, preflight_sha256: snapshot.preflight_sha256,
        scope_content_sha256: snapshot.scope_content_sha256, obligations };
    return { ...value, sha256: validationDigest(value) };
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
    + 'under a genuine test-only preflight (an already passing implementation needs a legitimate test-only baseline; no automatic rewind), '
    + 'or with operator approval remove the `Test-first: expected-red` marker from TASK.md and continue the ordinary cycle; '
    + 'tests, compile, full suite and every required review remain mandatory. Do not use task-reset for this.';

export class ExpectedRedEvidenceError extends Error {
    constructor(message: string, readonly needsGreen = false) { super(message); }
}

function expectedRedError(error: unknown): ExpectedRedEvidenceError {
    const message = String(error);
    const sourceRecovery = /predates task re-entry|Selected command source identity is no longer current|Expected-RED test\/support input bytes or scope changed|Expected-RED evidence for the unchanged selected test sources is missing|is unavailable for the current selected sources/u.test(message);
    return new ExpectedRedEvidenceError(sourceRecovery ? `${message} ${EXPECTED_RED_RECOVERY}` : message);
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
    try { preflight = JSON.parse(fs.readFileSync(path.resolve(options.repoRoot, options.preflightPath), 'utf8')); }
    catch { return; } // An unreadable preflight keeps the original rejection below.
    if (!isPlainRecord(preflight)) return;
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

/** Authenticated invocation hint only; old execution and assertion semantics remain rejected. */
export interface FocusedCommandHint {
    command: string;
    cases: Array<{ source: string; case_id: string; selector: string }>;
    reports: ValidationReportFile[];
}
export function readFocusedCommandHint(repoRoot: string, taskId: string,
    options: { sources?: readonly string[]; cases?: readonly { source: string; case_id: string }[];
        expectedFailureOnly?: boolean } = {}): FocusedCommandHint | null {
    const status = readTaskQueueStatusToken(readTaskQueueEntries(repoRoot).get(taskId)?.status ?? null);
    if (status !== 'IN_PROGRESS' && status !== 'IN_REVIEW') return null;
    const snapshot = readValidationEventSnapshot(repoRoot, taskId);
    const preflight = JSON.parse(readValidationFile(repoRoot,
        path.relative(repoRoot, snapshot.preflight_path).replace(/\\/gu, '/')).bytes.toString('utf8'));
    const required = options.sources ?? requiredExpectedRedFiles(preflight, repoRoot).filter((file): file is string => typeof file === 'string');
    if (!required.length) return null;
    const cycle = snapshot.events.slice(snapshot.events.map(event => event.event_type).lastIndexOf('TASK_MODE_ENTERED') + 1);
    const attempts = cycle.filter(event => ['INTERMEDIATE_COMMAND_STARTED', 'INTERMEDIATE_COMMAND_RUN',
        'TEST_FIRST_EXPECTED_FAILURE_RECORDED'].includes(event.event_type));
    if (required.some(source => latestMatchingIntermediateAttempt(attempts, source)?.event_type === 'INTERMEDIATE_COMMAND_STARTED'))
        return null;
    for (const event of [...snapshot.events].reverse()) {
        const details = event.details;
        if (!(options.expectedFailureOnly ? event.event_type === 'TEST_FIRST_EXPECTED_FAILURE_RECORDED'
            : ['INTERMEDIATE_COMMAND_RUN', 'TEST_FIRST_EXPECTED_FAILURE_RECORDED'].includes(event.event_type))
            || details?.command_source !== 'targeted-test' || typeof details.command !== 'string'
            || typeof details.artifact_path !== 'string' || typeof details.artifact_sha256 !== 'string') continue;
        try {
            const retained = readValidationFile(repoRoot,
                path.relative(repoRoot, path.resolve(repoRoot, details.artifact_path)).replace(/\\/gu, '/'));
            if (retained.identity.sha256 !== details.artifact_sha256) continue;
            const record: unknown = JSON.parse(retained.bytes.toString('utf8'));
            if (!isPlainRecord(record) || record.task_id !== taskId || record.command !== details.command
                || record.command_source !== details.command_source
                || record.execution_id !== details.execution_id || !isPlainRecord(record.selected_case_binding)
                || !isIntermediateSelection(record.selected_case_binding.before)
                || validationDigest(record.selected_case_binding) !== validationDigest(details.selected_case_binding)) continue;
            assertCurrentIntermediateSelection(repoRoot, record.selected_case_binding, []);
            const selection = record.selected_case_binding.before;
            const start = snapshot.events.filter(item => item.event_type === 'INTERMEDIATE_COMMAND_STARTED'
                && item.details?.execution_id === record.execution_id);
            if (start.length !== 1 || start[0].details?.command !== details.command
                || start[0].details?.command_source !== details.command_source || start[0].details?.artifact_path !== details.artifact_path
                || Number(start[0].integrity?.task_sequence) >= Number(event.integrity?.task_sequence)
                || validationDigest(start[0].details?.selected_case_selection) !== validationDigest(selection)) continue;
            if (validationDigest(record.report_evidence ?? null) !== validationDigest(details.report_evidence ?? null)) continue;
            const reports = parseValidationReportFiles(isPlainRecord(record.report_evidence) ? record.report_evidence.declarations : undefined);
            const targets = getCurrentIntermediateTestTargets(repoRoot, details.command,
                [...new Set([...snapshot.changed_files, ...required])], selection);
            if (!required.every(source => targets.includes(source)) || options.cases?.some(claim =>
                !selectionMatchesCase(selection, claim.source, claim.case_id))) continue;
            return { command: details.command, cases: selection.cases, reports };
        } catch {
            // Unavailable historical metadata supplies no hint and never grants execution readiness.
        }
    }
    return null;
}
