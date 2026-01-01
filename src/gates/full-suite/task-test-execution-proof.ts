import * as path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { parseCommandChain } from '../../core/command-line';
import { readValidationFile } from '../../core/project-validation-identity';
import { prepareValidationReportCapture, completeValidationReportCapture } from '../../core/validation-report-capture';
import type { ValidationReportCapture, ValidationReportCaptureStart } from '../../core/validation-report-contract';
import { joinOrchestratorPath, normalizePath } from '../../core/orchestrator-paths';
import { assertFreshValidationReport } from '../../core/validation-report-capture';
import { taskValidationProcessViolations, reusableTaskValidationPlan, type TaskValidationPlan } from '../../core/task-validation-plan';
import { isPlainRecord } from '../../core/records';
import { validationDigest } from '../../core/project-validation-identity';

/** Compatibility reader: old records are projected, never rewritten into new executions. */
export function taskTestProcessEvidenceViolations(plan: TaskValidationPlan | undefined, artifact: unknown, legacyPlan?: TaskValidationPlan,
    authenticatedTaskCycleRebind = false): string[] {
    if (!isPlainRecord(artifact)) return ['Task test process integrity: invalid execution artifact. Rerun selected own tests.'];
    if (!plan && artifact.task_test_process_evidence !== undefined) plan = legacyPlan;
    if (!plan) return legacyPlan?.binding && artifact.task_test_process_evidence === undefined
        && artifact.exit_code === 0 && artifact.timed_out === false
        && isPlainRecord(artifact.command_provenance) && isPlainRecord(artifact.command_provenance.command_descriptor)
        && validationDigest(artifact.command_provenance.command_descriptor) === validationDigest(legacyPlan.descriptor)
        && isPlainRecord(artifact.cycle_binding) && artifact.cycle_binding.task_id === legacyPlan.binding.task_id
        && artifact.cycle_binding.preflight_sha256 === legacyPlan.binding.preflight_sha256
        && isPlainRecord(artifact.cycle_binding.scope_binding)
        && artifact.cycle_binding.scope_binding.scope_sha256 === legacyPlan.binding.scope_sha256
        && artifact.cycle_binding.scope_binding.scope_content_sha256 === legacyPlan.binding.scope_content_sha256
        && typeof artifact.cycle_binding.compile_gate_timestamp === 'string'
        && Date.parse(artifact.cycle_binding.compile_gate_timestamp) >= Date.parse(legacyPlan.binding.selected_at) ? []
        : ['Task test process identity is insufficient for reuse in this scope. Select current own tests and rerun task-test-validation; retain the old result unchanged.'];
    plan = reusableTaskValidationPlan(plan, artifact.task_test_validation_plan, authenticatedTaskCycleRebind) ?? plan;
    const violations = taskValidationProcessViolations(plan, artifact.task_test_process_evidence);
    const expectedScope = validationDigest([isPlainRecord(artifact.cycle_binding) ? artifact.cycle_binding.scope_binding : undefined, plan]);
    if (isPlainRecord(artifact.task_test_process_evidence) && Array.isArray(artifact.task_test_process_evidence.invocations)
        && artifact.task_test_process_evidence.invocations.some(invocation => !isPlainRecord(invocation)
            || invocation.scope_before !== expectedScope))
        violations.push('Task test process integrity: execution scope differs from its selected cycle. Select current own tests and rerun task-test-validation.');
    return violations;
}

/** Adapter observations are informational; missing/unsupported reports never revoke process PASS. */
export const TASK_TEST_ADAPTERS = Object.freeze([{ id: 'maven-junit', version: 1, supports: isMaven }]);

interface TargetCapture { target: string; className: string; starts: ValidationReportCaptureStart[] }

function isMaven(command: string): boolean {
    try {
        const tokens = parseCommandChain(command)[0];
        return /^(?:mvn|mvnw)(?:\.cmd|\.bat|\.exe)?$/iu.test(path.posix.basename(tokens[0].replace(/\\/gu, '/')));
    } catch { return false; }
}

