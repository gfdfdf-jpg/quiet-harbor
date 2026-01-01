import * as path from 'node:path';
import { getFullSuiteTestSelectionViolations } from '../full-suite/full-suite-test-selection';
import { loadFullSuiteValidationConfig } from '../../core/full-suite-validation-config';
import { inspectFullSuiteReports } from '../full-suite/full-suite-report-evidence';
import { taskTestExecutionProofSatisfied } from '../full-suite/task-test-execution-proof';
import { loadTaskFullSuiteConfig } from '../full-suite/task-full-suite-config';

import { normalizePath } from '../shared/helpers';
import {
    getCycleBindingSnapshotFromPayload,
    resolveTaskCycleBindingSnapshot,
    taskCycleScopeBindingsMatch
} from '../task-events-summary/task-events-summary';
import {
    type FullSuiteValidationCycleBinding,
    type FullSuiteValidationResult
} from '../full-suite/full-suite-validation';
import {
    readJsonArtifact,
    type TimelineEventEntry
} from './completion-evidence';

export interface CompletionFullSuiteEvidence {
    enabled: boolean;
    artifact_path: string;
    status: string | null;
    cycle_binding: FullSuiteValidationCycleBinding | null;
    cycle_binding_valid: boolean | null;
    violations: string[];
}

export function collectFullSuiteValidationEvidence(input: {
    enabled: boolean;
    required: boolean;
    reviewsRoot: string;
    taskId: string;
    repoRoot: string;
    timelinePath: string;
    orderedEvents: readonly TimelineEventEntry[];
    expectedPreflightPath: string;
    expectedPreflightSha256: string;
    expectedCompileGateTimestamp: string | null;
    expectedCommand: string;
    fullSuiteNotRequiredForDocsOnly: boolean;
    errors: string[];
}): CompletionFullSuiteEvidence {
    const fullSuiteValidationPath = path.join(input.reviewsRoot, `${input.taskId}-full-suite-validation.json`);
    const evidence: CompletionFullSuiteEvidence = {
        enabled: input.enabled,
        artifact_path: normalizePath(fullSuiteValidationPath),
        status: null,
        cycle_binding: null,
        cycle_binding_valid: null,
        violations: []
    };

    if (!input.required) {
        evidence.status = 'NOT_REQUIRED';
        return evidence;
    }

    const fullSuiteArtifact = readJsonArtifact(fullSuiteValidationPath, 'Full suite validation', input.errors) as FullSuiteValidationResult | null;
    const timelineEventTypes = new Set(input.orderedEvents.map(e => e.event_type));
    const hasFullSuiteTimelineEvent =
        timelineEventTypes.has('FULL_SUITE_VALIDATION_PASSED')
        || timelineEventTypes.has('FULL_SUITE_VALIDATION_WARNED')
        || timelineEventTypes.has('FULL_SUITE_VALIDATION_FAILED')
        || timelineEventTypes.has('FULL_SUITE_VALIDATION_SKIPPED');
    if (!hasFullSuiteTimelineEvent) {
        const message = `Task timeline '${normalizePath(input.timelinePath)}' is missing full-suite validation lifecycle evidence.`;
        input.errors.push(message);
        evidence.violations.push(message);
    }

    if (!fullSuiteArtifact) {
        evidence.status = 'MISSING';
        return evidence;
    }

    const artifactStatus = String(fullSuiteArtifact.status || '').trim().toUpperCase();
    if (['PASSED', 'WARNED'].includes(artifactStatus)) {
        const selection = loadTaskFullSuiteConfig(input.repoRoot, input.taskId).selection;
        if (!taskTestExecutionProofSatisfied(input.expectedCommand, selection.targets, fullSuiteArtifact.task_test_execution_proof)) {
            const message = 'Maven target execution proof is missing or invalid. Rerun full-suite validation to capture fresh Surefire/Failsafe reports.';
            input.errors.push(message); evidence.violations.push(message);
        }
        const preflight = readJsonArtifact(input.expectedPreflightPath, 'Full suite current preflight', input.errors);
        if (preflight && Array.isArray(preflight.changed_files)) {
            const mismatches = getFullSuiteTestSelectionViolations(input.repoRoot, input.expectedCommand, preflight.changed_files.map(String));
            input.errors.push(...mismatches); evidence.violations.push(...mismatches);
        }
        try {
            inspectFullSuiteReports({ repoRoot: input.repoRoot, taskId: input.taskId, reviewsRoot: input.reviewsRoot,
                artifact: fullSuiteArtifact as unknown as Record<string, unknown>,
                declarations: loadFullSuiteValidationConfig(input.repoRoot).report_files });
        } catch (error) {
            const message = `Full-suite report evidence rejected: ${String(error)}`;
            input.errors.push(message); evidence.violations.push(message);
        }
    }
    evidence.status = artifactStatus || null;
    validateFullSuiteCycleBinding(fullSuiteArtifact, evidence, input);

    const artifactIsAcceptedDocsOnlySkip =
        artifactStatus === 'SKIPPED'
        && input.fullSuiteNotRequiredForDocsOnly
        && String(fullSuiteArtifact.skip_reason || '').trim() === 'DOCS_ONLY_SCOPE_NOT_REQUIRED'
        && fullSuiteArtifact.required === false;
    if (artifactStatus !== 'PASSED' && artifactStatus !== 'WARNED' && !artifactIsAcceptedDocsOnlySkip) {
        const message =
            `Full suite validation artifact '${normalizePath(fullSuiteValidationPath)}' must have status PASSED or WARNED when enabled, ` +
            `or SKIPPED with skip_reason DOCS_ONLY_SCOPE_NOT_REQUIRED for docs-only scopes, got '${artifactStatus || 'UNKNOWN'}'.`;
        input.errors.push(message);
        evidence.violations.push(message);
    }
    if (String(fullSuiteArtifact.command || '').trim() !== input.expectedCommand) {
        const message =
            `Full suite validation artifact '${normalizePath(fullSuiteValidationPath)}' command does not match the current effective task command.`;
        input.errors.push(message);
        evidence.violations.push(message);
    }

    return evidence;
}

