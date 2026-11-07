import * as fs from 'node:fs';

import { readReviewArtifactTextFile } from '../../gate-runtime/review-artifacts';
import { normalizePath } from '../shared/helpers';
import {
    isPassedIntermediateCommandEvent,
    readTaskOwnedFocusedIntermediateEvidence
} from '../review/focused-intermediate-evidence';
import { findReviewFocusedFindingTestPaths } from './next-step-review-artifact-failure-detection';
import {
    findReviewFindingsValidationMissingFocusedValidationTestPaths,
    getReviewFindingsValidationArtifactPath,
    validateReviewFindingsValidationArtifact
} from '../review/review-findings-validation-artifact';
import { isContainedFocusedTarget } from '../review/missing-focused-validation-marker';

export { isPassedIntermediateCommandEvent };

export interface FocusedIntermediateReviewEvidence {
    available: boolean;
    reason: string | null;
}

export function readFocusedTestRequiredByReview(options: {
    taskId: string;
    reviewType: string;
    reviewArtifactPath: string;
}): string | null {
    return readFocusedTestsRequiredByReview(options)[0] ?? null;
}

export function readFocusedTestsRequiredByReview(options: {
    taskId: string; reviewType: string; reviewArtifactPath: string;
}): string[] {
    const validationArtifactPath = getReviewFindingsValidationArtifactPath(options.reviewArtifactPath);
    if (fs.existsSync(validationArtifactPath)) {
        const validationArtifact = validateReviewFindingsValidationArtifact({
            artifactPath: validationArtifactPath,
            expectedTaskId: options.taskId,
            expectedReviewType: options.reviewType,
            requireAccepted: true
        });
        if (validationArtifact.valid) {
            const findingTestPaths = findReviewFindingsValidationMissingFocusedValidationTestPaths(validationArtifact.artifact)
                .map((filePath) => normalizePath(filePath))
                .filter(isContainedFocusedTarget);
            return [...new Set(findingTestPaths)];
        }
    }
    if (!fs.existsSync(options.reviewArtifactPath)) {
        return [];
    }
    try {
        const reviewContent = readReviewArtifactTextFile(options.reviewArtifactPath);
        const findingTestPaths = findReviewFocusedFindingTestPaths(reviewContent)
            .map((filePath) => normalizePath(filePath))
            .filter(isContainedFocusedTarget);
        return [...new Set(findingTestPaths)];
    } catch {
        return [];
    }
}

function parseUtcTimestamp(value: string | null): number | null {
    const parsed = Date.parse(String(value || '').trim());
    return Number.isFinite(parsed) ? parsed : null;
}

export function readPostReviewFocusedIntermediateEvidence(options: {
    repoRoot: string;
    reviewsRoot: string;
    eventsRoot: string;
    taskId: string;
    reviewType: string;
    reviewArtifactPath: string;
    reviewResultRecordedAtUtc: string | null;
    reviewerProvenanceTaskSequence: number | null;
    changedFiles: readonly string[];
    expectedPreflightPath?: string | null;
    expectedPreflightSha256?: string | null;
    expectedCoverageContractSha256?: string | null;
}): FocusedIntermediateReviewEvidence {
    const reviewResultTimestamp = parseUtcTimestamp(options.reviewResultRecordedAtUtc);
    const requiredFocusedTests = readFocusedTestsRequiredByReview({
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewArtifactPath: options.reviewArtifactPath
    });
    if (
        reviewResultTimestamp == null
        || options.reviewerProvenanceTaskSequence == null
        || !requiredFocusedTests.length
    ) {
        return { available: false, reason: null };
    }
    const selection = readTaskOwnedFocusedIntermediateEvidence({
        repoRoot: options.repoRoot,
        reviewsRoot: options.reviewsRoot,
        eventsRoot: options.eventsRoot,
        taskId: options.taskId,
        changedFiles: options.changedFiles,
        additionalTargetPaths: requiredFocusedTests,
        minimumTimestampExclusive: reviewResultTimestamp,
        minimumTaskSequenceExclusive: options.reviewerProvenanceTaskSequence,
        expectedPreflightPath: options.expectedPreflightPath,
        expectedPreflightSha256: options.expectedPreflightSha256,
        expectedCoverageContractSha256: options.expectedCoverageContractSha256,
        maxEntries: Math.max(8, requiredFocusedTests.length)
    });
    const evidence = requiredFocusedTests.map(target => selection.entries.find(entry => entry.focused_test_paths.includes(target)));
    if (evidence.some(entry => !entry)) {
        return { available: false, reason: null };
    }
    return {
        available: true,
        reason:
            `Current task-owned focused validation evidence: ${[...new Set(evidence.map(entry => entry!.artifact_path))].join(', ')}; ` +
            `focused_tests=${requiredFocusedTests.join(', ')}.`
    };
}
