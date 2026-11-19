import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runUpdate } from '../../../src/lifecycle/update';
import { runSnapshotRollback } from '../../../src/lifecycle/rollback';
import {
    formatRetiredSkillCopyOutcomes,
    removeShippedRetiredSkillCopies,
    type RetiredSkillCopyOutcome
} from '../../../src/lifecycle/retired-skill-removal';
import { listSkillPacks, validateSkillPacks } from '../../../src/runtime/skills';
import { formatVerifyResult, runVerify } from '../../../src/validators/verify';
import { TEST_COMPILE_GATE_COMMAND, writeTestCompileFixture } from '../cli/commands/gate-test-repo-bootstrap';
import {
    latestReleasedRetiredSkillCopy,
    readReleasedRetiredSkillCopies,
    readTree,
    writeRetiredSkillCopy,
    type ReleasedRetiredSkillCopy
} from '../runtime/retired-skill-fixtures';

const REMOVED = 'unmodified copy shipped by an earlier release';

function findRepoRoot(): string {
    let current = __dirname;
    while (current !== path.dirname(current)) {
        if (fs.existsSync(path.join(current, 'VERSION')) && fs.existsSync(path.join(current, 'template'))) return current;
        current = path.dirname(current);
    }
    throw new Error('Cannot resolve repo root.');
}

interface Workspace {
    projectRoot: string;
    bundleRoot: string;
    liveSkillsRoot: string;
    answersPath: string;
}

/** An existing installation updated from the current bundle; leftover copies are seeded by the caller. */
function setupWorkspace(t: TestContext): Workspace {
    const repoRoot = findRepoRoot();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-retired-removal-'));
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
    const bundleRoot = path.join(projectRoot, 'garda-agent-orchestrator');
    fs.mkdirSync(bundleRoot, { recursive: true });
    for (const file of ['.gitattributes', 'AGENT_INIT_PROMPT.md', 'CHANGELOG.md', 'HOW_TO.md', 'LICENSE', 'MANIFEST.md', 'README.md', 'VERSION', 'package.json']) {
        fs.copyFileSync(path.join(repoRoot, file), path.join(bundleRoot, file));
    }
    for (const directory of ['bin', 'dist', 'template']) {
        fs.cpSync(path.join(repoRoot, directory), path.join(bundleRoot, directory), { recursive: true });
    }
    fs.mkdirSync(path.join(bundleRoot, 'live', 'docs', 'agent-rules'), { recursive: true });
    writeTestCompileFixture(projectRoot);
    const workflowConfigPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
    fs.mkdirSync(path.dirname(workflowConfigPath), { recursive: true });
    fs.writeFileSync(workflowConfigPath, JSON.stringify({ compile_gate: { command: TEST_COMPILE_GATE_COMMAND } }, null, 2), 'utf8');
    fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(bundleRoot, 'runtime'), { recursive: true });
    const answersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');
    fs.writeFileSync(answersPath, JSON.stringify({
        AssistantLanguage: 'English', AssistantBrevity: 'concise', SourceOfTruth: 'Claude', EnforceNoAutoCommit: 'false',
        ClaudeOrchestratorFullAccess: 'false', TokenEconomyEnabled: 'true', CollectedVia: 'CLI_NONINTERACTIVE'
    }, null, 2), 'utf8');
    fs.mkdirSync(path.join(projectRoot, '.git', 'hooks'), { recursive: true });
    return {
        projectRoot,
        bundleRoot,
        liveSkillsRoot: path.join(bundleRoot, 'live', 'skills'),
        answersPath: path.relative(projectRoot, answersPath).replace(/\\/g, '/')
    };
}

function update(workspace: Workspace, options: Partial<Parameters<typeof runUpdate>[0]> = {}) {
    return runUpdate({
        targetRoot: workspace.projectRoot,
        bundleRoot: workspace.bundleRoot,
        initAnswersPath: workspace.answersPath,
        skipVerify: true,
        skipManifestValidation: true,
        ...options
    });
}

