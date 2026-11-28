import * as path from 'node:path';
import { readValidationFile, validationDigest } from '../../core/project-validation-identity';
import type { TaskValidationProcessEvidence } from '../../core/task-validation-plan';
import type { ValidationReportCapture, ValidationReportEvidenceBinding, ValidationReportFile } from '../../core/validation-report-contract';
import { MAX_RETAINED_VALIDATION_OUTPUT_BYTES, readRetainedValidationReports } from '../../core/validation-report-evidence';
import type { FullSuiteReportAttempt } from '../full-suite/full-suite-report-evidence';
import { taskTestAdapterReportsCoverTargets } from '../full-suite/task-test-execution-proof';

export interface FullSuiteReportDeclarations {
    command: string;
    targets: readonly string[];
    reportFiles: readonly ValidationReportFile[];
}

function captureMatchesRun(capture: ValidationReportCapture, process: TaskValidationProcessEvidence | undefined): boolean {
    const started = Date.parse(capture.start.started_at);
    const completed = Date.parse(capture.completed_at);
    if (!Array.isArray(capture.execution_ids) || !capture.execution_ids.length || !process?.invocations.length)
        return false;
    const ids = new Set(capture.execution_ids);
    const invocations = process.invocations.filter(invocation => ids.has(invocation.execution_id));
    if (ids.size !== capture.execution_ids.length || invocations.length !== ids.size
        || new Set(invocations.map(invocation => invocation.execution_id)).size !== ids.size) return false;
    const windows = invocations.map(invocation => {
        const invocationStart = Date.parse(invocation.started_at);
        const invocationEnd = Date.parse(invocation.completed_at);
        if (!(started <= invocationStart && invocationStart <= invocationEnd && invocationEnd <= completed)
            || invocation.exit_code !== 0 || invocation.timed_out || invocation.cancelled) throw new Error('Invalid report process window.');
        return { start: BigInt(invocationStart) * 1_000_000n, end: BigInt(invocationEnd) * 1_000_000n };
    });
    return capture.reports.every(({ observation }) => {
        const modified = BigInt(observation.modified_ns);
        const changed = BigInt(observation.changed_ns);
        return windows.some(({ start, end }) => start <= modified && modified <= end && start <= changed && changed <= end);
    });
}

function addCaptureHashes(repoRoot: string, capture: ValidationReportCapture, binding: ValidationReportEvidenceBinding,
    hashes: Map<string, string>): void {
    readRetainedValidationReports({ repoRoot, capture, declarations: binding.declarations,
        evidenceDirectory: binding.evidence_directory, expectedStartSha256: binding.start_sha256, executionViolations: [] });
    for (const { observation: { identity } } of capture.reports) {
        if (hashes.has(identity.path) && hashes.get(identity.path) !== identity.sha256)
            throw new Error('Captures disagree on the bytes of the same report.');
        hashes.set(identity.path, identity.sha256);
    }
}

/** Compare only complete, run-owned retained report bytes, keyed by their declared paths. */
export function fullSuiteReportIdentity(repoRoot: string, declarations: FullSuiteReportDeclarations, options: {
    attempts?: readonly FullSuiteReportAttempt[];
    adapterCaptures?: readonly ValidationReportCapture[];
    process?: TaskValidationProcessEvidence;
}): Map<string, string> | null {
    try {
        const hashes = new Map<string, string>();
        for (const capture of options.adapterCaptures ?? []) {
            if (!captureMatchesRun(capture, options.process)) return null;
            addCaptureHashes(repoRoot, capture, { declarations: capture.start.declarations,
                start_sha256: validationDigest(capture.start), evidence_directory: path.posix.dirname(capture.start.anchor.identity.path) }, hashes);
        }
        if (options.adapterCaptures?.length && !taskTestAdapterReportsCoverTargets(declarations.command, declarations.targets, hashes))
            return null;

        // The final attempt must cover the configured declarations independently of the adapter captures.
        const attempt = options.attempts?.at(-1);
        if ((options.attempts && !attempt) || Boolean(attempt) !== (declarations.reportFiles.length > 0)) return null;
        if (attempt) {
            if (attempt.violations.length > 0) return null;
            const declaredPaths = new Set(attempt.report_evidence.declarations.map(report => report.path));
            if (declaredPaths.size !== declarations.reportFiles.length
                || declarations.reportFiles.some(report => !declaredPaths.has(report.path))) return null;
            const output = readValidationFile(repoRoot, attempt.output_path, MAX_RETAINED_VALIDATION_OUTPUT_BYTES);
            if (output.identity.sha256 !== attempt.output_sha256 || output.bytes.length !== attempt.output_bytes) return null;
            const { report_capture: capture } = JSON.parse(output.bytes.toString('utf8')) as { report_capture: ValidationReportCapture };
            if (!captureMatchesRun(capture, options.process)) return null;
            addCaptureHashes(repoRoot, capture, attempt.report_evidence, hashes);
        }
        return hashes.size ? hashes : null;
    } catch {
        return null;
    }
}
