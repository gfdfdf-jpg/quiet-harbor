import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { runClassifyChangeWithRulePackRebind } from '../../../../../../src/cli/commands/gate-flows/compile/classify-change-rule-pack-rebind';
import { runBindRulePackToPreflightCommand, runLoadRulePackCommand } from '../../../../../../src/cli/commands/gates';
import { getPostPreflightRulePackRebindDecision, getPostPreflightSequenceEvidence } from '../../../../../../src/gates/rule-pack/rule-pack';
import { findStaleLoadedRuleFile, getRulePackRulesRoot } from '../../../../../../src/gates/rule-pack/rule-pack-selection';
import { getRulePackEvidence } from '../../../../../../src/gates/rule-pack/rule-pack-evidence';
import { getRulePackEvidenceViolations } from '../../../../../../src/gates/rule-pack/rule-pack-remediation';
import { resolveReviewTransactionLockPath } from '../../../../../../src/gate-runtime/review/reviews-index';
import { resolveNextStep } from '../../../../gates/next-step/next-step-test-support';
import {
    createTempRepo,
    getReviewsRoot,
    initializeGitRepo,
    loadPostPreflightRulePack,
    loadTaskEntryRulePack,
    readTaskTimelineEvents,
    runEnterTaskMode,
    runHandshakeForTask,
    runShellSmokeForTask,
    seedInitAnswers,
    seedTaskQueue
} from '../../gate-test-helpers';

const taskEventsApi = require('../../../../../../src/gate-runtime/timeline/task-events-io') as typeof import('../../../../../../src/gate-runtime/timeline/task-events-io');
const selectionApi = require('../../../../../../src/gates/rule-pack/rule-pack-selection') as typeof import('../../../../../../src/gates/rule-pack/rule-pack-selection');
const observationApi = require('../../../../../../src/core/invocation-file-observation') as typeof import('../../../../../../src/core/invocation-file-observation');

const INTENT = 'Refresh preflight with unchanged rules';
const TASK_ENTRY_RULES = ['00-core.md', '15-project-memory.md', '40-commands.md', '80-task-workflow.md', '90-skill-catalog.md'];

function setup(taskId: string, options: { rulePackPath?: string; git?: boolean } = {}) {
    const repoRoot = createTempRepo();
    if (options.git) {
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# Instructions\n');
    }
    const appPath = path.join(repoRoot, 'src', 'app.ts');
    fs.mkdirSync(path.dirname(appPath), { recursive: true });
    fs.writeFileSync(appPath, 'const a = 1;\n', 'utf8');
    if (options.git) initializeGitRepo(repoRoot);
    seedTaskQueue(repoRoot, taskId);
    seedInitAnswers(repoRoot);
    runEnterTaskMode({ repoRoot, taskId, taskSummary: INTENT });
    const rulePackPath = options.rulePackPath ? path.join(getReviewsRoot(repoRoot), options.rulePackPath) : '';
    assert.equal((rulePackPath
        ? runLoadRulePackCommand({ repoRoot, taskId, stage: 'TASK_ENTRY', artifactPath: rulePackPath,
            loadedRuleFiles: TASK_ENTRY_RULES, emitMetrics: false })
        : loadTaskEntryRulePack(repoRoot, taskId)).exitCode, 0);
    runHandshakeForTask(repoRoot, taskId);
    runShellSmokeForTask(repoRoot, taskId);
    const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const defaultRulePackPath = path.join(getReviewsRoot(repoRoot), `${taskId}-rule-pack.json`);
    const classify = (changedFiles = ['src/app.ts'], bind?: typeof runBindRulePackToPreflightCommand) =>
        runClassifyChangeWithRulePackRebind({ repoRoot, taskId, taskIntent: INTENT, changedFiles, outputPath: preflightPath,
            emitMetrics: false, ...(rulePackPath ? { rulePackPath } : {}) }, bind);
    const loadPostPreflight = () => loadPostPreflightRulePack(repoRoot, taskId, preflightPath, false, rulePackPath);
    const rulePackEvents = () => readTaskTimelineEvents(repoRoot, taskId).filter(event => event.event_type === 'RULE_PACK_LOADED');
    return { repoRoot, appPath, preflightPath, rulePackPath: rulePackPath || defaultRulePackPath, defaultRulePackPath,
        classify, loadPostPreflight, rulePackEvents };
}