function outcomes(result: unknown): RetiredSkillCopyOutcome[] {
    return (result as { retiredSkillCopies: RetiredSkillCopyOutcome[] }).retiredSkillCopies;
}

function actionOf(result: unknown, skillId: string): RetiredSkillCopyOutcome {
    const outcome = outcomes(result).find((entry) => entry.skillId === skillId);
    assert.ok(outcome, skillId);
    return outcome;
}

function verifyRunner(options: { targetRoot: string; sourceOfTruth: string; initAnswersPath: string }) {
    const result = runVerify(options);
    if (!result.passed) throw new Error(formatVerifyResult(result));
    return result;
}

test('update removes an unmodified copy of every released version and reports it', (t) => {
    const copies = readReleasedRetiredSkillCopies();
    const orchestration = copies.filter((copy) => copy.skillId === 'orchestration');
    const depth1 = copies.filter((copy) => copy.skillId === 'orchestration-depth1');
    assert.equal(orchestration.length, 6);
    assert.equal(depth1.length, 4);
    for (let index = 0; index < orchestration.length; index += 1) {
        const pair: ReleasedRetiredSkillCopy[] = [orchestration[index], depth1[index % depth1.length]];
        const workspace = setupWorkspace(t);
        for (const copy of pair) writeRetiredSkillCopy(workspace.bundleRoot, copy);
        const result = update(workspace);
        for (const copy of pair) {
            const label = `${copy.skillId} ${copy.releases.join(', ')}`;
            assert.equal(fs.existsSync(path.join(workspace.liveSkillsRoot, copy.skillId)), false, label);
            assert.deepEqual(actionOf(result, copy.skillId), { skillId: copy.skillId, action: 'removed', reason: REMOVED }, label);
        }
        const report = fs.readFileSync(path.join(workspace.projectRoot, result.updateReportPath), 'utf8');
        assert.match(report, /## Retired Skill Copies\r?\n- orchestration: removed \(unmodified copy shipped by an earlier release\)/u);
        assert.equal(fs.existsSync(path.join(workspace.bundleRoot, 'runtime', 'retired-skill-removal')), true);
        assert.deepEqual(fs.readdirSync(path.join(workspace.bundleRoot, 'runtime', 'retired-skill-removal')), [], 'moved copies are deleted');
    }
});

test('verify passes after removal and the headlines no longer hash the removed manifests', (t) => {
    const workspace = setupWorkspace(t);
    writeRetiredSkillCopy(workspace.bundleRoot, latestReleasedRetiredSkillCopy('orchestration'));
    writeRetiredSkillCopy(workspace.bundleRoot, latestReleasedRetiredSkillCopy('orchestration-depth1'));
    const result = update(workspace, { skipVerify: false, verifyRunner });
    assert.equal(result.verifyStatus, 'PASS');
    assert.deepEqual(outcomes(result).map((entry) => entry.action), ['removed', 'removed']);
    const verifyResult = runVerify({ targetRoot: workspace.projectRoot, sourceOfTruth: 'Claude', initAnswersPath: workspace.answersPath });
    assert.equal(verifyResult.passed, true, formatVerifyResult(verifyResult));
    assert.deepEqual(validateSkillPacks(workspace.bundleRoot).issues, []);
    assert.deepEqual(listSkillPacks(workspace.bundleRoot, { refreshHeadlines: false }).ignoredRetiredSkillDirectories, []);
});

test('a copy with one byte changed, an extra file or a missing file is kept byte-identical and still ignored', (t) => {
    const mutations: Array<[string, string, (skillRoot: string) => void]> = [
        ['orchestration', 'one byte changed', (skillRoot) => {
            const file = path.join(skillRoot, 'references', 'stage-gates.md');
            const bytes = fs.readFileSync(file);
            bytes[0] = bytes[0] === 0x23 ? 0x2a : 0x23;
            fs.writeFileSync(file, bytes);
        }],
        ['orchestration-depth1', 'extra file', (skillRoot) => fs.writeFileSync(path.join(skillRoot, 'my-notes.md'), 'Keep me.\n')],
        ['orchestration', 'missing file', (skillRoot) => fs.rmSync(path.join(skillRoot, 'references', 'review-trigger-matrix.md'))]
    ];
    for (const [skillId, label, mutate] of mutations) {
        const workspace = setupWorkspace(t);
        const skillRoot = writeRetiredSkillCopy(workspace.bundleRoot, latestReleasedRetiredSkillCopy(skillId));
        mutate(skillRoot);
        const before = readTree(skillRoot);
        const result = update(workspace);
        assert.deepEqual(readTree(skillRoot), before, label);
        const outcome = actionOf(result, skillId);
        assert.equal(outcome.action, 'kept', label);
        assert.match(outcome.reason, /^modified or unrecognised copy; ignored and still content-scanned \(/u, label);
        assert.ok(listSkillPacks(workspace.bundleRoot, { refreshHeadlines: false }).ignoredRetiredSkillDirectories.includes(skillId), label);
    }
});

test('dry-run removes nothing and reports the plan; a second update is a no-op', (t) => {
    const workspace = setupWorkspace(t);
    const shippedRoot = writeRetiredSkillCopy(workspace.bundleRoot, latestReleasedRetiredSkillCopy('orchestration'));
    const modifiedRoot = writeRetiredSkillCopy(workspace.bundleRoot, latestReleasedRetiredSkillCopy('orchestration-depth1'));
    fs.appendFileSync(path.join(modifiedRoot, 'SKILL.md'), 'Local addition.\n');
    const shippedBefore = readTree(shippedRoot);
    const modifiedBefore = readTree(modifiedRoot);

    const planned = update(workspace, { dryRun: true });
    assert.deepEqual(readTree(shippedRoot), shippedBefore);
    assert.deepEqual(readTree(modifiedRoot), modifiedBefore);
    assert.deepEqual(outcomes(planned).map((entry) => entry.action), ['would-remove', 'would-keep']);
    assert.deepEqual(formatRetiredSkillCopyOutcomes(outcomes(planned))[0], 'orchestration: would remove (unmodified copy shipped by an earlier release)');
    assert.match(formatRetiredSkillCopyOutcomes(outcomes(planned))[1],
        /^orchestration-depth1: would keep \(modified or unrecognised copy; ignored and still content-scanned \(content differs from every shipped copy\)\)$/u);

    const applied = update(workspace);
    assert.deepEqual(outcomes(applied).map((entry) => entry.action), ['removed', 'kept']);
    const again = update(workspace);
    assert.deepEqual(outcomes(again).map((entry) => entry.action), ['absent', 'kept']);
    assert.deepEqual(formatRetiredSkillCopyOutcomes(outcomes(again))[0], 'orchestration: not present');
    assert.deepEqual(readTree(modifiedRoot), modifiedBefore);
});

test('a failed update after the removal rolls back and restores the removed copy; snapshot rollback restores it too', async (t) => {
    const workspace = setupWorkspace(t);
    const skillRoot = writeRetiredSkillCopy(workspace.bundleRoot, latestReleasedRetiredSkillCopy('orchestration'));
    const before = readTree(skillRoot);
    let removedBeforeFailure = false;
    assert.throws(() => update(workspace, {
        skipManifestValidation: false,
        manifestRunner: () => {
            removedBeforeFailure = !fs.existsSync(skillRoot);
            throw new Error('Simulated manifest failure after removal.');
        }
    }), /Update failed during MANIFEST_VALIDATION and rollback completed successfully/u);
    assert.equal(removedBeforeFailure, true, 'the copy was removed before the failing stage');
    assert.deepEqual(readTree(skillRoot), before, 'rollback restores the removed copy');

    const applied = update(workspace);
    assert.equal(actionOf(applied, 'orchestration').action, 'removed');
    assert.equal(fs.existsSync(skillRoot), false);
    await runSnapshotRollback({ targetRoot: workspace.projectRoot, bundleRoot: workspace.bundleRoot, snapshotPath: applied.rollbackSnapshotPath });
    assert.deepEqual(readTree(skillRoot), before, 'snapshot rollback restores the removed copy');
});

test('update refuses a linked live copy before any removal, leaving it untouched', (t) => {
    const workspace = setupWorkspace(t);
    const outside = path.join(workspace.projectRoot, 'outside-skill');
    writeRetiredSkillCopy(path.join(outside, 'bundle'), latestReleasedRetiredSkillCopy('orchestration'));
    const target = path.join(outside, 'bundle', 'live', 'skills', 'orchestration');
    const before = readTree(target);
    fs.symlinkSync(target, path.join(workspace.liveSkillsRoot, 'orchestration'), 'junction');
    assert.throws(() => update(workspace), /Refusing to copy symlink or junction source/u);
    assert.ok(fs.lstatSync(path.join(workspace.liveSkillsRoot, 'orchestration')).isSymbolicLink());
    assert.deepEqual(readTree(target), before);
});

test('removal keeps a linked copy, and a failed move leaves the copy intact while a failed delete leaves live clean', (t) => {
    const workspace = setupWorkspace(t);
    const outside = path.join(workspace.projectRoot, 'outside-skill');
    writeRetiredSkillCopy(path.join(outside, 'bundle'), latestReleasedRetiredSkillCopy('orchestration'));
    fs.symlinkSync(path.join(outside, 'bundle', 'live', 'skills', 'orchestration'), path.join(workspace.liveSkillsRoot, 'orchestration'), 'junction');
    const depth1Root = writeRetiredSkillCopy(workspace.bundleRoot, latestReleasedRetiredSkillCopy('orchestration-depth1'));
    fs.mkdirSync(path.join(workspace.bundleRoot, 'live', 'config'), { recursive: true });
    const depth1Before = readTree(depth1Root);

    const busy = removeShippedRetiredSkillCopies(workspace.projectRoot, workspace.bundleRoot, {
        rename: () => { throw Object.assign(new Error('resource busy'), { code: 'EBUSY' }); },
        removeStaged: () => { throw new Error('not reached'); }
    });
    assert.deepEqual(busy, [
        { skillId: 'orchestration', action: 'kept', reason: 'link; not followed, ignored (the skill directory is a link)' },
        { skillId: 'orchestration-depth1', action: 'kept', reason: 'could not remove (EBUSY); left intact and ignored' }
    ]);
    assert.deepEqual(readTree(depth1Root), depth1Before);
    assert.ok(fs.lstatSync(path.join(workspace.liveSkillsRoot, 'orchestration')).isSymbolicLink());

    const lockedDelete = removeShippedRetiredSkillCopies(workspace.projectRoot, workspace.bundleRoot, {
        rename: (from, to) => fs.renameSync(from, to),
        removeStaged: () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); }
    });
    const depth1Outcome = lockedDelete.find((entry) => entry.skillId === 'orchestration-depth1');
    assert.equal(depth1Outcome?.action, 'removed');
    assert.match(depth1Outcome?.reason || '', /; moved copy left at garda-agent-orchestrator\/runtime\/retired-skill-removal\/orchestration-depth1-/u);
    assert.equal(fs.existsSync(depth1Root), false, 'live/skills holds no partial copy');
    const staged = fs.readdirSync(path.join(workspace.bundleRoot, 'runtime', 'retired-skill-removal'));
    assert.equal(staged.length, 1);
    assert.deepEqual(readTree(path.join(workspace.bundleRoot, 'runtime', 'retired-skill-removal', staged[0])), depth1Before);
});

