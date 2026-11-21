import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { isTestScopePath } from '../../../src/core/file-role-bindings';
import { classifyChange, getClassificationConfig } from '../../../src/gates/preflight/classify-change';
import { isSafeOrdinaryDocumentationPath } from '../../../src/gates/preflight/classify-change-doc-safety';
import { reviewRemediationDeltaInternals } from '../../../src/gates/review-remediation/review-remediation-delta';
import { DEFAULT_REVIEW_TRIGGER_POLICY } from '../../../src/policy/review-trigger-policy';
import { FILE_ROLES, type FileRole, type LayerResult, type StandFinding } from './model';
import {
    CATEGORY_EFFECT,
    DOMAIN_LANES,
    RERUN_EFFECTS,
    expectedForRole,
    type DomainLane,
    type RemediationCategory,
    type RerunEffect
} from './oracle';
import { STACK_ADAPTERS } from './stacks';

export interface PathObservation {
    isTest: boolean;
    domainLanes: DomainLane[];
    category: RemediationCategory;
    effect: RerunEffect;
}

export interface PathVariant {
    operation: 'modified' | 'added';
    changedLines: number;
}

/** Variants per role: unit tests also probe the test-refactor threshold and a new test file. */
export function pathVariants(role: FileRole): PathVariant[] {
    return role === 'UNIT_TEST'
        ? [{ operation: 'modified', changedLines: 50 }, { operation: 'modified', changedLines: 51 }, { operation: 'added', changedLines: 10 }]
        : [{ operation: 'modified', changedLines: 10 }];
}

/** Observes how the shipped Garda classifiers treat one remediated file. */
export function createPathObserver(): { observe(file: string, variant: PathVariant): PathObservation; dispose(): void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-synthetic-paths-'));
    const config = getClassificationConfig(root);
    const testPathRegexes = DEFAULT_REVIEW_TRIGGER_POLICY.test_path_regexes;
    const structuralPatterns = reviewRemediationDeltaInternals.compilePatterns(
        DEFAULT_REVIEW_TRIGGER_POLICY.test_refactor_structural_path_regexes, 'structural test path regexes'
    );
    return {
        observe(file, variant) {
            const triggers = classifyChange({ normalizedFiles: [file], repoRoot: root, classificationConfig: config })
                .triggers as unknown as Record<string, unknown>;
            const { category } = reviewRemediationDeltaInternals.categorizeFile({
                filePath: file,
                operation: variant.operation,
                changedLines: variant.changedLines,
                lineDeltaUnavailableReason: null,
                baselineStatus: variant.operation === 'added' ? 'missing' : 'text',
                currentStatus: 'text',
                testPathRegexes,
                structuralPatterns,
                structuralThreshold: DEFAULT_REVIEW_TRIGGER_POLICY.test_refactor_changed_lines_threshold
            });
            return {
                isTest: isTestScopePath(file, testPathRegexes),
                domainLanes: DOMAIN_LANES.filter((lane) => triggers[lane] === true),
                category,
                effect: isSafeOrdinaryDocumentationPath(file, config) && !isTestScopePath(file, testPathRegexes)
                    ? 'current_lane' : CATEGORY_EFFECT[category]
            };
        },
        dispose() {
            fs.rmSync(root, { recursive: true, force: true });
        }
    };
}

/** Compares one observation with the role contract; returns findings with stable ids. */
export function comparePathObservation(
    context: { stack: string; role: FileRole; file: string; variant: PathVariant },
    observation: PathObservation
): StandFinding[] {
    const expected = expectedForRole(context.role, context.variant.operation, context.variant.changedLines, context.file);
    const idBase = `path:${context.stack}:${context.role}:${context.file}:${context.variant.operation}-${context.variant.changedLines}`;
    const detail = { ...context, expected, observed: observation };
    const findings: StandFinding[] = [];
    if (observation.isTest !== expected.isTest) {
        findings.push({
            id: `${idBase}:test-role`,
            layer: 'path',
            // A test treated as production costs extra reviews; production treated as a test loses domain reviews.
            kind: expected.isTest ? 'economy' : 'safety',
            summary: expected.isTest ? 'test file classified as production' : 'production file classified as a test',
            detail
        });
    }
    if (expected.domainLane && !observation.domainLanes.includes(expected.domainLane)) {
        findings.push({
            id: `${idBase}:missing-${expected.domainLane}`,
            layer: 'path',
            kind: 'safety',
            summary: `${expected.domainLane} review not triggered`,
            detail
        });
    }
    for (const lane of observation.domainLanes.filter((entry) => entry !== expected.domainLane)) {
        findings.push({
            id: `${idBase}:extra-${lane}`,
            layer: 'path',
            kind: 'economy',
            summary: `unexpected ${lane} review triggered`,
            detail
        });
    }
    const breadth = RERUN_EFFECTS.indexOf(observation.effect) - RERUN_EFFECTS.indexOf(expected.effect);
    if (breadth !== 0) {
        findings.push({
            id: `${idBase}:rerun-${observation.effect}`,
            layer: 'path',
            kind: breadth > 0 ? 'economy' : 'safety',
            summary: `remediation category '${observation.category}' re-opens ${observation.effect}; contract expects ${expected.effect}`,
            detail
        });
    }
    return findings;
}

export function runPathLayer(): LayerResult {
    const observer = createPathObserver();
    const findings: StandFinding[] = [];
    let cases = 0;
    try {
        for (const stack of STACK_ADAPTERS) {
            for (const role of FILE_ROLES) {
                for (const file of stack.paths[role]) {
                    for (const variant of pathVariants(role)) {
                        cases += 1;
                        findings.push(...comparePathObservation(
                            { stack: stack.id, role, file, variant },
                            observer.observe(file, variant)
                        ));
                    }
                }
            }
        }
    } finally {
        observer.dispose();
    }
    return { layer: 'path', cases, findings };
}