function sha256(file: string): string {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function withRepo(taskId: string, options: Parameters<typeof setup>[1], body: (f: ReturnType<typeof setup>) => void): void {
    const f = setup(taskId, options);
    try { body(f); } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
}

describe('classify-change POST_PREFLIGHT rebinding', () => {
    it('binds unchanged current-cycle rules to the refreshed preflight in the same step', () => withRepo('T-ROUTE-REBIND', {}, f => {
        // No POST_PREFLIGHT rules were read yet: the first classification binds nothing.
        assert.equal(f.classify().rulePackRebind, null);
        assert.equal(f.loadPostPreflight().exitCode, 0);
        const loadedEvents = f.rulePackEvents().length;

        // Field (shop T-007-4 calls 12-15): classify-change, then a separate bind-rule-pack-to-preflight call.
        fs.writeFileSync(f.appPath, 'const a = 2;\n', 'utf8');
        const refreshed = f.classify();
        assert.equal(refreshed.rulePackRebind?.passed, true, refreshed.rulePackRebind?.outputLines.join('\n'));
        assert.equal(refreshed.rulePackRebind?.outputLines[0], 'RULE_PACK_BOUND');
        const events = f.rulePackEvents();
        assert.equal(events.length, loadedEvents + 1, 'One auditable RULE_PACK_LOADED event records the rebinding.');
        const details = events.at(-1)?.details as Record<string, unknown>;
        assert.equal(details.stage, 'POST_PREFLIGHT');
        assert.equal(details.actor, 'orchestrator:rule-pack-rebind');
        const artifact = JSON.parse(fs.readFileSync(f.rulePackPath, 'utf8'));
        assert.equal(artifact.stages.post_preflight.preflight_hash_sha256, sha256(f.preflightPath));
    }));

    it('leaves a refreshed preflight with changed review decisions to load-rule-pack', () => withRepo('T-ROUTE-REBIND-REVIEWS', {}, f => {
        f.classify();
        assert.equal(f.loadPostPreflight().exitCode, 0);
        const loadedEvents = f.rulePackEvents().length;
        const authPath = path.join(f.repoRoot, 'src', 'security', 'auth.ts');
        fs.mkdirSync(path.dirname(authPath), { recursive: true });
        fs.writeFileSync(authPath, 'export const requiresGrant = true;\n', 'utf8');
        const before = JSON.parse(fs.readFileSync(f.preflightPath, 'utf8')).required_reviews;
        const refreshed = f.classify(['src/app.ts', 'src/security/auth.ts']);
        assert.notDeepEqual(JSON.parse(refreshed.outputText).required_reviews, before);
        assert.equal(refreshed.rulePackRebind, null);
        assert.equal(f.rulePackEvents().length, loadedEvents);
    }));

    it('rebinds the custom rule pack that classify-change reads, never the default one', () => withRepo('T-ROUTE-REBIND-CUSTOM',
        { rulePackPath: 'T-ROUTE-REBIND-CUSTOM-custom-rule-pack.json' }, f => {
            f.classify();
            assert.equal(f.loadPostPreflight().exitCode, 0);
            fs.writeFileSync(f.appPath, 'const a = 2;\n', 'utf8');
            const refreshed = f.classify();
            assert.equal(refreshed.rulePackRebind?.passed, true, JSON.stringify(refreshed.rulePackRebind));
            const artifact = JSON.parse(fs.readFileSync(f.rulePackPath, 'utf8'));
            assert.equal(artifact.stages.post_preflight.preflight_hash_sha256, sha256(f.preflightPath));
            assert.equal(fs.existsSync(f.defaultRulePackPath), false, 'The default rule pack is never written.');
        }));

    it('refreshes mixed rule-pack stages through the TASK_ENTRY artifact and reloads POST_PREFLIGHT there', () =>
        withRepo('T-ROUTE-MIXED-PACK', { git: true }, f => {
            const taskId = 'T-ROUTE-MIXED-PACK';
            const customPack = path.join(getReviewsRoot(f.repoRoot), `${taskId}-custom-rule-pack.json`);
            const navigate = () => resolveNextStep({ taskId, repoRoot: f.repoRoot });
            fs.writeFileSync(f.appPath, 'const a = 2;\n', 'utf8');
            f.classify();
            const post = loadPostPreflightRulePack(f.repoRoot, taskId, f.preflightPath, false, customPack);
            assert.equal(post.exitCode, 0, post.outputLines.join('\n'));
            const customBefore = sha256(customPack);
            const mixed = navigate();
            assert.equal(mixed.next_gate, 'load-rule-pack', mixed.reason);
            assert.doesNotMatch(mixed.commands[0].command, /--artifact-path/u);

            fs.writeFileSync(f.appPath, 'const a = 3;\n', 'utf8');
            const refresh = navigate();
            assert.equal(refresh.next_gate, 'classify-change', refresh.reason);
            assert.doesNotMatch(refresh.commands[0].command, /--rule-pack-path/u);
            const classified = f.classify();
            assert.ok(classified.preflightPath);

            const reload = navigate();
            assert.equal(reload.next_gate, 'load-rule-pack', reload.reason);
            const command = reload.commands[0].command;
            const flag = (name: string) => command.match(new RegExp(`--${name} "([^"]+)"`, 'u'))?.[1] ?? '';
            assert.equal(flag('stage'), 'POST_PREFLIGHT');
            assert.equal(flag('artifact-path'), '');
            const loaded = runLoadRulePackCommand({ repoRoot: f.repoRoot, taskId, stage: flag('stage'),
                preflightPath: flag('preflight-path'), artifactPath: flag('artifact-path'), taskModePath: flag('task-mode-path'),
                loadedRuleFiles: [...command.matchAll(/--loaded-rule-file "([^"]+)"/gu)].map(match => match[1]), emitMetrics: false });
            assert.equal(loaded.exitCode, 0, loaded.outputLines.join('\n'));
            assert.equal(sha256(customPack), customBefore);
            assert.notEqual(navigate().next_gate, 'load-rule-pack');
        }));

    it('does not rebind a binding that is already current after byte-identical preflight evidence is restored', () =>
        withRepo('T-ROUTE-REBIND-RESTORED', { git: true }, f => {
            f.classify();
            assert.equal(f.loadPostPreflight().exitCode, 0);
            const original = fs.readFileSync(f.preflightPath, 'utf8');
            const loadedEvents = f.rulePackEvents().length;
            fs.unlinkSync(f.preflightPath);
            const restored = f.classify();
            assert.equal(fs.readFileSync(f.preflightPath, 'utf8'), original, 'The authenticated preflight is restored byte-identical.');
            assert.equal(restored.rulePackRebind, null, JSON.stringify(restored.rulePackRebind));
            assert.equal(f.rulePackEvents().length, loadedEvents, 'No duplicate RULE_PACK_LOADED for a current binding.');
        }));

    it('reports a returned rebind failure as a failure with the navigator command on the same preflight', () =>
        withRepo('T-ROUTE-REBIND-REFUSED', {}, f => {
            f.classify();
            assert.equal(f.loadPostPreflight().exitCode, 0);
            fs.writeFileSync(f.appPath, 'const a = 2;\n', 'utf8');
            const refused = f.classify(undefined, () => ({ outputLines: ['RULE_PACK_BIND_FAILED', 'Reason: refused.'], exitCode: 2 }));
            assert.equal(refused.rulePackRebind?.passed, false);
            assert.equal(refused.rulePackRebind?.outputLines[0], 'RULE_PACK_BIND_FAILED');
            const nextStep = refused.rulePackRebind?.outputLines.at(-1) ?? '';
            assert.ok(nextStep.startsWith('NextStep: '), nextStep);
            assert.ok(nextStep.includes('next-step "T-ROUTE-REBIND-REFUSED" '
                + '--preflight-path "garda-agent-orchestrator/runtime/reviews/T-ROUTE-REBIND-REFUSED-preflight.json"'), nextStep);
        }));

    it('sends a failed rebind of a custom rule pack back to that rule pack and preflight, never the default evidence', () =>
        withRepo('T-ROUTE-REBIND-CUSTOM-REFUSED', { rulePackPath: 'T-ROUTE-REBIND-CUSTOM-REFUSED-custom-rule-pack.json' }, f => {
            f.classify();
            assert.equal(f.loadPostPreflight().exitCode, 0);
            fs.writeFileSync(f.appPath, 'const a = 2;\n', 'utf8');
            const refused = f.classify(undefined, () => ({ outputLines: ['RULE_PACK_BIND_FAILED', 'Reason: refused.'], exitCode: 2 }));
            const nextStep = refused.rulePackRebind?.outputLines.at(-1) ?? '';
            for (const part of ['gate bind-rule-pack-to-preflight --task-id "T-ROUTE-REBIND-CUSTOM-REFUSED"',
                '--preflight-path "garda-agent-orchestrator/runtime/reviews/T-ROUTE-REBIND-CUSTOM-REFUSED-preflight.json"',
                '--artifact-path "garda-agent-orchestrator/runtime/reviews/T-ROUTE-REBIND-CUSTOM-REFUSED-custom-rule-pack.json"']) {
                assert.ok(nextStep.includes(part), nextStep);
            }
            assert.doesNotMatch(nextStep, / next-step /u, 'The navigator cannot carry a custom rule pack.');
        }));

    it('keeps the previous rule-pack artifact when the mandatory rebind event cannot be appended', t =>
        withRepo('T-ROUTE-REBIND-THROWN', {}, f => {
            f.classify();
            assert.equal(f.loadPostPreflight().exitCode, 0);
            const previous = fs.readFileSync(f.rulePackPath);
            const loadedEvents = f.rulePackEvents().length;
            fs.writeFileSync(f.appPath, 'const a = 2;\n', 'utf8');
            const append = taskEventsApi.appendMandatoryTaskEvent;
            t.mock.method(taskEventsApi, 'appendMandatoryTaskEvent', (...args: Parameters<typeof append>) => {
                if (args[2] === 'RULE_PACK_LOADED') throw new Error('timeline unavailable');
                return append(...args);
            });
            const failed = f.classify();
            t.mock.restoreAll();
            assert.equal(failed.rulePackRebind?.passed, false, JSON.stringify(failed.rulePackRebind));
            assert.match(failed.rulePackRebind?.outputLines.join('\n') ?? '', /could not be appended[\s\S]*NextStep: /u);
            assert.ok(fs.readFileSync(f.rulePackPath).equals(previous), 'Nothing was published: the previous artifact stays byte-identical.');
            assert.equal(f.rulePackEvents().length, loadedEvents);
            assert.ok(failed.preflightPath, 'The classification stays recorded.');
        }));

    it('holds the rule-pack artifact lock across its event append, so no other load can pair its event with this stage', t =>
        withRepo('T-ROUTE-LOAD-LOCK', {}, f => {
            f.classify();
            const lockPath = resolveReviewTransactionLockPath(getReviewsRoot(f.repoRoot));
            const append = taskEventsApi.appendMandatoryTaskEvent;
            const lockHeldAtAppend: boolean[] = [];
            t.mock.method(taskEventsApi, 'appendMandatoryTaskEvent', (...args: Parameters<typeof append>) => {
                if (args[2] === 'RULE_PACK_LOADED') lockHeldAtAppend.push(fs.existsSync(lockPath));
                return append(...args);
            });
            const loaded = f.loadPostPreflight();
            t.mock.restoreAll();
            assert.equal(loaded.exitCode, 0, loaded.outputLines.join('\n'));
            assert.deepEqual(lockHeldAtAppend, [true], 'The append runs inside the lock that also covers the publication.');
            assert.equal(getRulePackEvidence(f.repoRoot, 'T-ROUTE-LOAD-LOCK', 'POST_PREFLIGHT', { preflightPath: f.preflightPath })
                .evidence_status, 'PASS');
        }));

    it('never publishes over a stage another load published while this load was built', t =>
        withRepo('T-ROUTE-LOAD-CAS', {}, f => {
            f.classify();
            const loadedEvents = f.rulePackEvents().length;
            const build = selectionApi.buildRuleFileHashes;
            let raced = false;
            t.mock.method(selectionApi, 'buildRuleFileHashes', (root: string, files: string[]) => {
                if (!raced) {
                    raced = true;
                    // Another load of the same task publishes its TASK_ENTRY stage while this POST_PREFLIGHT load builds.
                    assert.equal(runLoadRulePackCommand({ repoRoot: f.repoRoot, taskId: 'T-ROUTE-LOAD-CAS', stage: 'TASK_ENTRY',
                        loadedRuleFiles: TASK_ENTRY_RULES, actor: 'concurrent', emitMetrics: false }).exitCode, 0);
                }
                return build(root, files);
            });
            assert.throws(() => f.loadPostPreflight(), /changed while it was being built; rerun load-rule-pack --stage POST_PREFLIGHT/u);
            t.mock.restoreAll();
            assert.equal(f.rulePackEvents().length, loadedEvents + 1, 'Only the concurrent load recorded an event.');
            assert.equal(getRulePackEvidence(f.repoRoot, 'T-ROUTE-LOAD-CAS', 'TASK_ENTRY').evidence_status, 'PASS',
                'The concurrent stage and its event still match.');
            assert.equal(f.loadPostPreflight().exitCode, 0, 'The stated rerun succeeds.');
        }));

    it('rejects the previous stage in every rule-pack reader after an event was appended but not published', t =>
        withRepo('T-ROUTE-LOAD-UNPUBLISHED', {}, f => {
            f.classify();
            assert.equal(f.loadPostPreflight().exitCode, 0);
            const append = taskEventsApi.appendMandatoryTaskEvent;
            t.mock.method(taskEventsApi, 'appendMandatoryTaskEvent', (...args: Parameters<typeof append>) => {
                const result = append(...args);
                if (args[2] === 'RULE_PACK_LOADED') throw new Error('process ended after the append');
                return result;
            });
            assert.throws(() => runLoadRulePackCommand({ repoRoot: f.repoRoot, taskId: 'T-ROUTE-LOAD-UNPUBLISHED',
                stage: 'POST_PREFLIGHT', preflightPath: f.preflightPath, loadedRuleFiles: TASK_ENTRY_RULES,
                actor: 'second-load', emitMetrics: false }));
            t.mock.restoreAll();
            const evidence = getRulePackEvidence(f.repoRoot, 'T-ROUTE-LOAD-UNPUBLISHED', 'POST_PREFLIGHT',
                { preflightPath: f.preflightPath });
            assert.equal(evidence.evidence_status, 'EVIDENCE_EVENT_STAGE_MISMATCH');
            assert.match(getRulePackEvidenceViolations(evidence).join('\n'), /Re-run load-rule-pack --stage POST_PREFLIGHT/u);
            assert.equal(f.loadPostPreflight().exitCode, 0);
            assert.equal(getRulePackEvidence(f.repoRoot, 'T-ROUTE-LOAD-UNPUBLISHED', 'POST_PREFLIGHT',
                { preflightPath: f.preflightPath }).evidence_status, 'PASS');
        }));

    it('records the digest of the redacted stage it publishes, so a redacted actor still binds', () =>
        withRepo('T-ROUTE-LOAD-REDACTED', {}, f => {
            f.classify();
            const actor = `agent ghp_${'A'.repeat(30)}`;
            assert.equal(runLoadRulePackCommand({ repoRoot: f.repoRoot, taskId: 'T-ROUTE-LOAD-REDACTED', stage: 'POST_PREFLIGHT',
                preflightPath: f.preflightPath, loadedRuleFiles: TASK_ENTRY_RULES, actor, emitMetrics: false }).exitCode, 0);
            const stored = JSON.parse(fs.readFileSync(f.rulePackPath, 'utf8')).stages.post_preflight;
            assert.notEqual(stored.actor, actor, 'The published actor is redacted.');
            assert.equal(getRulePackEvidence(f.repoRoot, 'T-ROUTE-LOAD-REDACTED', 'POST_PREFLIGHT',
                { preflightPath: f.preflightPath }).evidence_status, 'PASS');
            fs.writeFileSync(f.appPath, 'const a = 2;\n', 'utf8');
            assert.equal(f.classify().rulePackRebind?.passed, true, 'The redacted stage is reused by the rebinding.');
        }));

    it('routes a stage recorded without a digest (a task started on 1.4.x) to one working reload at each stage', () =>
        withRepo('T-ROUTE-LEGACY-DIGEST', {}, f => {
            const taskId = 'T-ROUTE-LEGACY-DIGEST';
            const orchestratorRoot = path.join(f.repoRoot, 'garda-agent-orchestrator');
            const timelinePath = (file: string) => file.split(path.sep).join('/');
            const followLoad = (stage: 'TASK_ENTRY' | 'POST_PREFLIGHT') => {
                const route = resolveNextStep({ taskId, repoRoot: f.repoRoot });
                assert.equal(route.next_gate, 'load-rule-pack', `${route.next_gate}: ${route.reason}`);
                const command = route.commands[0].command;
                assert.ok(command.includes(`--stage "${stage}"`), command);
                const files = [...command.matchAll(/--loaded-rule-file "([^"]+)"/gu)].map(match => match[1]);
                assert.ok(files.length > 0, command);
                assert.equal(runLoadRulePackCommand({ repoRoot: f.repoRoot, taskId, stage, loadedRuleFiles: files,
                    ...(stage === 'POST_PREFLIGHT' ? { preflightPath: f.preflightPath } : {}), emitMetrics: false }).exitCode, 0);
                assert.equal(getRulePackEvidence(f.repoRoot, taskId, stage, { preflightPath: f.preflightPath }).evidence_status, 'PASS');
                assert.notEqual(resolveNextStep({ taskId, repoRoot: f.repoRoot }).next_gate, 'load-rule-pack');
            };
            taskEventsApi.appendTaskEvent(orchestratorRoot, taskId, 'RULE_PACK_LOADED', 'PASS', 'Rule pack loaded for TASK_ENTRY.',
                { stage: 'TASK_ENTRY', artifact_path: timelinePath(f.rulePackPath) });
            assert.equal(getRulePackEvidence(f.repoRoot, taskId, 'TASK_ENTRY').evidence_status, 'EVIDENCE_EVENT_STAGE_MISMATCH');
            followLoad('TASK_ENTRY');
            // A TASK_ENTRY reload starts the entry cycle again: handshake and shell smoke follow it, as the navigator routes.
            runHandshakeForTask(f.repoRoot, taskId);
            runShellSmokeForTask(f.repoRoot, taskId);

            // The classification names the whole current workspace, so the navigator's next concern is the rule pack.
            f.classify(['TASK.md', 'src/app.ts']);
            assert.equal(f.loadPostPreflight().exitCode, 0);
            taskEventsApi.appendTaskEvent(orchestratorRoot, taskId, 'RULE_PACK_LOADED', 'PASS', 'Rule pack loaded for POST_PREFLIGHT.',
                { stage: 'POST_PREFLIGHT', artifact_path: timelinePath(f.rulePackPath), preflight_path: timelinePath(f.preflightPath) });
            assert.equal(getPostPreflightRulePackRebindDecision(f.repoRoot, taskId, f.preflightPath).can_bind, false);
            followLoad('POST_PREFLIGHT');
        }));

    it('reloads the repo-relative preflight and the same custom rule pack after a digest refusal', () =>
        withRepo('T-ROUTE-REFUSED-FILES', { rulePackPath: 'T-ROUTE-REFUSED-FILES-custom-rule-pack.json' }, f => {
            f.classify();
            assert.equal(f.loadPostPreflight().exitCode, 0);
            const artifact = JSON.parse(fs.readFileSync(f.rulePackPath, 'utf8'));
            artifact.stages.post_preflight.actor = 'edited-after-the-event';
            fs.writeFileSync(f.rulePackPath, JSON.stringify(artifact, null, 2));
            const preflightPath = path.relative(f.repoRoot, f.preflightPath).replace(/\\/gu, '/');
            const refused = runBindRulePackToPreflightCommand({ repoRoot: f.repoRoot, taskId: 'T-ROUTE-REFUSED-FILES',
                preflightPath, artifactPath: f.rulePackPath });
            assert.equal(refused.exitCode, 3);
            const remediation = refused.outputLines[refused.outputLines.indexOf('Remediation:') + 1] ?? '';
            for (const part of ['gate load-rule-pack', 'POST_PREFLIGHT', 'T-ROUTE-REFUSED-FILES-preflight.json',
                '--artifact-path', 'T-ROUTE-REFUSED-FILES-custom-rule-pack.json', '--loaded-rule-file']) {
                assert.ok(remediation.includes(part), refused.outputLines.join('\n'));
            }
            const files = [...remediation.matchAll(/--loaded-rule-file ("[^"]+"|'[^']+'|\S+)/gu)]
                .map(match => match[1].replace(/^["']|["']$/gu, ''));
            assert.ok(files.length > 0, remediation);
            const printedPreflight = /--preflight-path ("[^"]+"|'[^']+')/u.exec(remediation)?.[1].slice(1, -1);
            assert.equal(printedPreflight, preflightPath, remediation);
            assert.equal(runLoadRulePackCommand({ repoRoot: f.repoRoot, taskId: 'T-ROUTE-REFUSED-FILES', stage: 'POST_PREFLIGHT',
                preflightPath: printedPreflight, artifactPath: f.rulePackPath, loadedRuleFiles: files, emitMetrics: false }).exitCode, 0);
            assert.equal(getRulePackEvidence(f.repoRoot, 'T-ROUTE-REFUSED-FILES', 'POST_PREFLIGHT',
                { preflightPath: f.preflightPath, artifactPath: f.rulePackPath }).evidence_status, 'PASS');
        }));

    it('builds the rule-pack reload for the preflight and rule pack next-step --preflight-path names', () =>
        withRepo('T-ROUTE-CUSTOM-PREFLIGHT', {}, f => {
            const taskId = 'T-ROUTE-CUSTOM-PREFLIGHT';
            const customRoot = path.join(f.repoRoot, 'garda-agent-orchestrator', 'runtime', 'custom-reviews');
            const customPreflight = path.join(customRoot, `${taskId}-preflight.json`);
            const customRulePack = path.join(customRoot, `${taskId}-rule-pack.json`);
            fs.mkdirSync(customRoot, { recursive: true });
            const entry = runLoadRulePackCommand({ repoRoot: f.repoRoot, taskId, stage: 'TASK_ENTRY', artifactPath: customRulePack,
                loadedRuleFiles: TASK_ENTRY_RULES, emitMetrics: false });
            assert.equal(entry.exitCode, 0, entry.outputLines.join(' | '));
            runHandshakeForTask(f.repoRoot, taskId);
            runShellSmokeForTask(f.repoRoot, taskId);
            const classified = runClassifyChangeWithRulePackRebind({ repoRoot: f.repoRoot, taskId, taskIntent: INTENT,
                changedFiles: ['TASK.md', 'src/app.ts'], outputPath: customPreflight, rulePackPath: customRulePack, emitMetrics: false });
            assert.ok(classified.preflightPath);
            // next-step --preflight-path reads every artifact from that preflight's directory (its reviews root).
            const navigate = () => resolveNextStep({ taskId, repoRoot: f.repoRoot, reviewsRoot: customRoot });
            const route = navigate();
            assert.equal(route.next_gate, 'load-rule-pack', `${route.next_gate}: ${route.reason}`);
            const command = route.commands[0].command;
            for (const part of ['--stage "POST_PREFLIGHT"', `--preflight-path "garda-agent-orchestrator/runtime/custom-reviews/${taskId}-preflight.json"`,
                `--artifact-path "garda-agent-orchestrator/runtime/custom-reviews/${taskId}-rule-pack.json"`]) {
                assert.ok(command.includes(part), command);
            }
            const files = [...command.matchAll(/--loaded-rule-file "([^"]+)"/gu)].map(match => match[1]);
            const flag = (name: string) => command.match(new RegExp(`--${name} "([^"]+)"`, 'u'))?.[1] ?? '';
            assert.ok(flag('task-mode-path'), `The task-mode artifact is named outside the default reviews root: ${command}`);
            // Exactly the navigator's command: its preflight, rule pack, task-mode and rule files.
            const reload = runLoadRulePackCommand({ repoRoot: f.repoRoot, taskId, stage: 'POST_PREFLIGHT', preflightPath: flag('preflight-path'),
                artifactPath: flag('artifact-path'), taskModePath: flag('task-mode-path'), loadedRuleFiles: files, emitMetrics: false });
            assert.equal(reload.exitCode, 0, reload.outputLines.join(' | '));
            assert.notEqual(navigate().next_gate, 'load-rule-pack', 'Following the reload clears the rule-pack route instead of repeating it.');
        }));

    it('never reuses a stored stage that differs from the stage its RULE_PACK_LOADED event recorded', () =>
        withRepo('T-ROUTE-REBIND-FORGED', {}, f => {
            f.classify();
            assert.equal(f.loadPostPreflight().exitCode, 0);
            const loadedEvents = f.rulePackEvents().length;
            const artifact = JSON.parse(fs.readFileSync(f.rulePackPath, 'utf8'));
            artifact.stages.post_preflight.actor = 'edited-after-the-event';
            fs.writeFileSync(f.rulePackPath, JSON.stringify(artifact, null, 2));
            const decision = getPostPreflightRulePackRebindDecision(f.repoRoot, 'T-ROUTE-REBIND-FORGED', f.preflightPath);
            assert.equal(decision.can_bind, false);
            assert.match(decision.reason, /not the stage its latest RULE_PACK_LOADED event recorded/u);
            assert.ok(getPostPreflightSequenceEvidence(f.repoRoot, 'T-ROUTE-REBIND-FORGED', f.preflightPath).violations
                .some(violation => /not the stage recorded by RULE_PACK_LOADED/u.test(violation)));
            fs.writeFileSync(f.appPath, 'const a = 2;\n', 'utf8');
            assert.equal(f.classify().rulePackRebind, null, 'The edited stage is never rebound.');
            assert.equal(f.rulePackEvents().length, loadedEvents);
        }));

    it('judges a rule file from one read: a file changing B to A to B never passes as A', t =>
        withRepo('T-ROUTE-REBIND-ONE-READ', {}, f => {
            const memory = path.join(getRulePackRulesRoot(f.repoRoot), '15-project-memory.md');
            const header = '# 15 · Project Memory Summary\n\nGenerated at: 2026-11-25T00:00:00.000Z\n';
            const a = Buffer.from(`${header}\nA\n`, 'utf8');
            const b = Buffer.from(`${header}\nB\n`, 'utf8');
            fs.writeFileSync(memory, b);
            const recordedRawA = createHash('sha256').update(a).digest('hex');
            const read = observationApi.readInvocationFileBytes;
            t.mock.method(observationApi, 'readInvocationFileBytes', (file: string) => {
                const bytes = read(file);
                if (path.resolve(file) === path.resolve(memory)) fs.writeFileSync(memory, a);
                return bytes;
            });
            const stale = findStaleLoadedRuleFile(f.repoRoot, { [memory]: recordedRawA }, [memory]);
            t.mock.restoreAll();
            assert.equal(stale, memory, 'The B bytes that were read never match the recorded A hash.');
        }));

    it('never stamps rule bytes that changed after the rebind decision checked them', t =>
        withRepo('T-ROUTE-REBIND-RACE', {}, f => {
            f.classify();
            assert.equal(f.loadPostPreflight().exitCode, 0);
            const previous = fs.readFileSync(f.rulePackPath);
            const loadedEvents = f.rulePackEvents().length;
            const [ruleFile] = JSON.parse(previous.toString('utf8')).stages.post_preflight.loaded_rule_files as string[];
            const absoluteRuleFile = path.resolve(f.repoRoot, ruleFile);
            fs.writeFileSync(f.appPath, 'const a = 2;\n', 'utf8');
            const raced = f.classify(undefined, options => {
                // The real bind: its decision checks the rule files, then the artifact build hashes them again.
                const build = selectionApi.buildRuleFileHashes;
                t.mock.method(selectionApi, 'buildRuleFileHashes', (root: string, files: string[]) => {
                    fs.appendFileSync(absoluteRuleFile, '\nEdited during rebinding.\n');
                    t.mock.restoreAll();
                    return build(root, files);
                });
                try { return runBindRulePackToPreflightCommand(options); } finally { t.mock.restoreAll(); }
            });
            assert.equal(raced.rulePackRebind?.passed, false, JSON.stringify(raced.rulePackRebind));
            assert.match(raced.rulePackRebind?.outputLines.join('\n') ?? '', /changed during rebinding[\s\S]*load-rule-pack/u);
            assert.ok(fs.readFileSync(f.rulePackPath).equals(previous), 'Nothing is written.');
            assert.equal(f.rulePackEvents().length, loadedEvents);
        }));
});
