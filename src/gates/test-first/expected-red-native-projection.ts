import * as path from 'node:path';
import { countNextStepWork } from '../../core/next-step-measurement';
import { readTaskQueueEntries } from '../../core/task-queue-read';
import { isPlainRecord } from '../../core/records';
import { createTaskTestScopeMatcher } from '../../core/file-role-bindings';
import { resolveReviewReuseClassificationConfig } from '../review-reuse/review-reuse';
import { readValidationFile, validationDigest } from '../../core/project-validation-identity';
import { assertCurrentIntermediateSelection, isIntermediateSelection, latestMatchingIntermediateAttempt } from '../../core/intermediate-selected-cases';
import { readValidationEventSnapshot, type ValidationEvidenceInspection } from '../project-validation/attempt-evidence';
import { readBoundIntermediateCommandEvidence } from '../review/focused-intermediate-evidence';
import { readPolicyValidationCarry } from '../review/policy-validation-carry';
import { requiredExpectedRedFiles, isExpectedRedTestScope } from './expected-red-scope';
import type { QualityValidationObligation } from '../quality-checklist/quality-checklist-validation-phases';
import { getCurrentIntermediateTestTargets } from '../../cli/commands/gate-flows/command-run/intermediate-command-scope';
import { hasTestFirstExpectedRedDeclaration } from './test-first-declaration';
import { loadTaskFullSuiteConfig } from '../full-suite/task-full-suite-config';
import { containsCaseIdentifier, decodeBoundarySource } from '../../core/trust-boundary-source-evidence';

import type { NativeCaseExecution } from '../review/native-case-semantics';

export interface ExpectedRedExecutionEvidence {
    schema_version: 1;
    task_id: string;
    preflight_sha256: string;
    scope_content_sha256: string;
    obligations: QualityValidationObligation[];
    sha256: string;
}

/** A current execution projection; assertion semantics remain pending the ordinary independent review. */
export interface ExpectedRedEvidenceOptions {
    repoRoot: string; taskId: string; preflightPath: string; preflightSha256: string | null;
    inspection?: ValidationEvidenceInspection;
}

