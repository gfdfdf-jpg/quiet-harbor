import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { WalkStep } from './engine/navigator-walk';
import { seedWalkFixture } from './engine/walk-fixture';
import { archiveStackTaskEvidence, inspectStackTaskArchive } from './engine/walk-stack-parent';
import { STACK_MANIFESTS, STACK_FIXTURE_ROOT, readStackExecutions, stackCommand, stackExecutionViolations,
    stackInvocations, type StackManifest, type StackMode, type StackTaskPlan } from './engine/walk-stack-fixtures';
import { applyStackEdits, stackScenario, stackSourceEdit, stackTestEdit } from './engine/walk-stack-scenarios';

const CHILDREN = ['T-WALK-1', 'T-WALK-2'];
const STEPS = [{ gate: 'child-task', exitCode: 0 }] as WalkStep[];

function childPlan(manifest: StackManifest, mode: StackMode, index: number): StackTaskPlan {
    const suite = manifest.suites[index], technology = manifest.technologies.find(item => item.id === suite.technology)!;
    const argv = index === 0 || manifest.technologies.length > 1 ? technology.firstArgv : technology.secondArgv;
    return { archetype: 9, mode, invocations: [{ technology: technology.id, argv, targets: [suite.target],
        command: stackCommand(technology, argv) }] };
}

