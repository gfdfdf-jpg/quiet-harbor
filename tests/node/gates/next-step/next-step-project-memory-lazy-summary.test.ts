import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../../src/core/next-step-measurement';
import { PROJECT_MEMORY_REQUIRED_FILE_NAMES } from '../../../../src/core/project-memory';
import { createProjectMemoryImpactLifecycleReader, getProjectMemoryImpactLifecycleEvidence, resolveProjectMemoryImpactArtifactRequirement } from '../../../../src/gates/project-memory-impact/project-memory-impact';
import { buildProjectMemoryNextStepSummary } from '../../../../src/gates/next-step/next-step-doc-closeout-readiness';
import {
    ALL_REVIEW_FLAGS,
    buildDefaultWorkflowConfig,
    formatNextStepText,
    makeTempRepo,
    resolveNextStep,
    seedProjectMemoryImpact,
    seedStartedTask,
    TASK_ID,
    writeJson,
    writePreflight
} from './next-step-review-cycle-fixtures';

import { withInvocationReadObservation } from '../../../../src/core/invocation-read-observation';
import { buildNavigationTaskAuditSummary, buildTaskAuditSummary } from '../../../../src/gates/task-audit/task-audit-summary';

const BUNDLE = 'garda-agent-orchestrator';
const PROJECT_MEMORY_SUMMARY_FREE_ROUTE_GATES = new Set(['task-id-casing', 'workflow-config-validation', 'split-required-latch', 'child-task']);

function writeTaskQueue(repoRoot: string, rows: string[]): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '# TASK.md',
        '',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        ...rows,
        ''
    ].join('\n'), 'utf8');
}

function seedLiveAndTemplateProjectMemory(repoRoot: string): string[] {
    const files: string[] = [];
    for (const root of ['live', 'template']) {
        const memoryRoot = path.join(repoRoot, BUNDLE, root, 'docs', 'project-memory');
        fs.mkdirSync(memoryRoot, { recursive: true });
        for (const fileName of PROJECT_MEMORY_REQUIRED_FILE_NAMES) {
            const filePath = path.join(memoryRoot, fileName);
            fs.writeFileSync(filePath, `# ${fileName}\n\nConfirmed project memory content.\n`, 'utf8');
            files.push(filePath);
        }
    }
    return files;
}

function writeWorkflowConfig(repoRoot: string, projectMemoryRequired: boolean, mutate?: (config: Record<string, unknown>) => void): void {
    const config = buildDefaultWorkflowConfig();
    config.full_suite_validation.enabled = false;
    config.full_suite_validation.command = 'npm test';
    config.review_execution_policy = { mode: 'code_first_optional' };
    config.project_memory_maintenance.enabled = true;
    config.project_memory_maintenance.mode = 'check';
    config.project_memory_maintenance.run_before_final_closeout = projectMemoryRequired;
    const record = config as unknown as Record<string, unknown>;
    mutate?.(record);
    writeJson(path.join(repoRoot, BUNDLE, 'live', 'config', 'workflow-config.json'), record);
}

function measure<T>(read: () => T): { result: T; measurement: NextStepMeasurement } {
    let measurement: NextStepMeasurement | undefined;
    const result = withNextStepMeasurement(read, (value) => { measurement = value; });
    assert.ok(measurement);
    return { result, measurement };
}

function projectMemoryHashes(measurement: NextStepMeasurement): string[] {
    return Object.entries(measurement.work)
        .filter(([key]) => key.startsWith('file_hash:'))
        .filter(([key]) => /[\\/]docs[\\/]project-memory[\\/]/u.test(key))
        .flatMap(([key, count]) => Array.from({ length: count }, () => key.slice('file_hash:'.length)));
}

function allHashCount(measurement: NextStepMeasurement): number {
    return Object.entries(measurement.work)
        .filter(([key]) => key.startsWith('file_hash:'))
        .reduce((total, [, count]) => total + count, 0);
}

interface EarlyRefusal {
    name: string;
    status: string;
    nextGate: string;
    taskId: string;
    arrange(repoRoot: string, projectMemoryRequired: boolean): void;
}