export function projectExpectedRedExecutions(options: ExpectedRedEvidenceOptions, currentOnly: boolean): {
    evidence: ExpectedRedExecutionEvidence; fileOnlyCases: ReadonlySet<string>; timelineSha256: string;
} | null {
    if (!options.preflightSha256 || !hasTestFirstExpectedRedDeclaration(readTaskQueueEntries(options.repoRoot).get(options.taskId)))
        return null;
    const relative = path.relative(path.resolve(options.repoRoot), path.resolve(options.repoRoot, options.preflightPath)).replace(/\\/gu, '/');
    const retained = readValidationFile(options.repoRoot, relative);
    const preflight: unknown = JSON.parse(retained.bytes.toString('utf8'));
    if (retained.identity.sha256 !== options.preflightSha256 || !isPlainRecord(preflight)
        || preflight.task_id !== options.taskId || currentOnly && !isExpectedRedTestScope(preflight, options.repoRoot, options.taskId)) return null;
    const snapshot = readValidationEventSnapshot(options.repoRoot, options.taskId, options.inspection);
    if (snapshot.preflight_sha256 !== options.preflightSha256
        || path.resolve(snapshot.preflight_path) !== path.resolve(options.repoRoot, options.preflightPath)) return null;
    const carry = readPolicyValidationCarry(options.repoRoot, options.taskId, snapshot);
    const cycle = carry ? snapshot.events.filter(event => (countNextStepWork('visit:expected_red_event'),
        Number(event.integrity?.task_sequence) > carry.source_mode_sequence))
        : snapshot.events.slice(snapshot.events.map(event => (countNextStepWork('visit:expected_red_event'), event.event_type)).lastIndexOf('TASK_MODE_ENTERED') + 1);
    const attempts = cycle.filter(event => (countNextStepWork('visit:expected_red_event'), ['INTERMEDIATE_COMMAND_RUN', 'INTERMEDIATE_COMMAND_STARTED',
        'TEST_FIRST_EXPECTED_FAILURE_RECORDED'].includes(event.event_type)
        && (!currentOnly || event.details?.preflight_sha256 === (carry?.source_preflight_sha256 ?? snapshot.preflight_sha256)
            && Number(event.integrity?.task_sequence) > (carry?.source_preflight_sequence ?? snapshot.preflight_sequence))));
    const redIds = new Set(attempts.filter(event => (countNextStepWork('visit:expected_red_event'), event.event_type === 'TEST_FIRST_EXPECTED_FAILURE_RECORDED'))
        .map(event => (countNextStepWork('visit:expected_red_event'), event.details?.execution_id)));
    const redAttempts = attempts.filter(event => (countNextStepWork('visit:expected_red_event'), event.event_type === 'TEST_FIRST_EXPECTED_FAILURE_RECORDED'
        || event.event_type === 'INTERMEDIATE_COMMAND_STARTED'
            && (event.details?.expected_failure === true || redIds.has(event.details?.execution_id))));
    const relevantAttempts = currentOnly ? attempts : redAttempts;
    const classification = resolveReviewReuseClassificationConfig(preflight, options.repoRoot);
    const isTaskTest = createTaskTestScopeMatcher(classification.test_trigger_regexes, classification.file_roles,
        Array.isArray(preflight.declared_test_paths) ? preflight.declared_test_paths.filter((file): file is string => typeof file === 'string') : []);
    const obligations = new Map<string, QualityValidationObligation>();
    const fileOnlyCases = new Set<string>();
    for (const event of [...attempts].reverse()) {
        countNextStepWork('visit:expected_red_event');
        if (event.event_type !== 'TEST_FIRST_EXPECTED_FAILURE_RECORDED') continue;
        const recordedBinding = event.details?.selected_case_binding;
        const observed = isPlainRecord(recordedBinding) ? recordedBinding.before : undefined;
        if (isIntermediateSelection(observed)) {
            const claims = observed.cases.length ? observed.cases
                : observed.sources.map(source => (countNextStepWork('visit:expected_red_source'), ({ source: source.path, case_id: undefined })));
            if (!claims.some(claim => (countNextStepWork('visit:expected_red_case'), snapshot.changed_files.includes(claim.source)
                && latestMatchingIntermediateAttempt(relevantAttempts, claim.source, claim.case_id) === event))) continue;
        }
        const originalScope = String(event.details?.test_scope_sha256 ?? '');
        const { entry, violation } = readBoundIntermediateCommandEvidence({ ...options, event, expectedFailure: true,
            policyCarry: carry ?? undefined,
            reviewsRoot: path.dirname(snapshot.preflight_path), executionOnly: true,
            expectedPreflightPath: snapshot.preflight_path, expectedPreflightSha256: String(event.details?.preflight_sha256 ?? ''),
            expectedScopeContentSha256: originalScope });
        if (!entry && !currentOnly) throw new Error(`Retained expected-RED execution rejected: ${violation}`);
        if (!entry?.selected_case_binding || !entry.execution_id) continue;
        const selection = entry.selected_case_binding.before;
        const starts = attempts.filter(item => (countNextStepWork('visit:expected_red_event'), item.event_type === 'INTERMEDIATE_COMMAND_STARTED'
            && item.details?.execution_id === entry.execution_id));
        const start = starts[0];
        if (starts.length !== 1 || Number(start.integrity?.task_sequence) >= entry.event_task_sequence
            || start.details?.command !== entry.command || start.details?.artifact_path !== event.details?.artifact_path
            || validationDigest(start.details?.selected_case_selection) !== validationDigest(selection)
            || validationDigest(start.details?.report_evidence ?? null) !== validationDigest(entry.report_evidence ?? null)) continue;
        const execution: NativeCaseExecution = { record_path: entry.artifact_path, record_sha256: entry.artifact_sha256,
            output_path: entry.output_artifact_path, output_sha256: entry.output_artifact_sha256,
            output_size_bytes: entry.output_artifact_size_bytes, output_encoding: entry.output_encoding ?? 'utf8',
            event_task_sequence: entry.event_task_sequence, scope_content_sha256: originalScope,
            expected_failure: true, exit_code: entry.exit_code,
            ...(entry.report_evidence ? { report_evidence: entry.report_evidence } : {}) };
        let cases = selection.cases;
        if (!cases.length) {
            const sources = entry.focused_test_paths.length ? entry.focused_test_paths
                : getCurrentIntermediateTestTargets(options.repoRoot, entry.command, snapshot.changed_files.filter(isTaskTest), selection);
            cases = sources.map(source => (countNextStepWork('visit:expected_red_case'),
                ({ source, case_id: source, selector: source })));
        }
        for (const claim of cases) {
            countNextStepWork('visit:expected_red_case');
            if (!snapshot.changed_files.includes(claim.source)
                || latestMatchingIntermediateAttempt(relevantAttempts, claim.source, claim.case_id) !== event) continue;
            assertCurrentIntermediateSelection(options.repoRoot, entry.selected_case_binding, [claim.source]);
            const source = selection.sources.find(item => (countNextStepWork('visit:expected_red_source'), item.path === claim.source));
            if (!source) throw new Error('Expected-red selected source was not observed before execution.');
            if (selection.cases.length) {
                const { identity, bytes } = readValidationFile(options.repoRoot, source.path, source.size);
                if (validationDigest(identity) !== validationDigest(source)) throw new Error('Expected-red selected source changed.');
                // A refused pair yields no obligation. Skipping it lets a later correct RED from another command count,
                // while required-source coverage still demands RED evidence for every changed test.
                if (!containsCaseIdentifier(decodeBoundarySource(bytes), claim.case_id)) continue;
            }
            const key = JSON.stringify([source.path, claim.case_id]);
            if (selection.cases.length === 0) fileOnlyCases.add(key);
            else fileOnlyCases.delete(key);
            const bindingPreflight = carry?.source_preflight_sha256 ?? snapshot.preflight_sha256;
            const binding = { task_id: options.taskId, preflight_sha256: bindingPreflight,
                source_identity: source, case_id: claim.case_id, case_execution: execution };
            obligations.set(key, { id: validationDigest(binding), recipe_id: 'native-task-command',
                target_id: claim.case_id, selector: claim.selector, source_identity: source,
                snapshot_sha256: bindingPreflight, execution: 'OBSERVED', attempt_id: entry.artifact_sha256,
                result_status: 'UNRESOLVED', result_sha256: null, case_execution: execution });
        }
    }
    // Without a recorded obligation there is no RED proof to evaluate for support coverage.
    if (!obligations.size) return null;
    const selection = loadTaskFullSuiteConfig(options.repoRoot, options.taskId).selection;
    const observedSources = new Set([...obligations.values()].map(item => item.source_identity.path));
    // An observed target's selected-case binding authenticates its support bytes; changed tests still require their own results below.
    const coveredSupport = new Set(selection.status === 'current' ? selection.plan?.support
        .filter(item => item.targets.some(target => observedSources.has(target)))
        .map(item => item.path) : []);
    const requiredSources = new Set(requiredExpectedRedFiles(preflight, options.repoRoot, classification)
        .filter(file => typeof file !== 'string' || isTaskTest(file) || !coveredSupport.has(file)).filter(file =>
        currentOnly || preflight.scope_category === 'test-only' || typeof file === 'string'
            && isTaskTest(file)));
    if (snapshot.changed_files.some(file => requiredSources.has(file)
        && ![...obligations.values()].some(item => (countNextStepWork('visit:expected_red_obligation'), item.source_identity.path === file))))
        return null;
    if (readValidationEventSnapshot(options.repoRoot, options.taskId, options.inspection).timeline_sha256 !== snapshot.timeline_sha256)
        throw new Error('Expected-red timeline changed during evidence projection.');
    const value = { schema_version: 1 as const, task_id: options.taskId, preflight_sha256: snapshot.preflight_sha256,
        scope_content_sha256: snapshot.scope_content_sha256,
        obligations: [...obligations.values()].sort((left, right) => (countNextStepWork('visit:expected_red_obligation', 2), left.id.localeCompare(right.id))) };
    return { evidence: { ...value, sha256: validationDigest(value) }, fileOnlyCases, timelineSha256: snapshot.timeline_sha256 };
}