function validateFullSuiteCycleBinding(
    fullSuiteArtifact: FullSuiteValidationResult,
    evidence: CompletionFullSuiteEvidence,
    input: {
        taskId: string;
        repoRoot: string;
        reviewsRoot: string;
        orderedEvents: readonly TimelineEventEntry[];
        expectedPreflightPath: string;
        expectedPreflightSha256: string;
        expectedCompileGateTimestamp: string | null;
        errors: string[];
    }
): void {
    const rawCycleBinding = fullSuiteArtifact.cycle_binding;
    if (!rawCycleBinding || typeof rawCycleBinding !== 'object' || Array.isArray(rawCycleBinding)) {
        const message = `Full suite validation artifact '${evidence.artifact_path}' is missing cycle_binding.`;
        input.errors.push(message);
        evidence.violations.push(message);
        return;
    }

    const cycleBindingRecord = rawCycleBinding as unknown as Record<string, unknown>;
    const cycleBinding: FullSuiteValidationCycleBinding = {
        task_id: String(cycleBindingRecord.task_id || '').trim(),
        preflight_path: normalizePath(cycleBindingRecord.preflight_path || ''),
        preflight_sha256: String(cycleBindingRecord.preflight_sha256 || '').trim().toLowerCase(),
        compile_gate_timestamp: cycleBindingRecord.compile_gate_timestamp == null
            ? null
            : String(cycleBindingRecord.compile_gate_timestamp || '').trim() || null
    };
    evidence.cycle_binding = cycleBinding;
    const expectedCycleBinding: FullSuiteValidationCycleBinding = {
        task_id: input.taskId,
        preflight_path: normalizePath(input.expectedPreflightPath),
        preflight_sha256: String(input.expectedPreflightSha256 || '').trim().toLowerCase(),
        compile_gate_timestamp: input.expectedCompileGateTimestamp
    };
    const currentCycle = resolveTaskCycleBindingSnapshot(
        input.taskId,
        input.orderedEvents as unknown as ReadonlyArray<Record<string, unknown>>,
        input.repoRoot,
        input.reviewsRoot
    );
    const candidateCycle = getCycleBindingSnapshotFromPayload({ cycle_binding: cycleBindingRecord }, input.repoRoot);
    const sameScopeBinding = taskCycleScopeBindingsMatch(currentCycle, candidateCycle);
    const cycleBindingValid =
        cycleBinding.task_id === expectedCycleBinding.task_id
        && (
            (
                cycleBinding.preflight_path === expectedCycleBinding.preflight_path
                && cycleBinding.preflight_sha256 === expectedCycleBinding.preflight_sha256
                && cycleBinding.compile_gate_timestamp === expectedCycleBinding.compile_gate_timestamp
            )
            || (
                sameScopeBinding
                && cycleBinding.preflight_path === expectedCycleBinding.preflight_path
            )
        );
    evidence.cycle_binding_valid = cycleBindingValid;
    if (!cycleBindingValid) {
        const message =
            `Full suite validation artifact '${evidence.artifact_path}' is stale for the current task cycle. ` +
            `Expected task_id='${expectedCycleBinding.task_id}', preflight_path='${expectedCycleBinding.preflight_path}', ` +
            `preflight_sha256='${expectedCycleBinding.preflight_sha256}', compile_gate_timestamp='${expectedCycleBinding.compile_gate_timestamp || 'null'}'.`;
        input.errors.push(message);
        evidence.violations.push(message);
    }
}

