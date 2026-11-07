import * as path from 'node:path';
import type { TrustBoundarySourceEvidence } from '../../core/trust-boundary-analysis';
import { MAX_BOUNDARY_SOURCE_REFERENCES, readBoundarySourceEvidence } from '../../core/trust-boundary-source-evidence';
import { readValidationFile, validationDigest } from '../../core/project-validation-identity';
import { MAX_RETAINED_VALIDATION_OUTPUT_BYTES, readRetainedValidationReports } from '../../core/validation-report-evidence';
import type { ValidationReportEvidenceBinding } from '../../core/validation-report-contract';
import { isPlainRecord } from '../../core/records';
import { assertCurrentIntermediateSelection, intermediateInvocationIdentity, intermediateSourcePathKey, latestMatchingIntermediateAttempt, selectionMatchesCase } from '../../core/intermediate-selected-cases';
import type { QualityValidationObligation } from '../quality-checklist/quality-checklist-validation-phases';
import { validationPaths } from '../project-validation/authority';
import type { ValidationEvidenceInspection } from '../project-validation/attempt-evidence';
import { readTaskOwnedIntermediateExecutionEvidence } from './focused-intermediate-evidence';
import { iterateRemediationOriginCandidates } from '../review-remediation/review-remediation-origin';
import { collectRemediationLaneHistory } from '../review-remediation/review-remediation-scope-review-types';
import { validateReviewRemediationBaselineArtifact } from '../review-remediation/review-remediation-baseline';
import { resolveFailedReviewTaskCriteriaChange } from '../review-remediation/review-remediation-task-criteria';

const MAX_CONTROL_BYTES = 8 * 1024 * 1024;
const MAX_QUOTE_CHARS = 4096;
const MAX_REASON_CHARS = 8192;
const HASH = /^[a-f0-9]{64}$/u;

export class NativeCaseExecutionUnavailableError extends Error {
    constructor(readonly violations: readonly string[]) {
        super(`Current selected case execution is missing or rejected: ${violations.join(' ')} `
            + 'Run gate run-intermediate-command --task-id "<task-id>" --command-source targeted-test '
            + '--command "<task-test-command>" --preflight-path "<current-preflight>" '
            + '--selected-case \'{"source":"<target>","case_id":"<case>","selector":"<exact selector>"}\'.');
    }
}

export interface NativeCaseExecution {
    record_path: string; record_sha256: string; output_path: string; output_sha256: string;
    output_size_bytes: number; output_encoding: 'utf8' | 'base64-streams';
    event_task_sequence: number; scope_content_sha256: string;
    report_evidence?: ValidationReportEvidenceBinding;
    expected_failure?: true;
    exit_code?: number;
}
export interface NativeCaseResolution {
    binding_sha256: string; execution_sha256: string; output_sha256: string;
    outcome: 'PASSED' | 'FAILED' | 'SKIPPED' | 'UNRESOLVED';
    failure_kind?: 'ASSERTION' | 'PROCESS' | 'DEPENDENCY' | 'UNKNOWN';
    evidence_quote: string; reasoning: string;
}

/** Retain semantic facts actually accepted by an authenticated independent PASS. This never supplies
 * current process evidence: the caller must first authenticate the latest matching successful run.
 */