const EARLY_REFUSALS: EarlyRefusal[] = [
    {
        name: 'task-id casing mismatch',
        status: 'BLOCKED',
        nextGate: 'task-id-casing',
        taskId: 'T-NEXT-1',
        arrange(repoRoot, required) {
            writeWorkflowConfig(repoRoot, required);
            writeTaskQueue(repoRoot, [
                '| T-next-1 | DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-next-2`. |',
                '| T-next-2 | TODO | P1 | workflow | Child | gpt-5.4 | 2026-05-05 | strict | Next. |'
            ]);
        }
    },
    {
        name: 'decomposed parent hands off to its child task',
        status: 'DECOMPOSED',
        nextGate: 'child-task',
        taskId: 'T-570',
        arrange(repoRoot, required) {
            writeWorkflowConfig(repoRoot, required);
            writeTaskQueue(repoRoot, [
                '| T-570 | DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-571` through `T-572`. |',
                '| T-571 | TODO | P1 | workflow | Child | gpt-5.4 | 2026-05-05 | strict | Next. |',
                '| T-572 | TODO | P1 | workflow | Later child | gpt-5.4 | 2026-05-05 | strict | Later. |'
            ]);
        }
    },
    {
        name: 'split-required row without latch evidence',
        status: 'BLOCKED',
        nextGate: 'split-required-latch',
        taskId: 'T-634',
        arrange(repoRoot, required) {
            writeWorkflowConfig(repoRoot, required);
            writeTaskQueue(repoRoot, [
                '| T-634 | 🟫 SPLIT_REQUIRED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Child tasks: `T-635`. |',
                '| T-635 | 🟦 TODO | P1 | workflow | Child | gpt-5.4 | 2026-05-05 | strict | Possible child. |'
            ]);
        }
    },
    {
        name: 'invalid scope budget guard config after preflight',
        status: 'BLOCKED',
        nextGate: 'workflow-config-validation',
        taskId: TASK_ID,
        arrange(repoRoot, required) {
            writeWorkflowConfig(repoRoot, required, (config) => {
                config.scope_budget_guard = {
                    enabled: true,
                    profiles: ['strict'],
                    action: 'BLOCK_SOMEHOW',
                    max_files: 12,
                    max_changed_lines: 1200,
                    max_required_reviews: 6,
                    max_review_tokens: 20000
                };
            });
            seedStartedTask(repoRoot, TASK_ID);
            writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        }
    }
];

describe('next-step project-memory summary is built only on routes that use it', () => {
    for (const projectMemoryRequired of [false, true]) {
        for (const route of EARLY_REFUSALS) {
            it(`${route.status}/${route.nextGate} (${route.name}, impact required=${projectMemoryRequired}) builds no project-memory summary`, (t) => {
                const repoRoot = makeTempRepo();
                seedLiveAndTemplateProjectMemory(repoRoot);
                route.arrange(repoRoot, projectMemoryRequired);

                const { result, measurement } = measure(() => resolveNextStep({ taskId: route.taskId, repoRoot }));

                assert.equal(result.status, route.status, result.reason);
                assert.equal(result.next_gate, route.nextGate, result.reason);
                t.diagnostic(`file_hash total=${allHashCount(measurement)}`);
                assert.deepEqual(projectMemoryHashes(measurement), [], 'A missing impact artifact cannot be made current by hashing memory documents');
                assert.notEqual(result.audit_status, 'PASS');
                assert.equal(result.project_memory, null);
                assert.equal(formatNextStepText(result).includes('Project memory:'), false);
            });
        }
    }

    it('a route that reports the summary builds it from the current documents and sees a changed document', (t) => {
        const repoRoot = makeTempRepo();
        const memoryFiles = seedLiveAndTemplateProjectMemory(repoRoot);
        writeWorkflowConfig(repoRoot, true);
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writePreflight(repoRoot, TASK_ID, ALL_REVIEW_FLAGS);
        seedProjectMemoryImpact(repoRoot, TASK_ID);
        const eagerSummary = () => buildProjectMemoryNextStepSummary(
            repoRoot,
            getProjectMemoryImpactLifecycleEvidence({ repoRoot, taskId: TASK_ID, preflightPath }),
            { taskId: TASK_ID, preflightPath }
        );

        const current = measure(() => resolveNextStep({ taskId: TASK_ID, repoRoot }));
        assert.equal(PROJECT_MEMORY_SUMMARY_FREE_ROUTE_GATES.has(String(current.result.next_gate)), false, current.result.reason);
        assert.ok(projectMemoryHashes(current.measurement).length > 0, 'The summary route must assess project memory');
        assert.equal(current.result.project_memory?.required, true);
        assert.equal(current.result.project_memory?.evidence_status, 'CURRENT');
        assert.deepEqual(current.result.project_memory, eagerSummary());

        const compactPath = memoryFiles.find((filePath) => filePath.replace(/\\/gu, '/').endsWith('/live/docs/project-memory/compact.md'));
        assert.ok(compactPath);
        fs.writeFileSync(compactPath, '# compact.md\n\nChanged after the impact artifact was recorded.\n', 'utf8');

        const changed = measure(() => resolveNextStep({ taskId: TASK_ID, repoRoot }));
        t.diagnostic(`file_hash total current=${allHashCount(current.measurement)} changed=${allHashCount(changed.measurement)}`);
        // The changed document is also new workspace scope, so routing moves on; that route still reports the summary.
        assert.equal(PROJECT_MEMORY_SUMMARY_FREE_ROUTE_GATES.has(String(changed.result.next_gate)), false, changed.result.reason);
        assert.ok(projectMemoryHashes(changed.measurement).length > 0);
        assert.equal(changed.result.project_memory?.evidence_status, 'STALE');
        assert.match(changed.result.project_memory?.visible_summary_line ?? '', /evidence=STALE/u);
        assert.match(formatNextStepText(changed.result), /Project memory: enabled; mode=check; required=true; evidence=STALE/u);
        assert.deepEqual(changed.result.project_memory, eagerSummary());
    });
});