function mavenTargetLayout(target: string): { module: string; className: string } | null {
    const parts = target.split(/(?:^|\/)src\/test\/java\//u);
    if (parts.length !== 2 || !target.endsWith('.java') || /[\\:]/u.test(target)
        || target.split('/').some(part => !part || part === '.' || part === '..')) return null;
    const classes = parts[1].slice(0, -'.java'.length).split('/');
    if (!classes.every(part => /^[A-Za-z_$][\w$]*$/u.test(part))) return null;
    return { module: parts[0], className: classes.join('.') };
}

function reportPath(module: string, directory: string, className: string): string {
    return path.posix.join(module, 'target', directory, `TEST-${className}.xml`);
}

/** Pure retained-evidence check: navigator reads never probe report files or rerun Git. */
export function taskTestExecutionProofSatisfied(command: string, targets: readonly string[], value: unknown): boolean {
    if (!isMaven(command) || !targets.length) return true;
    if (!Array.isArray(value)) return false;
    try {
        return targets.every(target => {
            const layout = mavenTargetLayout(target);
            if (!layout) return false;
            const { module, className } = layout;
            return (value as ValidationReportCapture[]).some(capture => !capture.violations.length && capture.reports.some(report => {
                const relative = report.observation.identity.path;
                if (!['surefire-reports', 'failsafe-reports'].some(directory => relative === reportPath(module, directory, className))) return false;
                const index = capture.start.declarations.findIndex(declaration => declaration.path === relative);
                if (index < 0) return false;
                const started = [capture.start.anchor.created_ns, capture.start.anchor.modified_ns, capture.start.anchor.changed_ns]
                    .map(BigInt).reduce((latest, time) => time > latest ? time : latest);
                assertFreshValidationReport(report.observation, capture.start.before[index], started, capture.completed_at);
                const bytes = Buffer.from(report.content_base64, 'base64');
                if (createHash('sha256').update(bytes).digest('hex') !== report.observation.identity.sha256) return false;
                const xml = bytes.toString('utf8').replace(/<!--[\s\S]*?-->/gu, '');
                if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) return false;
                return [...xml.matchAll(/<testcase\b([^>]*)(?:\/>|>([\s\S]*?)<\/testcase>)/gu)].some(test => {
                    const name = /\bclassname\s*=\s*(["'])(.*?)\1/u.exec(test[1])?.[2];
                    return name === className && !/<(?:skipped|failure|error)\b/u.test(test[2] ?? '');
                });
            }));
        });
    } catch { return false; }
}

export function startTaskTestExecutionProof(root: string, command: string, targets: readonly string[]): TargetCapture[] {
    if (!TASK_TEST_ADAPTERS.some(adapter => adapter.supports(command))) return [];
    return targets.flatMap(target => {
        try {
        const source = readValidationFile(root, target).bytes.toString('utf8');
        const layout = mavenTargetLayout(target);
        const packageName = /^\s*package\s+([\w.]+)\s*;/mu.exec(source)?.[1];
        const simple = path.posix.basename(target, '.java');
        if (!layout)
            throw new Error(`Cannot prove Maven execution for ${target}. Select an explicit supported test runner.`);
        const className = packageName ? `${packageName}.${simple}` : simple;
        if (className !== layout.className)
            throw new Error(`Ambiguous Maven class layout for ${target}. Use a supported runner with an explicit target and report binding.`);
        const starts = ['surefire-reports', 'failsafe-reports'].map(directory => prepareValidationReportCapture(root,
            [{ path: reportPath(layout.module, directory, className), max_bytes: 1024 * 1024 }],
            { evidenceDirectory: normalizePath(path.relative(root, joinOrchestratorPath(root, `runtime/validation-output/task-test-proof-${randomUUID()}`))),
                excludedPaths: targets })!);
        return [{ target, className, starts }];
        } catch { return []; } // Unsupported layout/report location falls back to generic evidence.
    });
}

export function completeTaskTestExecutionProof(root: string, captures: TargetCapture[]): {
    reports: ValidationReportCapture[]; violations: string[];
} {
    const reports: ValidationReportCapture[] = [], violations: string[] = [];
    for (const capture of captures) {
        const attempts = capture.starts.flatMap(start => {
            try { const attempt = completeValidationReportCapture(root, start); return attempt ? [attempt] : []; }
            catch { return []; }
        });
        const proof = attempts.find(attempt => !attempt.violations.length && attempt.reports.some(report => {
            const xml = Buffer.from(report.content_base64, 'base64').toString('utf8').replace(/<!--[\s\S]*?-->/gu, '');
            if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) return false;
            // At least one actual, unskipped testcase for this class is required.
            return [...xml.matchAll(/<testcase\b([^>]*)(?:\/>|>([\s\S]*?)<\/testcase>)/gu)].some(test =>
                /\bclassname\s*=\s*(["'])(.*?)\1/u.exec(test[1])?.[2] === capture.className
                && !/<(?:skipped|failure|error)\b/u.test(test[2] ?? ''));
        }));
        reports.push(...attempts.filter(attempt => attempt.reports.length > 0));
        if (!proof) violations.push(`Maven adapter finding: no fresh unskipped Surefire/Failsafe testcase was observed for ${capture.target}. Review the declared runner, target mapping and process evidence.`);
        if (attempts.some(attempt => attempt.reports.some(report => /<(?:skipped|failure|error)\b/u.test(Buffer.from(report.content_base64, 'base64').toString('utf8')))))
            violations.push(`Maven adapter finding: retained cases for ${capture.target} include skipped, failed or errored observations. Resolve these facts in the existing independent review.`);
    }
    return { reports, violations };
}