function readReviewedSemanticBindings(repoRoot: string, taskId: string, reviewTypes: string[], taskIntent: string): QualityValidationObligation[] {
    const candidates = iterateRemediationOriginCandidates({ repoRoot, taskId, requiredReviewTypes: reviewTypes,
        mayIncludeBaseline: baseline => {
            const coverage = isPlainRecord(baseline) && isPlainRecord(baseline.origin_coverage_contract)
                ? baseline.origin_coverage_contract : null;
            return Array.isArray(coverage?.obligations) && coverage.obligations.some(obligation =>
                isPlainRecord(obligation) && isPlainRecord(obligation.validation_binding)
                && isPlainRecord(obligation.validation_binding.case_execution)
                && !obligation.validation_binding.case_execution.expected_failure);
        } });
    const history = collectRemediationLaneHistory({ repoRoot, taskId });
    for (const candidate of candidates) {
        if (candidate.failed) continue;
        const details = history.lanes.get(candidate.reviewType)?.details;
        const hash = String(details?.remediation_baseline_snapshot_sha256 ?? '');
        const baseline = validateReviewRemediationBaselineArtifact({
            artifactPath: path.resolve(repoRoot, String(details?.remediation_baseline_snapshot_path ?? '')),
            expectedArtifactSha256: hash, expectedTaskId: taskId, expectedReviewType: candidate.reviewType });
        if (!baseline.valid || !baseline.artifact || resolveFailedReviewTaskCriteriaChange({ repoRoot, taskId,
            baseline: baseline.artifact, baselineSha256: hash, currentTaskIntent: taskIntent }) !== false) continue;
        const bindings = baseline.artifact.origin_coverage_contract?.obligations.flatMap(obligation =>
            obligation.validation_binding?.case_execution && !obligation.validation_binding.case_execution.expected_failure
                ? [obligation.validation_binding] : []) ?? [];
        if (bindings.length) return bindings;
    }
    return [];
}