describe('navigation audit project-memory evidence acquisition', () => {
    function arrange() {
        const repoRoot = makeTempRepo();
        seedLiveAndTemplateProjectMemory(repoRoot);
        writeWorkflowConfig(repoRoot, true);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, ALL_REVIEW_FLAGS);
        const input = { repoRoot, taskId: TASK_ID };
        return { repoRoot, input, artifact: resolveProjectMemoryImpactArtifactRequirement(input).artifact_path };
    }

    it('keeps the missing gate blocked without document hashing, while explicit audit remains exhaustive', () => {
        const { input } = arrange();
        const navigation = measure(() => withInvocationReadObservation(() => {
            const audit = buildNavigationTaskAuditSummary(input);
            return { status: audit.status, gate: audit.gates.find(g => g.gate === 'project-memory-impact'), blockers: audit.blockers };
        }));
        assert.deepEqual(projectMemoryHashes(navigation.measurement), []);
        assert.equal(navigation.result.status, 'BLOCKED');
        assert.equal(navigation.result.gate?.status, 'MISSING');
        assert.ok(navigation.result.blockers.some(b => b.gate === 'project-memory-impact' && b.reason.includes('MISSING')));
        const explicit = measure(() => withInvocationReadObservation(() => buildTaskAuditSummary(input)));
        assert.ok(projectMemoryHashes(explicit.measurement).length > 0);
        assert.equal(explicit.result.status, navigation.result.status);
        assert.equal(explicit.result.gates.find(g => g.gate === 'project-memory-impact')?.status, 'MISSING');
        assert.notEqual(explicit.result.final_report_contract.status, 'READY');
    });

    it('assesses existing evidence and detects changed documents in the next invocation', () => {
        const { repoRoot, input } = arrange();
        seedProjectMemoryImpact(repoRoot, TASK_ID);
        const read = () => withInvocationReadObservation(() => {
            const audit = buildNavigationTaskAuditSummary(input);
            return { status: audit.status, blockers: audit.blockers };
        });
        const current = measure(read);
        assert.ok(projectMemoryHashes(current.measurement).length > 0);
        assert.ok(!current.result.blockers.some(b => b.gate === 'project-memory-impact'));
        fs.appendFileSync(path.join(repoRoot, BUNDLE, 'live/docs/project-memory/compact.md'), '\nChanged after evidence.\n');
        const stale = measure(read);
        assert.ok(projectMemoryHashes(stale.measurement).length > 0);
        assert.equal(stale.result.status, 'BLOCKED');
        assert.ok(stale.result.blockers.some(b => b.gate === 'project-memory-impact' && b.reason.includes('STALE')));
        assert.ok(buildTaskAuditSummary(input).blockers.some(b => b.gate === 'project-memory-impact' && b.reason.includes('STALE')));
    });

    it('does not treat a malformed existing artifact as absent', () => {
        const { input, artifact } = arrange();
        fs.mkdirSync(path.dirname(artifact), { recursive: true });
        fs.writeFileSync(artifact, '{invalid');
        const checked = measure(() => withInvocationReadObservation(() => {
            const audit = buildNavigationTaskAuditSummary(input);
            return audit.blockers;
        }));
        assert.ok(projectMemoryHashes(checked.measurement).length > 0);
        assert.ok(checked.result.some(b => b.gate === 'project-memory-impact' && b.reason.includes('INVALID')));
    });

    it('rejects an absent artifact appearing before the invocation finishes', () => {
        const { input, artifact } = arrange();
        assert.throws(() => withInvocationReadObservation(() => {
            const audit = buildNavigationTaskAuditSummary(input);
            assert.notEqual(audit.status, 'PASS');
            fs.mkdirSync(path.dirname(artifact), { recursive: true });
            fs.writeFileSync(artifact, '{}');
        }), /Invocation file observation changed|Invocation .*changed/u);
    });
});

it('a lazy lifecycle reader rejects workflow changes before its invocation returns', () => {
    const repoRoot = makeTempRepo();
    writeWorkflowConfig(repoRoot, false);
    assert.throws(() => withInvocationReadObservation(() => {
        const reader = createProjectMemoryImpactLifecycleReader({ repoRoot, taskId: TASK_ID });
        assert.equal(reader.required, false);
        writeWorkflowConfig(repoRoot, true);
        reader.read();
    }), /Invocation file observation changed/u);
});
