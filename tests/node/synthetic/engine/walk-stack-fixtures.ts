import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { WalkFixtureDescriptor } from './walk-fixture';

export type StackMode = 'generic' | 'auto';
export interface StackSuite { id: string; technology: string; source: string; target: string; case: string; comment: string }
export interface StackTechnology {
    id: string; executable: string; compileExecutable?: string; compileArgv: string[]; firstArgv: string[]; secondArgv: string[]; allArgv: string[]; broadArgv: string[]; report: string;
}
export interface StackManifest {
    schema: 1; id: string; title: string; adapter: string | null; technologies: StackTechnology[]; suites: StackSuite[]; helpers: string[];
}
export interface StackInvocation { technology: string; command: string; argv: string[]; targets: string[] }
export interface StackTaskPlan { archetype: number; mode: StackMode; invocations: StackInvocation[]; runnerVariant?: string; repoRoot?: string }
export interface StackExecution {
    fixture: string; technology: string; argv: string[]; cwd: string; purpose: 'compile' | 'broad' | 'own';
    archetype: number; mode: StackMode; variant: string; targets: string[]; exitCode: number; output: string; outputSha256: string; error: string;
    checks: Array<{ target: string; source?: string; passed: boolean; skipped?: boolean; sourceSha256?: string; testSha256?: string }>;
    reports: Array<{ path: string; sha256: string; stale: boolean; passed: boolean }>;
}
export const STACK_FIXTURE_ROOT = path.resolve('tests/fixtures/stacks');
export const STACK_ORACLE_VERSION = 'stack-oracle-1';
/** Only these reached input shapes have independent A1/A6 calibration; other matrix states stay visible. */
export const STACK_COUNTER_STATE_IDS = new Set(['unknown-quartz', 'spring-maven', 'polyglot-maven-ts']
    .map(id => 'stack-fixture-' + id + '-a1-a6'));
const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

function filesBelow(root: string): Record<string, string> {
    const files: Record<string, string> = {};
    const visit = (directory: string) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(file);
            else if (entry.isFile()) files[path.relative(root, file).replace(/\\/gu, '/')] = fs.readFileSync(file, 'utf8');
            else throw new Error('Fixture inputs must be ordinary files: ' + file);
        }
    };
    visit(root);
    return files;
}

export const STACK_MANIFESTS: readonly StackManifest[] = (JSON.parse(fs.readFileSync(path.join(STACK_FIXTURE_ROOT, 'catalog.json'), 'utf8')) as { fixtures: string[] }).fixtures.map(id => JSON.parse(fs.readFileSync(path.join(STACK_FIXTURE_ROOT, id, 'fixture.json'), 'utf8')) as StackManifest);

export function stackCommand(technology: StackTechnology, argv: readonly string[]): string {
    const executable = './' + technology.executable + (process.platform === 'win32' ? '.cmd' : '');
    return [executable, ...argv].map(value => JSON.stringify(value)).join(' ');
}

/** Polyglot tasks have one invocation per technology, with all its own target groups in that invocation. */
export function stackInvocations(manifest: StackManifest, archetype: number): StackInvocation[] {
    if (archetype === 4) return [];
    const suites = archetype === 3 || archetype === 8 || archetype === 9 || manifest.id.startsWith('polyglot-')
        ? manifest.suites : manifest.suites.slice(0, 1);
    return manifest.technologies.flatMap(technology => {
        const targets = suites.filter(suite => suite.technology === technology.id).map(suite => suite.target);
        if (!targets.length) return [];
        const all = targets.length === manifest.suites.filter(suite => suite.technology === technology.id).length;
        const argv = all ? technology.allArgv : technology.firstArgv;
        return [{ technology: technology.id, argv, targets, command: stackCommand(technology, argv) }];
    });
}