function run(root: string, technology: string, argv: string[]): number | null {
    const result = spawnSync(process.execPath, [path.join(STACK_FIXTURE_ROOT, 'runner.cjs'), technology, ...argv],
        { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    assert.ifError(result.error);
    assert.notEqual(result.status, null, result.stderr);
    return result.status;
}

function archiveFile(root: string, id: string, file: string): string {
    return path.join(root, '.git/stand-task-archives', id, file);
}

for (const manifest of STACK_MANIFESTS) for (const mode of manifest.adapter ? ['generic', 'auto'] as const : ['generic'] as const) {
    test(`A9 ${manifest.id}/${mode}: isolate child plans and retain both complete journals`, async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-stack-parent-'));
        try {
            const scenario = stackScenario(manifest, 9, mode);
            seedWalkFixture(root, scenario.fixture!);
            fs.mkdirSync(path.join(root, '.git'));
            const config = path.join(root, 'garda-agent-orchestrator/live/config');
            fs.mkdirSync(config, { recursive: true });
            fs.writeFileSync(path.join(config, 'workflow-config.json'), '{}');
            scenario.configure!(root);
            const parentPlan = fs.readFileSync(path.join(root, '.git/stand-task.json'));
            const technology = manifest.technologies[0];
            assert.equal(run(root, technology.id, technology.compileArgv), 0);
            const parentJournal = fs.readFileSync(path.join(root, '.git/stand-invocations.jsonl'));

            assert.equal(await scenario.act!(root, 'child-task', [], async () => {}), true);
            await scenario.prepare!(root, STEPS, async () => { assert.fail('No native gate is needed at the task boundary'); });
            assert.deepEqual(fs.readFileSync(archiveFile(root, 'T-WALK', 'plan.json')), parentPlan);
            assert.deepEqual(fs.readFileSync(archiveFile(root, 'T-WALK', 'invocations.jsonl')), parentJournal);
            assert.deepEqual(readStackExecutions(root), [], 'The new child starts with its own empty journal');
            const firstPlan = childPlan(manifest, mode, 0), secondPlan = childPlan(manifest, mode, 1);
            assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.git/stand-task.json'), 'utf8')), { ...firstPlan, repoRoot: root });
            assert.equal(scenario.testSelectionCommand, firstPlan.invocations[0].command);
            assert.deepEqual(scenario.fixture!.cases.map(item => item.source), firstPlan.invocations[0].targets);

            const first = firstPlan.invocations[0];
            assert.equal(run(root, first.technology, first.argv), 1, 'Retain the real failed attempt as well as GREEN');
            const failedJournal = fs.readFileSync(path.join(root, '.git/stand-invocations.jsonl'));
            await scenario.prepare!(root, STEPS, async () => {});
            assert.deepEqual(fs.readFileSync(path.join(root, '.git/stand-invocations.jsonl')), failedJournal,
                'Repeated preparation within a child must preserve every attempt');
            assert.equal(await scenario.act!(root, 'implementation', [], async () => {}), true);
            assert.equal(run(root, first.technology, first.argv), 0);
            const firstJournal = fs.readFileSync(path.join(root, '.git/stand-invocations.jsonl'));
            archiveStackTaskEvidence(root, CHILDREN[0]);

            fs.writeFileSync(path.join(root, '.git/stand-task.json'), JSON.stringify({ ...secondPlan, repoRoot: root }));
            const second = secondPlan.invocations[0];
            assert.equal(run(root, second.technology, second.argv), 1);
            applyStackEdits(root, [stackSourceEdit(manifest.suites[1], 9), stackTestEdit(manifest.suites[1], 9)]);
            assert.equal(run(root, second.technology, second.argv), 0);
            const secondJournal = fs.readFileSync(path.join(root, '.git/stand-invocations.jsonl'));
            archiveStackTaskEvidence(root, CHILDREN[1]);

            const firstRecords = inspectStackTaskArchive(root, CHILDREN[0], firstPlan);
            const secondRecords = inspectStackTaskArchive(root, CHILDREN[1], secondPlan);
            assert.deepEqual(firstRecords.map(item => item.exitCode), [1, 0]);
            assert.deepEqual(secondRecords.map(item => item.exitCode), [1, 0]);
            assert.deepEqual(fs.readFileSync(archiveFile(root, CHILDREN[0], 'invocations.jsonl')), firstJournal);
            assert.deepEqual(fs.readFileSync(archiveFile(root, CHILDREN[1], 'invocations.jsonl')), secondJournal);
            const mixed = stackExecutionViolations(root, secondPlan, [...firstRecords, ...secondRecords]);
            assert.ok(mixed.includes('wrong-command-or-cwd'), 'Shared oracle still rejects sibling commands');
            assert.ok(mixed.includes('wrong-target-set'), 'Shared oracle still rejects sibling targets');
            assert.equal(fs.existsSync(path.join(root, '.git/stand-invocations.jsonl')), false);
            assert.throws(() => archiveStackTaskEvidence(root, CHILDREN[0]), /EEXIST/u, 'Archives cannot be overwritten');
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
}

test('A9 archive inspection rejects changed plans, unexpected attempts, missing GREEN and stale sources', () => {
    const manifest = STACK_MANIFESTS.find(item => item.id === 'unknown-quartz')!;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-stack-parent-negative-'));
    try {
        seedWalkFixture(root, stackScenario(manifest, 9, 'generic').fixture!);
        fs.mkdirSync(path.join(root, '.git'));
        const plan = childPlan(manifest, 'generic', 0), invocation = plan.invocations[0], suite = manifest.suites[0];
        fs.writeFileSync(path.join(root, '.git/stand-task.json'), JSON.stringify({ ...plan, repoRoot: root }));
        applyStackEdits(root, [stackSourceEdit(suite, 9), stackTestEdit(suite, 9)]);
        assert.equal(run(root, invocation.technology, invocation.argv), 0);
        archiveStackTaskEvidence(root, CHILDREN[0]);
        const planFile = archiveFile(root, CHILDREN[0], 'plan.json'), journalFile = archiveFile(root, CHILDREN[0], 'invocations.jsonl');
        const planBytes = fs.readFileSync(planFile), journalBytes = fs.readFileSync(journalFile);
        fs.writeFileSync(planFile, JSON.stringify({ ...plan, invocations: stackInvocations(manifest, 9), repoRoot: root }));
        assert.throws(() => inspectStackTaskArchive(root, CHILDREN[0], plan), /Archived child plan/u);
        fs.writeFileSync(planFile, planBytes);
        const records = inspectStackTaskArchive(root, CHILDREN[0], plan);
        fs.appendFileSync(journalFile, JSON.stringify({ ...records[0], argv: ['unexpected-attempt'], exitCode: 1 }) + '\n');
        assert.throws(() => inspectStackTaskArchive(root, CHILDREN[0], plan), /wrong-command-or-cwd/u);
        fs.writeFileSync(journalFile, '');
        assert.throws(() => inspectStackTaskArchive(root, CHILDREN[0], plan), /missing-green/u);
        fs.writeFileSync(journalFile, journalBytes);
        fs.appendFileSync(path.join(root, suite.source), '\nchanged after accepted execution\n');
        assert.throws(() => inspectStackTaskArchive(root, CHILDREN[0], plan), /stale-source/u);
        fs.unlinkSync(journalFile);
        assert.throws(() => inspectStackTaskArchive(root, CHILDREN[0], plan), /ENOENT/u);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('A9 Rust expects one FULL API review per child under the established path policy', () => {
    for (const manifest of STACK_MANIFESTS) {
        const scenario = stackScenario(manifest, 9, 'generic');
        const lanes = manifest.id === 'rust' ? ['code', 'security', 'api', 'performance', 'test'] : ['code', 'security', 'performance', 'test'];
        assert.deepEqual(scenario.expectedReviews, Object.fromEntries(lanes.map(lane => [lane, 2])));
        assert.deepEqual(scenario.expectedModes, [...lanes, ...lanes].map(lane => lane + ':FULL'));
        assert.deepEqual(scenario.expectedTaskReviews, Object.fromEntries(CHILDREN.map(id => [id, lanes.map(lane => lane + ':FULL')])));
    }
});