test('a copy that changes between classification and the move is moved back and kept, never deleted', (t) => {
    const workspace = setupWorkspace(t);
    update(workspace);
    const skillRoot = writeRetiredSkillCopy(workspace.bundleRoot, latestReleasedRetiredSkillCopy('orchestration'));
    let edited: Map<string, Buffer> | null = null;
    const result = removeShippedRetiredSkillCopies(workspace.projectRoot, workspace.bundleRoot, {
        rename: (from, to) => {
            if (from === skillRoot) {
                fs.appendFileSync(path.join(from, 'SKILL.md'), 'Saved by an editor during the update.\n');
                edited = readTree(from);
            }
            fs.renameSync(from, to);
        },
        removeStaged: () => { throw new Error('a changed copy must not be deleted'); }
    });
    assert.deepEqual(result.find((entry) => entry.skillId === 'orchestration'), {
        skillId: 'orchestration',
        action: 'kept',
        reason: 'the copy changed during the update or setup; moved back to live/skills and kept, ignored and still content-scanned'
    });
    assert.ok(edited);
    assert.deepEqual(readTree(skillRoot), edited, 'the edited copy is back in live/skills byte-for-byte');
    assert.deepEqual(fs.readdirSync(path.join(workspace.bundleRoot, 'runtime', 'retired-skill-removal')), []);
    assert.deepEqual(validateSkillPacks(workspace.bundleRoot).issues, []);
});