export function readStackExecutions(root: string): StackExecution[] {
    const file = path.join(root, '.git/stand-invocations.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as StackExecution) : [];
}

/** Fixture-owned symbolic mapping uses an exact literal argv value, including complete list/filter tokens. */
export function stackSelectedCases(invocation: StackInvocation): Array<{ source: string; case_id: string; selector: string }> {
    return invocation.targets.map(target => {
        const literal = invocation.argv.find(arg => arg === target || arg.startsWith(target + '::'));
        const stem = path.posix.basename(target).replace(/\.(?:java|kt|cs|swift|cpp|rs)$/u, '');
        const symbolic = invocation.argv.find(arg => arg === stem || arg === 'example.' + stem);
        const namedFilter = invocation.argv.find(arg => arg.startsWith('-Dtest='));
        const filterAt = invocation.argv.findIndex(arg => ['--filter', '-R', '-run'].includes(arg));
        const packageToken = invocation.argv.find(arg => arg === './' + target.split('/')[0]);
        const selector = literal ?? symbolic ?? namedFilter?.slice('-Dtest='.length)
            ?? (filterAt >= 0 ? invocation.argv[filterAt + 1] : packageToken);
        if (!selector) throw new Error('Fixture omitted a literal/symbolic case selector for ' + target);
        return { source: target, case_id: 'task-contract', selector };
    });
}

/** Independent source/output check; a zero exit or a familiar PASS string cannot establish assertions. */
export function stackExecutionViolations(root: string, plan: StackTaskPlan, records = readStackExecutions(root)): string[] {
    const violations: string[] = [];
    for (const record of records.filter(record => record.purpose === 'own')) {
        const declared = plan.invocations.find(run => run.technology === record.technology);
        if (!declared || JSON.stringify(record.argv) !== JSON.stringify(declared.argv) || record.cwd !== '.') violations.push('wrong-command-or-cwd');
        if (!declared || JSON.stringify(record.targets) !== JSON.stringify(declared.targets)) violations.push('wrong-target-set');
        if (!record.checks.length && record.exitCode === 0) violations.push('zero-cases');
        if (record.checks.some(check => check.skipped)) violations.push('skipped-case');
        if (record.exitCode === 0 && record.checks.some(check => !check.passed)) violations.push('process-case-disagreement');
        if (record.reports.some(report => report.stale)) violations.push('stale-adapter-report');
        if (record.exitCode === 0 && record.reports.some(report => !report.passed)) violations.push('process-report-disagreement');
        if (sha(record.output + '\n') !== record.outputSha256) violations.push('output-digest');
    }
    for (const invocation of plan.invocations) {
        const success = records.filter(record => record.purpose === 'own' && record.technology === invocation.technology && record.exitCode === 0).at(-1);
        if (!success) { violations.push('missing-green:' + invocation.technology); continue; }
        for (const target of invocation.targets) {
            const check = success.checks.find(check => check.target === target);
            if (!check?.source || !check.passed || check.skipped) { violations.push('missing-passed-target:' + target); continue; }
            if (sha(fs.readFileSync(path.join(root, target), 'utf8')) !== check.testSha256
                || sha(fs.readFileSync(path.join(root, check.source), 'utf8')) !== check.sourceSha256) violations.push('stale-source:' + target);
        }
    }
    return [...new Set(violations)];
}

export function blockingStackObservations(observations: string[]): string[] {
    return observations.filter(observation => !['stale-adapter-report', 'process-report-disagreement'].includes(observation));
}

export function stackFixture(manifest: StackManifest, mode: StackMode, invocations = stackInvocations(manifest, 8)): WalkFixtureDescriptor {
    const files = filesBelow(path.join(STACK_FIXTURE_ROOT, manifest.id, 'project'));
    files['.stand-fixture.json'] = JSON.stringify(manifest, null, 2) + '\n';
    files['.stand/runner.cjs'] = fs.readFileSync(path.join(STACK_FIXTURE_ROOT, 'runner.cjs'), 'utf8');
    files['.gitignore'] = '\n.stand-output/\n**/target/\n**/build/\nout/\n';
    const executables = [...new Set(manifest.technologies.flatMap(tech => [tech.executable, ...tech.compileExecutable ? [tech.compileExecutable] : []]))];
    for (const executable of executables) {
        files[executable + '.cmd'] = '@echo off\r\nnode .stand/runner.cjs "@' + executable + '" %*\r\n';
        files[executable] = '#!/bin/sh\nexec node .stand/runner.cjs "@' + executable + '" "$@"\n';
    }
    const cases = invocations.flatMap(stackSelectedCases);
    const primary = manifest.suites.find(suite => invocations[0]?.targets.includes(suite.target)) ?? manifest.suites[0];
    return {
        id: manifest.id + '-' + mode, files, executableFiles: executables,
        compileCommand: stackCommand({ ...manifest.technologies[0], executable: manifest.technologies[0].compileExecutable
            ?? manifest.technologies[0].executable }, manifest.technologies[0].compileArgv),
        projectTestCommand: manifest.technologies.map(technology => stackCommand(technology, technology.broadArgv)).join(' && '),
        taskTestCommand: invocations.map(run => run.command).join(' && '),
        taskTestInvocations: invocations.map(run => ({ command: run.command, targets: run.targets })),
        primarySource: primary.source, primaryTest: primary.target, taskTitle: manifest.title + ' task',
        caseCommand: invocations.map(run => run.command).join(' && '), cases,
        trustBoundaryMatrix: [{ boundary_id: 'TB-STACK-001', boundary: 'Partner identity to order authorization',
            authority_source: primary.source, mutable_inputs: ['partner identity'], integrity_evidence: ['source sha256'],
            canonical_reconstruction: 'Reconstruct authorization from task sources.', toctou_replay: 'Reject a replaced partner identity.',
            negative_paths: [{ kind: 'replaced', scenario: 'task-contract', expected_behavior: 'Reject the foreign partner.',
                evidence_files: cases.map(item => item.source + '#task-contract') }] }],
        inspectReviewEvidence: (root, taskId, lane) => {
            if (lane !== 'test') return;
            const plan = JSON.parse(fs.readFileSync(path.join(root, '.git/stand-task.json'), 'utf8')) as StackTaskPlan;
            const observations = stackExecutionViolations(root, plan);
            const violations = blockingStackObservations(observations);
            if (violations.length) throw new Error('Reviewer rejected fixture semantics: ' + violations.join(', '));
            const artifact = JSON.parse(fs.readFileSync(path.join(root, 'garda-agent-orchestrator/runtime/reviews', taskId + '-full-suite-validation.json'), 'utf8'));
            const outputPath = artifact.output_artifact_path;
            const executed: StackExecution[] = [];
            for (const invocation of plan.invocations) {
                const execution = readStackExecutions(root).reverse().find(record => record.purpose === 'own'
                    && record.technology === invocation.technology && record.exitCode === 0);
                if (!execution) throw new Error('Retained output omitted ' + invocation.technology);
                executed.push(execution);
            }
            const captured = executed.map(execution => execution.output).join('\n') + '\n';
            // Green-log compaction remains real: companion bytes are usable only with the native retained digest.
            const output = outputPath ? fs.readFileSync(path.resolve(root, outputPath), 'utf8') : captured;
            if (!outputPath && sha(captured) !== artifact.output_retention?.raw_output_sha256)
                throw new Error('Compacted native output digest does not bind the companion execution bytes');
            for (const execution of executed) if (!output.includes(execution.output))
                throw new Error('Native output omitted ' + execution.technology);
            return observations;
        },
        failedCaseQuote: (root, source, _selector, output) => {
            const observed = readStackExecutions(root).reverse().find(record => record.purpose === 'own' && record.exitCode > 0
                && !record.error && record.checks.some(check => check.target === source && !check.passed && !check.skipped)
                && output.includes(record.output));
            return observed?.output.split('\n').find(line => line.trim());
        },
        passedCaseQuote: (root, source, _selector, output) => {
            const plan = JSON.parse(fs.readFileSync(path.join(root, '.git/stand-task.json'), 'utf8')) as StackTaskPlan;
            if (blockingStackObservations(stackExecutionViolations(root, plan)).length) return undefined;
            const observed = readStackExecutions(root).reverse().find(record => record.exitCode === 0
                && record.checks.some(check => check.target === source && check.passed && !check.skipped)
                && output.includes(record.output));
            return observed?.output.split('\n').find(line => line.trim());
        }
    };
}

/** Explicit manifest identity complements runInputs' byte hashes, including mode and task specifications. */
export function stackMatrixIdentity(): unknown {
    return { oracleVersion: STACK_ORACLE_VERSION, fixtures: STACK_MANIFESTS,
        tasks: JSON.parse(fs.readFileSync(path.join(STACK_FIXTURE_ROOT, 'tasks.json'), 'utf8')),
        inputs: Object.fromEntries(Object.entries(filesBelow(STACK_FIXTURE_ROOT)).sort(([a], [b]) => a.localeCompare(b))
            .map(([file, bytes]) => [file, sha(bytes)])) };
}
