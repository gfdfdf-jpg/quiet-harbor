import * as path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { parseCommandChain } from '../../core/command-line';
import { readValidationFile } from '../../core/project-validation-identity';
import { prepareValidationReportCapture, completeValidationReportCapture } from '../../core/validation-report-capture';
import type { ValidationReportCapture, ValidationReportCaptureStart } from '../../core/validation-report-contract';
import { joinOrchestratorPath, normalizePath } from '../../core/orchestrator-paths';
import { assertFreshValidationReport } from '../../core/validation-report-capture';

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
    if (!isMaven(command)) return [];
    return targets.map(target => {
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
        return { target, className, starts };
    });
}

export function completeTaskTestExecutionProof(root: string, captures: TargetCapture[]): {
    reports: ValidationReportCapture[]; violations: string[];
} {
    const reports: ValidationReportCapture[] = [], violations: string[] = [];
    for (const capture of captures) {
        const attempts = capture.starts.map(start => completeValidationReportCapture(root, start)!);
        const proof = attempts.find(attempt => !attempt.violations.length && attempt.reports.some(report => {
            const xml = Buffer.from(report.content_base64, 'base64').toString('utf8').replace(/<!--[\s\S]*?-->/gu, '');
            if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) return false;
            // At least one actual, unskipped testcase for this class is required.
            return [...xml.matchAll(/<testcase\b([^>]*)(?:\/>|>([\s\S]*?)<\/testcase>)/gu)].some(test =>
                /\bclassname\s*=\s*(["'])(.*?)\1/u.exec(test[1])?.[2] === capture.className
                && !/<(?:skipped|failure|error)\b/u.test(test[2] ?? ''));
        }));
        if (proof) reports.push(proof);
        else violations.push(`No fresh Surefire/Failsafe execution report proves target ${capture.target} ran. Inspect the module and parent POM skip/includes/excludes settings, clear stale target reports, and rerun the task selection and validation with a runner that executes this class.`);
    }
    return { reports, violations };
}