test('a changed copy that cannot be moved back stays in staging, is reported as kept and leaves live consistent', (t) => {
    const workspace = setupWorkspace(t);
    update(workspace);
    const skillRoot = writeRetiredSkillCopy(workspace.bundleRoot, latestReleasedRetiredSkillCopy('orchestration'));
    let calls = 0;
    let edited: Map<string, Buffer> | null = null;
    const result = removeShippedRetiredSkillCopies(workspace.projectRoot, workspace.bundleRoot, {
        rename: (from, to) => {
            calls += 1;
            if (calls > 1) throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
            fs.appendFileSync(path.join(from, 'SKILL.md'), 'Saved during the update.\n');
            edited = readTree(from);
            fs.renameSync(from, to);
        },
        removeStaged: () => { throw new Error('a changed copy must not be deleted'); }
    });
    const outcome = result.find((entry) => entry.skillId === 'orchestration');
    assert.equal(outcome?.action, 'kept');
    assert.match(outcome?.reason || '', /^the copy changed during the update or setup; could not move it back \(EBUSY\), left intact at garda-agent-orchestrator\/runtime\/retired-skill-removal\/orchestration-[0-9a-f-]+$/u);
    assert.equal(fs.existsSync(skillRoot), false, 'live/skills holds no partial copy');
    const staged = fs.readdirSync(path.join(workspace.bundleRoot, 'runtime', 'retired-skill-removal'));
    assert.equal(staged.length, 1);
    assert.deepEqual(readTree(path.join(workspace.bundleRoot, 'runtime', 'retired-skill-removal', staged[0])), edited);
    assert.deepEqual(validateSkillPacks(workspace.bundleRoot).issues, [], 'index and headlines match live/skills');
    const verifyResult = runVerify({ targetRoot: workspace.projectRoot, sourceOfTruth: 'Claude', initAnswersPath: workspace.answersPath });
    assert.equal(verifyResult.passed, true, formatVerifyResult(verifyResult));
});

test('a link placed at the staging directory beforehand is refused and the copy is kept', (t) => {
    const workspace = setupWorkspace(t);
    const skillRoot = writeRetiredSkillCopy(workspace.bundleRoot, latestReleasedRetiredSkillCopy('orchestration'));
    const before = readTree(skillRoot);
    const outside = path.join(workspace.projectRoot, 'outside-staging');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(workspace.bundleRoot, 'runtime', 'retired-skill-removal'), 'junction');
    const result = removeShippedRetiredSkillCopies(workspace.projectRoot, workspace.bundleRoot);
    const outcome = result.find((entry) => entry.skillId === 'orchestration');
    assert.equal(outcome?.action, 'kept');
    assert.match(outcome?.reason || '', /^could not remove \(.+\); left intact and ignored$/u);
    assert.deepEqual(readTree(skillRoot), before);
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing was moved through the link');
});