export function readNativeCaseObligations(options: {
    repoRoot: string; taskId: string; preflightPath: string; preflightSha256: string;
    scopeContentSha256: string; sources: readonly TrustBoundarySourceEvidence[];
    inspection?: ValidationEvidenceInspection;
    preserveSemanticBinding?: boolean;
    requiredCommandByCase?: ReadonlyMap<string, string>;
}): QualityValidationObligation[] {
    if (!options.sources.length) return [];
    const timelinePath = validationPaths(options.repoRoot, options.taskId).timeline;
    const timeline = readValidationFile(options.repoRoot, timelinePath, MAX_CONTROL_BYTES);
    const root = path.join(options.repoRoot, path.dirname(timelinePath));
    const proof = readTaskOwnedIntermediateExecutionEvidence({ repoRoot: options.repoRoot, taskId: options.taskId,
        reviewsRoot: path.join(root, '../reviews'), eventsRoot: root, inspection: options.inspection,
        expectedPreflightPath: options.preflightPath, expectedPreflightSha256: options.preflightSha256,
        expectedScopeContentSha256: options.scopeContentSha256, maxTimelineBytes: MAX_CONTROL_BYTES,
        maxTimelineEvents: 10_000, maxEntries: MAX_BOUNDARY_SOURCE_REFERENCES,
        maxIntermediateCandidatesScanned: 1024 });
    const events = timeline.bytes.toString('utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line)).reverse();
    if (!proof.entries.length) {
        const boundary = proof.carried_task_mode_sequence ?? proof.latest_task_mode_sequence;
        const hasCurrentAttempt = boundary != null && events.some(event =>
            ['INTERMEDIATE_COMMAND_RUN', 'INTERMEDIATE_COMMAND_STARTED'].includes(event.event_type)
            && event.task_id === options.taskId && event.integrity?.task_sequence > boundary);
        // An older adoption has no carry authority. Its historical runs stay stale, while an unattempted
        // current check remains executable PENDING work rather than rejected current evidence.
        throw new NativeCaseExecutionUnavailableError(boundary != null && !hasCurrentAttempt ? [] : proof.warnings);
    }
    const attempts = events.filter(event => ['INTERMEDIATE_COMMAND_RUN', 'INTERMEDIATE_COMMAND_STARTED', 'TEST_FIRST_EXPECTED_FAILURE_RECORDED'].includes(event.event_type)
        && event.task_id === options.taskId && event.details?.command_source !== 'typecheck'
        && (proof.carried_task_mode_sequence !== undefined || event.details?.preflight_sha256 === options.preflightSha256)
        && event.integrity?.task_sequence > (proof.carried_task_mode_sequence ?? proof.latest_task_mode_sequence ?? Infinity));
    const sources = readBoundarySourceEvidence({ repoRoot: options.repoRoot,
        references: options.sources.map(source => ({ filePath: source.source_identity.path, caseId: source.case_id })),
        expectedSources: [...new Map(options.sources.map(source => [source.source_identity.path, source.source_identity])).values()] });
    if (sources.violations.length) throw new Error(sources.violations.join(' '));
    let reviewedBindings: QualityValidationObligation[] | undefined;
    const obligations = sources.sourceEvidence.map(source => {
        const requiredCommand = options.requiredCommandByCase?.get(JSON.stringify([source.source_identity.path, source.case_id]));
        const matchingAttempts = requiredCommand ? attempts.filter(event =>
            intermediateInvocationIdentity(event.details?.command) === requiredCommand) : attempts;
        const latestRun = latestMatchingIntermediateAttempt(matchingAttempts, source.source_identity.path, source.case_id);
        const latest = proof.entries.find(entry => entry.command_source !== 'typecheck'
            && entry.event_task_sequence === latestRun?.integrity?.task_sequence);
        if (!latest) throw new NativeCaseExecutionUnavailableError([
            `The latest matching command for ${source.source_identity.path} / ${source.case_id} is not an authenticated successful execution.`]);
        const validateSelection = (entry: typeof latest) => {
            if (!entry.selected_case_binding) return;
            assertCurrentIntermediateSelection(options.repoRoot, entry.selected_case_binding, [source.source_identity.path]);
            const start = attempts.find(event => event.event_type === 'INTERMEDIATE_COMMAND_STARTED'
                && event.details.execution_id === entry.execution_id
                && event.integrity.task_sequence < entry.event_task_sequence);
            const run = attempts.find(event => event.integrity?.task_sequence === entry.event_task_sequence);
            if (!start || start.details.command !== entry.command
                || start.details.artifact_path !== run?.details.artifact_path
                || validationDigest(start.details.selected_case_selection) !== validationDigest(entry.selected_case_binding.before)
                || validationDigest(start.details.report_evidence ?? null) !== validationDigest(entry.report_evidence ?? null)
                || !selectionMatchesCase(entry.selected_case_binding.before, source.source_identity.path, source.case_id)
                || !entry.selected_case_binding.before.sources.some(identity => validationDigest(identity) === validationDigest(source.source_identity)))
                throw new NativeCaseExecutionUnavailableError(['Selected execution source/start binding is missing or foreign.']);
        };
        validateSelection(latest);
        if (options.preserveSemanticBinding && reviewedBindings === undefined) {
            const reviewTypes = [...new Set(events.filter(event => event.event_type === 'REVIEW_RECORDED')
                .map(event => String(event.details?.review_type ?? '')).filter(Boolean))];
            const preflight = JSON.parse(readValidationFile(options.repoRoot,
                path.relative(options.repoRoot, options.preflightPath).replace(/\\/gu, '/')).bytes.toString('utf8'));
            reviewedBindings = reviewTypes.length ? readReviewedSemanticBindings(options.repoRoot, options.taskId,
                reviewTypes, String(preflight.effective_review_snapshot?.inputs?.task_intent ?? preflight.task_intent ?? '')) : [];
        }
        const reviewed = reviewedBindings?.find(binding => binding.target_id === source.case_id
            && validationDigest(binding.source_identity) === validationDigest(source.source_identity)
            && binding.case_execution?.scope_content_sha256 === options.scopeContentSha256
            && (!requiredCommand || events.some(event => event.integrity?.task_sequence === binding.case_execution?.event_task_sequence
                && intermediateInvocationIdentity(event.details?.command) === requiredCommand)));
        if (reviewed?.case_execution) {
            const execution = reviewed.case_execution;
            const retained = readValidationFile(options.repoRoot, path.relative(options.repoRoot,
                path.resolve(options.repoRoot, execution.record_path)).replace(/\\/gu, '/'), MAX_CONTROL_BYTES);
            if (retained.identity.sha256 !== execution.record_sha256)
                throw new Error('Retained reviewed execution record changed.');
            retainedNativeCaseOutput(options.repoRoot, execution);
            const record = JSON.parse(retained.bytes.toString('utf8')) as Record<string, unknown>;
            if (record.selected_case_binding !== undefined) {
                assertCurrentIntermediateSelection(options.repoRoot, record.selected_case_binding, []);
                const outputs = new Set(execution.report_evidence?.declarations.map(report => intermediateSourcePathKey(report.path)) ?? []);
                assertCurrentIntermediateSelection(options.repoRoot, record.selected_case_binding,
                    record.selected_case_binding.before.sources.filter(input => !outputs.has(intermediateSourcePathKey(input.path))).map(input => input.path));
            }
            return structuredClone(reviewed);
        }
        // A successful rerun proves current execution, but does not invalidate an independent review
        // of the same unchanged source/case. Keep its retained semantic evidence, after checking latest.
        const anchor = options.preserveSemanticBinding && proof.carried_preflight_sha256
            ? proof.entries.find(entry => entry.preflight_sha256 === proof.carried_preflight_sha256
                && entry.command === latest.command && entry.command_source === latest.command_source
                && (!entry.selected_case_binding || selectionMatchesCase(entry.selected_case_binding.before,
                    source.source_identity.path, source.case_id))) : undefined;
        const selected = anchor ?? latest;
        validateSelection(selected);
        const execution: NativeCaseExecution = { record_path: selected.artifact_path, record_sha256: selected.artifact_sha256,
            output_path: selected.output_artifact_path, output_sha256: selected.output_artifact_sha256,
            output_size_bytes: selected.output_artifact_size_bytes, output_encoding: selected.output_encoding ?? 'utf8',
            ...(selected.report_evidence ? { report_evidence: selected.report_evidence } : {}),
            event_task_sequence: selected.event_task_sequence, scope_content_sha256: options.scopeContentSha256 };
        // Retain the original obligation/coverage binding when the authenticated execution was carried.
        const bindingPreflight = selected.event_task_sequence <= (proof.latest_task_mode_sequence ?? -1)
            ? selected.preflight_sha256! : options.preflightSha256;
        const binding = { task_id: options.taskId, preflight_sha256: bindingPreflight,
            source_identity: source.source_identity, case_id: source.case_id, case_execution: execution };
        return { id: validationDigest(binding), recipe_id: 'native-task-command', target_id: source.case_id,
            selector: source.case_id, source_identity: source.source_identity, snapshot_sha256: bindingPreflight,
            execution: 'OBSERVED' as const, attempt_id: selected.artifact_sha256, result_status: 'UNRESOLVED',
            result_sha256: null, case_execution: { ...execution } };
    });
    if (new Set(obligations.map(item => item.id)).size !== obligations.length)
        throw new Error('Native case source references are ambiguous.');
    if (readValidationFile(options.repoRoot, timelinePath, MAX_CONTROL_BYTES).identity.sha256 !== timeline.identity.sha256)
        throw new Error('Native case timeline changed during projection.');
    const preflightRelative = path.relative(path.resolve(options.repoRoot),
        path.resolve(options.repoRoot, options.preflightPath)).replace(/\\/gu, '/');
    if (readValidationFile(options.repoRoot, preflightRelative, MAX_CONTROL_BYTES).identity.sha256 !== options.preflightSha256)
        throw new Error('Native case preflight changed during projection.');
    return obligations;
}

function withinCharacterLimit(value: string, maximum: number): boolean {
    const characters = value[Symbol.iterator]();
    let count = 0;
    while (!characters.next().done) if (++count > maximum) return false;
    return true;
}

function resolutionShape(value: unknown): value is NativeCaseResolution {
    if (!isPlainRecord(value) || Object.keys(value).some(key => !['binding_sha256', 'execution_sha256',
        'output_sha256', 'outcome', 'failure_kind', 'evidence_quote', 'reasoning'].includes(key))) return false;
    return ['binding_sha256', 'execution_sha256', 'output_sha256'].every(key =>
        typeof value[key] === 'string' && HASH.test(value[key] as string))
        && typeof value.outcome === 'string'
        && ['PASSED', 'FAILED', 'SKIPPED', 'UNRESOLVED'].includes(value.outcome)
        && (value.failure_kind === undefined || value.outcome === 'FAILED'
            && ['ASSERTION', 'PROCESS', 'DEPENDENCY', 'UNKNOWN'].includes(String(value.failure_kind)))
        && typeof value.evidence_quote === 'string' && withinCharacterLimit(value.evidence_quote, MAX_QUOTE_CHARS)
        && typeof value.reasoning === 'string' && !!value.reasoning.trim() && withinCharacterLimit(value.reasoning, MAX_REASON_CHARS);
}

export function retainedNativeCaseOutput(repoRoot: string, execution: NativeCaseExecution): { text: string; relative: string } {
    const relative = path.relative(path.resolve(repoRoot), path.resolve(repoRoot, execution.output_path)).replace(/\\/gu, '/');
    const file = readValidationFile(repoRoot, relative, MAX_RETAINED_VALIDATION_OUTPUT_BYTES);
    if (file.identity.sha256 !== execution.output_sha256 || file.bytes.length !== execution.output_size_bytes)
        throw new Error('Native case output identity changed.');
    if (execution.output_encoding === 'utf8') {
        if (execution.report_evidence) throw new Error('Report evidence requires its retained capture envelope.');
        return { text: file.bytes.toString('utf8'), relative };
    }
    if (execution.output_encoding !== 'base64-streams') throw new Error('Unknown native output encoding.');
    const streams: unknown = JSON.parse(file.bytes.toString('utf8'));
    if (!isPlainRecord(streams)) throw new Error('Native output streams are malformed.');
    const decoded = ['stdout_base64', 'stderr_base64'].map(key => {
        if (typeof streams[key] !== 'string') throw new Error('Native output stream is missing.');
        const bytes = Buffer.from(streams[key] as string, 'base64');
        if (bytes.toString('base64') !== streams[key]) throw new Error('Native output encoding is not canonical.');
        return bytes.toString('utf8');
    });
    const reports = readRetainedValidationReports({ repoRoot, capture: streams.report_capture,
        declarations: execution.report_evidence?.declarations,
        expectedStartSha256: execution.report_evidence?.start_sha256 ?? null,
        evidenceDirectory: execution.report_evidence?.evidence_directory ?? path.posix.dirname(relative), executionViolations: [] });
    return { text: [...decoded, ...reports.texts].join('\n'), relative };
}

/** Binding/quotation validation does not interpret a report format or decide case semantics. */
export function getNativeCaseResolutionViolations(options: {
    obligations: readonly QualityValidationObligation[];
    entries: readonly { obligation_id: string; case_resolution?: unknown }[];
    repoRoot?: string; requirePassed?: boolean; requireExpectedRed?: boolean;
}): string[] {
    const nativeBindings = options.obligations.filter(binding => binding.case_execution);
    if (nativeBindings.length > MAX_BOUNDARY_SOURCE_REFERENCES) return ['Native case obligations exceed their bound.'];
    if (nativeBindings.length === 0) return [];
    if ((options.requirePassed || options.requireExpectedRed) && !options.repoRoot)
        return ['Native case terminal closure requires actual retained source, record and output inspection.'];
    const violations: string[] = [], outputs = new Map<string, { text: string; relative: string; digest: string }>();
    const sources = new Map<string, string>();
    const records = new Map<string, string>();
    const entriesById = new Map<string, typeof options.entries[number][]>();
    const expectedExecutions = new Set<string>(), assertionFailures = new Set<string>();
    for (const entry of options.entries) {
        const matches = entriesById.get(entry.obligation_id) ?? [];
        matches.push(entry); entriesById.set(entry.obligation_id, matches);
    }
    for (const binding of nativeBindings) {
        const execution = binding.case_execution;
        if (!execution) continue;
        const id = `VALIDATION-${binding.id.toUpperCase()}`;
        const matches = entriesById.get(id) ?? [];
        const resolution = matches[0]?.case_resolution;
        if (matches.length !== 1 || !resolutionShape(resolution)) {
            if (matches.length === 1 && isPlainRecord(resolution) && typeof resolution.evidence_quote === 'string'
                && !withinCharacterLimit(resolution.evidence_quote, MAX_QUOTE_CHARS)) {
                violations.push(`${id}: evidence_quote has ${Array.from(resolution.evidence_quote).length} characters; the limit is ${MAX_QUOTE_CHARS}.`);
            } else violations.push(`${id}: current independent case resolution is missing or malformed.`);
            continue;
        }
        if (resolution.binding_sha256 !== validationDigest(binding) || resolution.execution_sha256 !== execution.record_sha256
            || resolution.output_sha256 !== execution.output_sha256 || binding.execution !== 'OBSERVED')
            violations.push(`${id}: independent case resolution has foreign source/execution/output bindings.`);
        if (options.requirePassed && resolution.outcome !== 'PASSED')
            violations.push(`${id}: selected case remains ${resolution.outcome}; source coverage is not result closure.`);
        if (options.requirePassed && execution.expected_failure)
            violations.push(`${id}: expected-red evidence cannot close final GREEN validation.`);
        if (options.requireExpectedRed) {
            expectedExecutions.add(execution.record_sha256);
            if (!execution.expected_failure || !Number.isSafeInteger(execution.exit_code) || Number(execution.exit_code) <= 0)
                violations.push(`${id}: expected-red semantics require an actual authenticated nonzero execution.`);
            if (resolution.outcome === 'FAILED' && resolution.failure_kind === 'ASSERTION') assertionFailures.add(execution.record_sha256);
            else if (resolution.outcome !== 'PASSED')
                violations.push(`${id}: ${resolution.outcome}/${resolution.failure_kind ?? 'UNKNOWN'} is not a resolved assertion result.`);
        }
        if (resolution.outcome === 'UNRESOLVED') continue;
        if (!resolution.evidence_quote.trim()) {
            violations.push(`${id}: a resolved outcome requires actual retained output evidence.`); continue;
        }
        if (!options.repoRoot) continue; // Structural schema/unit inspection; native consumers supply repoRoot.
        try {
            const record = path.relative(path.resolve(options.repoRoot),
                path.resolve(options.repoRoot, execution.record_path)).replace(/\\/gu, '/');
            if (!records.has(record)) records.set(record,
                readValidationFile(options.repoRoot, record, MAX_CONTROL_BYTES).identity.sha256);
            if (records.get(record) !== execution.record_sha256) throw new Error('Native case execution record changed.');
            const source = binding.source_identity;
            const expected = validationDigest(source);
            if (!sources.has(source.path)) sources.set(source.path,
                validationDigest(readValidationFile(options.repoRoot, source.path, MAX_CONTROL_BYTES).identity));
            if (sources.get(source.path) !== expected) throw new Error('Native case source identity changed.');
            const key = validationDigest(execution);
            if (!outputs.has(key)) outputs.set(key, { ...retainedNativeCaseOutput(options.repoRoot, execution), digest: execution.output_sha256 });
            if (!outputs.get(key)!.text.includes(resolution.evidence_quote))
                violations.push(`${id}: the independent quotation is absent from actual retained output. Use one contiguous excerpt of the retained output.`);
        } catch (error) { violations.push(`${id}: retained case evidence rejected: ${String(error)}`); }
    }
    if (options.requireExpectedRed && [...expectedExecutions].some(execution => !assertionFailures.has(execution)))
        violations.push('Expected-red review must independently identify an actual assertion failure in each retained failing execution.');
    for (const output of outputs.values()) {
        try {
            if (readValidationFile(options.repoRoot!, output.relative, MAX_RETAINED_VALIDATION_OUTPUT_BYTES).identity.sha256 !== output.digest)
                violations.push('Native case output changed during batched resolution inspection.');
        } catch (error) { violations.push(`Native case output recheck rejected: ${String(error)}`); }
    }
    for (const [relative, digest] of sources) {
        try {
            if (validationDigest(readValidationFile(options.repoRoot!, relative, MAX_CONTROL_BYTES).identity) !== digest)
                violations.push('Native case source changed during batched resolution inspection.');
        } catch (error) { violations.push(`Native case source recheck rejected: ${String(error)}`); }
    }
    for (const [relative, digest] of records) {
        try {
            if (readValidationFile(options.repoRoot!, relative, MAX_CONTROL_BYTES).identity.sha256 !== digest)
                violations.push('Native case execution record changed during batched resolution inspection.');
        } catch (error) { violations.push(`Native case execution recheck rejected: ${String(error)}`); }
    }
    return violations;
}
