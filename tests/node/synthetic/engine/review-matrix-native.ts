import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { runHumanCommitCommand } from '../../../../src/cli/commands/gates';
import { spawnSync } from 'node:child_process';
import { buildTaskAuditSummary, synchronizeFinalCloseoutArtifacts } from '../../../../src/gates/task-audit/task-audit-summary';
import { isLocalControlPlaneCommitPath } from '../../../../src/gates/task-audit/task-audit-summary-drift';
import { runGit } from '../../cli/commands/gate-test-helpers';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { type WalkEdit, type WalkScenario } from './navigator-walk';
import { MATRIX_LANES, matrixLaunchContract, matrixScenarioId, type MatrixMode, type ReviewMatrixRow } from './common-review-matrix';
import { stackScenario } from './walk-stack-scenarios';
import { stackCommand, stackInvocations, type StackManifest } from './walk-stack-fixtures';
import { inspectPreservedDeltaAuthority } from './walk-preserved-delta-field-scenarios';
import { NativeWalkOwner, waitForOwner } from './walk-native-owner';

/** An independent oracle for every carried lane, including FULL origins and repeated DELTA carries. */
export function assertMatrixReuseReceipt(origin: Record<string, unknown>, receipt: Record<string, unknown>, currentPreflight: string,
    actualReport: { original: string; current: string }): void {
    assert.equal(receipt.preflight_sha256, currentPreflight, 'A carried receipt must bind the current preflight');
    assert.equal(actualReport.current, actualReport.original, 'The actual report bytes must remain unchanged');
    assert.equal(origin.review_artifact_sha256, actualReport.original, 'The origin must bind the actual original report bytes');
    assert.equal(receipt.review_artifact_sha256, actualReport.current, 'The current receipt must bind the actual final report bytes');
    assert.equal(receipt.review_artifact_sha256, origin.review_artifact_sha256, 'Reuse preserves the actual original report bytes');
    if (origin.preflight_sha256 === currentPreflight) return;
    assert.equal(receipt.reused_existing_review, true, 'No fresh launch is not enough: native reuse must be recorded');
    for (const key of ['review_context_sha256', 'review_tree_state_sha256', 'review_scope_sha256', 'code_scope_sha256'])
        assert.equal(receipt['reused_from_' + key], origin[key], 'Reuse must preserve the original accepted binding: ' + key);
}

interface MatrixReceiptOrigin { step: number; receipt: Record<string, unknown>; reportSha256: string }
export function requireMatrixReuseOrigin(origins: ReadonlyMap<string, MatrixReceiptOrigin>, lane: string,
    launchStep: number, restartStep: number): MatrixReceiptOrigin {
    const origin = origins.get(lane);
    assert.ok(origin, 'Every expected carried lane needs an observed original receipt: ' + lane);
    assert.ok(origin.step >= launchStep && origin.step < restartStep, 'The origin must belong to the latest fresh launch: ' + lane);
    assert.equal((origin.receipt.review_findings_disposition as { blocking_count?: number } | undefined)?.blocking_count, 0,
        'A carried origin must be an accepted non-blocking review: ' + lane);
    assert.notEqual(origin.receipt.reused_existing_review, true, 'Capture the fresh origin, not an intermediate carried receipt');
    return origin;
}

/** Rust's existing contract-named tests are a separate API signal. Use ordinary test names for ordinary-test rows.
 * The unmodified contract paths remain covered by the original stack stand, rather than weakening path policy. */
export function commonMatrixManifest(input: StackManifest): StackManifest {
    const manifest = structuredClone(input);
    if (manifest.id !== 'rust') return manifest;
    for (const suite of manifest.suites) suite.target = suite.target.replace('_contract.rs', '_case.rs');
    for (const technology of manifest.technologies) for (const key of ['compileArgv', 'firstArgv', 'secondArgv', 'allArgv', 'broadArgv'] as const)
        technology[key] = technology[key].map(value => value.replaceAll('order_contract', 'order_case').replaceAll('partner_contract', 'partner_case'));
    return manifest;
}

export async function assertNativeCompletedCommit(root: string, exerciseRecovery = false): Promise<void> {
    const taskId = 'T-WALK';
    const auditOptions = { taskId, repoRoot: root };
    const accepted = buildTaskAuditSummary(auditOptions);
    assert.equal(accepted.status, 'PASS', JSON.stringify(accepted.blockers));
    const implementation = accepted.final_closeout.implementation_summary;
    const files = implementation.changed_files!.filter(file => !isLocalControlPlaneCommitPath(file)).sort();
    assert.ok(files.length);
    const closeoutFile = accepted.final_closeout.artifact_paths.json;
    const beforeHead = runGit(root, ['rev-parse', 'HEAD']).stdout.trim();
    const commit = () => runHumanCommitCommand(['--operator-confirmed', 'yes', '--operator-confirmed-at-utc',
        new Date().toISOString(), '--task-id', taskId, '-m', 'test: accept native reviewed task'], { cwd: root });

    if (exerciseRecovery) {
        const published = fs.readFileSync(closeoutFile);
        const ledger = path.join(root, 'garda-agent-orchestrator/runtime/task-ledger', taskId + '.json');
        const publishedLedger = fs.readFileSync(ledger);
        const broken = structuredClone(accepted);
        Object.assign(broken.final_closeout.implementation_summary, {
            changed_files_sha256: null, scope_content_sha256: null, scope_sha256: null
        });
        assert.throws(() => synchronizeFinalCloseoutArtifacts(broken), /without authenticated scope hashes/u);
        assert.deepEqual(fs.readFileSync(closeoutFile), published);
        assert.deepEqual(fs.readFileSync(ledger), publishedLedger);

        const file = path.join(root, files[0]);
        const original = fs.readFileSync(file);
        fs.appendFileSync(file, '\nchanged after acceptance\n');
        runGit(root, ['add', '--', ...files]);
        await assert.rejects(commit, /requires completion and task audit PASS/u);
        assert.equal(runGit(root, ['rev-parse', 'HEAD']).stdout.trim(), beforeHead);
        fs.writeFileSync(file, original);
        assert.deepEqual(fs.readFileSync(closeoutFile), published);

        // Reproduce the exact legacy null header, leaving the accepted preflight and events untouched.
        const corrupt = JSON.parse(published.toString('utf8'));
        Object.assign(corrupt.implementation_summary, broken.final_closeout.implementation_summary);
        fs.writeFileSync(closeoutFile, JSON.stringify(corrupt));
    }
    runGit(root, ['add', '--', ...files]);
    // Use a new process to exercise the workspace generation before task mode is in memory.
    const refreshed = spawnSync(process.execPath, [require.resolve('../../../../src/cli/main'), 'gate',
        'task-audit-summary', '--task-id', taskId, '--repo-root', root, '--as-json'],
    { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    assert.equal(refreshed.error, undefined, String(refreshed.error));
    assert.equal(refreshed.status, 0, refreshed.stderr || refreshed.stdout);
    const fresh = JSON.parse(refreshed.stdout).final_closeout.implementation_summary;
    assert.equal(fresh.scope_content_sha256, implementation.scope_content_sha256);
    assert.equal(fresh.changed_files_sha256, implementation.changed_files_sha256);

    assert.equal(await commit(), 0);
    const head = runGit(root, ['rev-parse', 'HEAD']).stdout.trim();
    assert.notEqual(head, beforeHead);
    assert.deepEqual(runGit(root, ['diff-tree', '--no-commit-id', '-r', '--name-only', '-z', head])
        .stdout.split('\0').filter(Boolean).sort(), files);
    const postCommit = buildTaskAuditSummary(auditOptions);
    assert.equal(postCommit.status, 'PASS', JSON.stringify(postCommit.blockers));
    const eventFile = path.join(root, 'garda-agent-orchestrator/runtime/task-events', taskId + '.jsonl');
    const events = fs.readFileSync(eventFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.find(event => event.event_type === 'TASK_SOURCE_COMMIT_ACCEPTED')?.details?.commit_sha, head);
}

export function nativeReviewMatrixScenario(input: StackManifest, entry: ReviewMatrixRow, mode: MatrixMode): WalkScenario {
    const manifest = commonMatrixManifest(input), invocations = stackInvocations(manifest, 3);
    const base = stackScenario(manifest, 3, 'generic', false, invocations), fixture = base.fixture!;
    if (manifest.id === 'rust') fixture.files = Object.fromEntries(Object.entries(fixture.files)
        .map(([file, bytes]) => [file.replaceAll('_contract.rs', '_case.rs'), bytes.replaceAll('_contract.rs', '_case.rs')]));
    const suite = manifest.suites[0], comment = suite.comment;
    const extraSource = (i: number) => path.posix.join(path.posix.dirname(suite.source), 'matrix-extra-' + i + path.posix.extname(suite.source));
    const sources = [suite.source, ...Array.from({ length: (entry.initialSourceFiles ?? 1) - 1 }, (_, i) => extraSource(i))];
    const extraEdits: WalkEdit[] = sources.slice(1).map(file => {
        fixture.files[file] = comment + ' initial fixture source\n';
        return { path: file, append: comment + ' initial task edit\n' };
    });
    const newTest = path.posix.join(path.posix.dirname(suite.target), 'matrix-added.test' + path.posix.extname(suite.target));
    const newSource = extraSource(99);
    const newConfig = 'config/matrix-settings.json';
    const intentDocument = 'docs/matrix-intent-context.md';
    if (entry.changeIntentAfterSecurityPass) fixture.files[intentDocument] = 'Existing task behavior notes.\n';
    if (entry.exerciseCloseoutRecovery) fixture.files['.stand/runner.cjs'] =
        'if(require("node:fs").existsSync(".git/matrix-block-tests")) {'
        + 'require("node:fs").writeFileSync(".git/matrix-tests-ready", "ready");'
        + 'const deadline=performance.now()+120000;'
        + 'while(!require("node:fs").existsSync(".git/matrix-release-tests")) {'
        + 'if(performance.now()>deadline)process.exit(97);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);}}\n'
        + fixture.files['.stand/runner.cjs'];
    // Preserve existing directory spelling: Windows merges tests into Tests, while
    // native contained-file admission requires the exact canonical relative path.
    const testDirectory = Object.keys(fixture.files).find(file => /^tests\//iu.test(file))?.split('/')[0] ?? 'tests';
    const helper = path.posix.join(testDirectory, 'helpers', 'matrix-shared' + path.posix.extname(suite.source));
    if (entry.repairs.some(step => step.kind === 'helper')) {
        fixture.files[helper] = comment + ' existing shared test helper\n';
        fixture.taskTestSupport = [...fixture.taskTestSupport ?? [], { path: helper, role: 'helper',
            targets: invocations.flatMap(invocation => invocation.targets) }];
    }
    if (entry.repairs.some(step => step.kind === 'new-test')) {
        manifest.suites.push({ ...suite, id: 'matrix-added', target: newTest });
        fixture.files['.stand-fixture.json'] = JSON.stringify(manifest);
    }
    let addedTestDeclared = false;
    let evidenceFaultApplied = false;
    let compileInterrupted = false;
    let intentChanged = false, recoveryExercised = false;
    let originalCriteria: Record<string, unknown> | undefined;
    const changedIntent = 'Update task behavior and require the recorded acceptance examples to cover empty input.';
    let recoveryOwner: NativeWalkOwner | undefined;
    const preservesDelta = entry.interruptTestRemediationCompile
        || ['passed-delta-then-test', 'source-then-two-test-repairs'].includes(entry.id);
    const originalDelta = new Map<string, Record<string, unknown>>();
    const freshReceipts = new Map<string, MatrixReceiptOrigin>();
    const repairs = entry.repairs.map(step => ({ reviewType: step.lane, attempt: step.attempt,
        edits: step.kind === 'source-test' ? [{ path: sources[0], append: comment + ' bounded production fix\n' },
            { path: suite.target, append: (comment + ' structural regression fix\n').repeat(step.lines) }]
            : step.kind === 'new-config' ? [{ path: sources[0], append: comment + ' bounded production fix\n' },
                { path: newConfig, append: '{"matrix_enabled":true}\n' }]
            : step.kind === 'source' ? sources.slice(0, step.files ?? 1).map(file => ({ path: file, append: (comment + ' fixed\n').repeat(step.lines) }))
            : [{ path: step.kind === 'test' ? suite.target : step.kind === 'document' ? 'docs/matrix-guide.md'
                : step.kind === 'new-test' ? newTest : step.kind === 'helper' ? helper : newSource,
            append: step.kind === 'document' ? 'Clarified task behavior.\n'
                : (comment + (step.kind === 'new-test' ? ' STAND_CASE_A3' : ' fixed') + '\n').repeat(step.lines) }] }));
    const initial = ['code', 'refactor', 'api', 'test'];
    const graph = entry.graph ? { preparation_order: [...MATRIX_LANES], dependencies: Object.fromEntries(MATRIX_LANES.map(lane => {
        const at = initial.indexOf(lane);
        return [lane, at > 0 && entry.graph === 'chain' ? [initial[at - 1]] : at > 0 && entry.graph === 'fanout' ? ['code'] : []];
    })) } : undefined;
    const scenario: WalkScenario = { ...base, id: matrixScenarioId(manifest.id, entry.id, mode), mode,
        taskTitle: 'Common review transition: ' + entry.id, taskNotes: 'Acceptance: ' + entry.rule,
        get testSelectionCommand() { return invocations.map(invocation => invocation.command).join(' && '); },
        requiredLanes: entry.required, edits: [...base.edits, ...extraEdits,
            ...entry.changeIntentAfterSecurityPass ? [{ path: intentDocument, append: 'Document existing input behavior.\n' }] : [],
            ...entry.repairs.some(step => step.kind === 'helper') ? [{ path: helper, append: comment + ' initial task helper change\n' }] : []],
        remediationSequence: repairs, failureAttempts: Object.fromEntries([...new Set(repairs.map(step => step.reviewType))]
            .map(lane => [lane, repairs.filter(step => step.reviewType === lane).map(step => step.attempt)])),
        ...matrixLaunchContract(entry), enforceReviewExpectations: true,
        ...(graph ? { dependencyGraph: graph } : {}),
        ...(entry.interruptTestRemediationCompile ? { expectedFailingGates: ['restart-review-cycle'],
            disturbanceReason: 'The stack compile command fails once during TEST remediation.' } : {}),
        ...(entry.evidenceFault ? { expectedFailingGates: ['required-reviews-check'], disturbanceReason: entry.evidenceFault,
            progressBoundary: () => String(evidenceFaultApplied) } : {}),
        ...(entry.reportFault ? { disturbances: [{ kind: 'broken-report', lane: 'test' }],
            expectedFailingGates: ['record-review-result'], unreachableReviewer: entry.reportFault === 'unreachable' } : {}),
        ...(entry.stopOnFailure ? { expectedBlockedGate: 'implementation',
            expectedGuidance: /Recorded 'test' review verdict is 'TEST REVIEW FAILED'\. Do not launch downstream reviewers or rerun 'test' before implementation changes are made\./u } : {}),
        configure: root => {
            addedTestDeclared = false;
            evidenceFaultApplied = false; compileInterrupted = false;
            intentChanged = false; recoveryExercised = false; recoveryOwner = undefined;
            originalCriteria = undefined;
            originalDelta.clear(); freshReceipts.clear(); base.configure?.(root);
            const file = path.join(root, 'garda-agent-orchestrator/live/config/paths.json');
            const paths = JSON.parse(fs.readFileSync(file, 'utf8'));
            paths.file_roles = { ...paths.file_roles, ...Object.fromEntries([...sources, newSource].map(source => [source, 'source'])),
                [newTest]: 'test', [helper]: 'test', [newConfig]: 'source' };
            if (entry.structuralTestThreshold) paths.test_refactor_changed_lines_threshold = entry.structuralTestThreshold;
            fs.writeFileSync(file, JSON.stringify(paths));
        },
        prepare: async (root, steps, run) => {
            await base.prepare?.(root, steps, run);
            const last = steps.at(-1), reviewsRoot = path.join(root, 'garda-agent-orchestrator/runtime/reviews');
            if (entry.changeIntentAfterSecurityPass && !intentChanged && last?.gate === 'record-review-result' && last.exitCode === 0
                && last.command?.includes('--review-type "security"')) {
                const before = JSON.parse(fs.readFileSync(path.join(reviewsRoot, 'T-WALK-preflight.json'), 'utf8'));
                assert.ok(before.effective_review_snapshot.inputs.task_intent);
                assert.notEqual(before.effective_review_snapshot.inputs.task_intent, changedIntent);
                originalCriteria = JSON.parse(fs.readFileSync(path.join(reviewsRoot, 'T-WALK-security-review-context.json'), 'utf8')).task_criteria_binding;
                // An actual in-scope docs edit makes recovery necessary. Keep TASK.md/card/decisions unchanged:
                // the FULL oracle must test changed intent, not be satisfied by a second changed criteria input.
                fs.appendFileSync(path.join(root, intentDocument), 'Clarify the existing boundary example.\n'.repeat(8));
                await run(['restart-coherent-cycle', '--task-id', 'T-WALK', '--repo-root', '.',
                    '--preflight-path', 'garda-agent-orchestrator/runtime/reviews/T-WALK-preflight.json',
                    '--task-intent', changedIntent, '--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString()]);
                const after = JSON.parse(fs.readFileSync(path.join(reviewsRoot, 'T-WALK-preflight.json'), 'utf8'));
                assert.equal(after.effective_review_snapshot.inputs.task_intent, changedIntent);
                intentChanged = true;
            }
            if (entry.exerciseCloseoutRecovery && !recoveryExercised && last?.gate === 'record-review-result' && last.exitCode === 0
                && last.command?.includes('--review-type "test"')) {
                const probe = (args: string[]) => spawnSync(process.execPath, [require.resolve('../../../../src/cli/main'), 'gate', ...args],
                    { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
                const wrong = probe(['matrix-invalid-command', '--task-id', 'T-WALK']);
                assert.equal(wrong.error, undefined);
                assert.notEqual(wrong.status, 0, 'The wrong command must really be refused');
                const args = ['full-suite-validation', '--task-id', 'T-WALK', '--repo-root', '.',
                    '--preflight-path', 'garda-agent-orchestrator/runtime/reviews/T-WALK-preflight.json'];
                fs.writeFileSync(path.join(root, '.git/matrix-block-tests'), 'block one real test owner');
                recoveryOwner = new NativeWalkOwner(root, args);
                const marker = path.join(reviewsRoot, 'T-WALK-full-suite-run-marker.json');
                try {
                    await waitForOwner('matrix native task-test marker', () => {
                        recoveryOwner!.assertRunning();
                        return fs.existsSync(path.join(root, '.git/matrix-tests-ready')) && fs.existsSync(marker);
                    });
                    const before = fs.readFileSync(marker);
                    const busy = probe(args);
                    assert.equal(busy.error, undefined);
                    assert.notEqual(busy.status, 0, 'A second gate must refuse the actual occupied marker');
                    assert.match(busy.stdout + busy.stderr, /marker/iu);
                    assert.match(busy.stdout + busy.stderr, /occupied|already|running|active|in.progress/iu);
                    assert.deepEqual(fs.readFileSync(marker), before, 'The live owner marker must remain intact');
                    last.preparation ??= [];
                    last.preparation.push({ command: 'gate matrix-invalid-command', output: wrong.stdout + wrong.stderr },
                        { command: args.join(' '), output: busy.stdout + busy.stderr });
                } finally {
                    fs.writeFileSync(path.join(root, '.git/matrix-release-tests'), 'release');
                    await recoveryOwner.finish();
                    fs.unlinkSync(path.join(root, '.git/matrix-block-tests'));
                }
                recoveryExercised = true;
            }
            if (last?.gate === 'record-review-result' && last.exitCode === 0) {
                const lane = /--review-type "([^"]+)"/u.exec(last.command || '')?.[1];
                if (lane) {
                    const receipt = JSON.parse(fs.readFileSync(path.join(reviewsRoot, 'T-WALK-' + lane + '-receipt.json'), 'utf8'));
                    if (receipt.reused_existing_review !== true) freshReceipts.set(lane, { step: last.index, receipt,
                        reportSha256: createHash('sha256').update(fs.readFileSync(path.join(reviewsRoot, 'T-WALK-' + lane + '.md'))).digest('hex') });
                }
            }
            const justRecordedTest = last?.gate === 'record-review-result' && last.exitCode === 0
                && last.command?.includes('--review-type "test"');
            if (justRecordedTest && preservesDelta) {
                for (const lane of ['code', 'api']) {
                    const receipt = JSON.parse(fs.readFileSync(path.join(reviewsRoot, 'T-WALK-' + lane + '-receipt.json'), 'utf8'));
                    const origin = originalDelta.get(lane);
                    if (!origin) originalDelta.set(lane, receipt);
                    else {
                        assert.equal(receipt.reused_existing_review, true);
                        assert.equal(receipt.review_execution_contract_sha256, origin.review_execution_contract_sha256);
                        for (const key of ['review_context_sha256', 'review_tree_state_sha256', 'review_scope_sha256', 'code_scope_sha256'])
                            assert.equal(receipt['reused_from_' + key], origin[key], 'Every carry must refer to the same original DELTA: ' + key);
                    }
                }
            }
            if (justRecordedTest && entry.evidenceFault && !evidenceFaultApplied) {
                const file = path.join(reviewsRoot, entry.evidenceFault.endsWith('context') ? 'T-WALK-test-review-context.json'
                    : entry.evidenceFault.endsWith('receipt') ? 'T-WALK-test-receipt.json' : 'T-WALK-test.md');
                if (entry.evidenceFault.startsWith('lost-')) fs.unlinkSync(file);
                else fs.writeFileSync(file, '{invalid\n');
                evidenceFaultApplied = true;
            }
            if (addedTestDeclared || !fs.existsSync(path.join(root, newTest))) return;
            // This is the simulated toolchain's own task plan, not Garda gate evidence. Keep old executions for audit.
            const log = path.join(root, '.git/stand-invocations.jsonl');
            if (fs.existsSync(log)) fs.renameSync(log, path.join(root, '.git/stand-invocations-before-new-test.jsonl'));
            const invocation = invocations.find(item => item.technology === suite.technology)!;
            invocation.argv.push(newTest); invocation.targets.push(newTest);
            invocation.command = stackCommand(manifest.technologies.find(item => item.id === invocation.technology)!, invocation.argv);
            const planFile = path.join(root, '.git/stand-task.json');
            const plan = JSON.parse(fs.readFileSync(planFile, 'utf8')); plan.invocations = invocations;
            fs.writeFileSync(planFile, JSON.stringify(plan));
            base.selectionTargets!.push(newTest);
            fixture.cases.push({ source: newTest, case_id: 'task-contract', selector: newTest });
            fixture.taskTestInvocations = invocations.map(item => ({ command: item.command, targets: item.targets }));
            fixture.taskTestCommand = fixture.caseCommand = invocations.map(item => item.command).join(' && ');
            addedTestDeclared = true;
        },
        execute: async (root, step) => {
            if (entry.interruptTestRemediationCompile && !compileInterrupted && originalDelta.size === 2
                && step.gate === 'restart-review-cycle') {
                fs.writeFileSync(path.join(root, '.git/stand-fail-compile-once'), '');
                compileInterrupted = true;
            }
            return base.execute ? base.execute(root, step) : false;
        },
        inspectNavigation: (result, steps) => {
            base.inspectNavigation?.(result, steps);
            if (!entry.interruptTestRemediationCompile) return;
            const interruption = steps.find(step => step.gate === 'restart-review-cycle' && step.exitCode
                && step.output.includes('synthetic interruption of the compile command'));
            if (!interruption || steps.some(step => step.index > interruption.index
                && step.gate === 'restart-review-cycle' && step.exitCode === 0)) return;
            assert.notEqual(result.next_gate, 'restart-coherent-cycle', result.reason);
            if (result.next_gate === 'restart-review-cycle') {
                assert.match(result.commands[0]?.command ?? '', /--review-type "test"/u);
            }
        },
        inspectResult: async (root, result) => {
            await base.inspectResult?.(root, result);
            if (entry.stopOnFailure) {
                assert.equal(result.outcome, 'blocked');
                return;
            }
            assert.equal(result.outcome, 'done');
            if (entry.changeIntentAfterSecurityPass) {
                assert.ok(intentChanged, 'The actual task-intent must change after three accepted FULLs');
                assert.equal(result.events.filter(event => event.type === 'COHERENT_CYCLE_RESTARTED').length, 1);
                const restarted = result.events.findIndex(event => event.type === 'COHERENT_CYCLE_RESTARTED');
                assert.ok(!result.events.slice(restarted).some(event => event.type === 'REVIEW_RECORDED' && event.details.reused_existing_review === true),
                    'Changed criteria forbid preserving old PASS evidence');
                for (const lane of ['code', 'db', 'security', 'test']) {
                    const context = JSON.parse(fs.readFileSync(path.join(root, 'garda-agent-orchestrator/runtime/reviews',
                        'T-WALK-' + lane + '-review-context.json'), 'utf8'));
                    assert.equal(context.task_criteria_binding.task_intent, changedIntent);
                    assert.ok(originalCriteria);
                    assert.notEqual(originalCriteria.task_intent, changedIntent);
                    for (const key of ['schema', 'task_id', 'task_rows', 'task_card', 'task_operator_decisions'])
                        assert.deepEqual(context.task_criteria_binding[key], originalCriteria[key], 'Only intent may change the criteria: ' + key);
                }
            }
            if (entry.exerciseCloseoutRecovery) {
                assert.ok(recoveryExercised, 'The actual occupied marker and invalid command must both be observed');
                await assertNativeCompletedCommit(root, true);
            }
            if (entry.id === 'initial-full') await assertNativeCompletedCommit(root);
            if (entry.repairs.some(step => step.kind === 'helper')) {
                const restart = [...result.events].reverse().find(event => event.type === 'REVIEW_CYCLE_RESTARTED');
                assert.equal((restart?.details.authoritative_review_decision as { category?: string } | undefined)?.category,
                    'shared_test_helper_or_harness', 'The scenario must exercise an existing reviewed shared helper, not a newly added leaf test');
            }
            const restart = [...result.steps].reverse().find(step => step.gate === 'restart-review-cycle' && step.exitCode === 0);
            if (restart) {
                const preflightSha = createHash('sha256').update(fs.readFileSync(path.join(root,
                    'garda-agent-orchestrator/runtime/reviews/T-WALK-preflight.json'))).digest('hex');
                const lastLaunchByLane = new Map<string, number>();
                for (const launch of result.reviews) {
                    assert.ok(Number.isInteger(launch.step), 'Every native launch needs its trace position');
                    lastLaunchByLane.set(launch.lane, launch.step!);
                }
                for (const [lane, launchStep] of lastLaunchByLane) if (launchStep < restart.index) {
                    const original = requireMatrixReuseOrigin(freshReceipts, lane, launchStep, restart.index);
                    const receipt = JSON.parse(fs.readFileSync(path.join(root, 'garda-agent-orchestrator/runtime/reviews', 'T-WALK-' + lane + '-receipt.json'), 'utf8'));
                    const actualReport = createHash('sha256').update(fs.readFileSync(path.join(root,
                        'garda-agent-orchestrator/runtime/reviews', 'T-WALK-' + lane + '.md'))).digest('hex');
                    assertMatrixReuseReceipt(original.receipt, receipt, preflightSha, { original: original.reportSha256, current: actualReport });
                }
            }
            if (preservesDelta) {
                inspectPreservedDeltaAuthority(root, result, entry.id === 'source-then-two-test-repairs' ? 2 : 1);
                assert.equal(originalDelta.size, 2, 'Observe both accepted DELTAs before the first TEST-only repair');
                for (const lane of ['code', 'api']) {
                    const receipt = JSON.parse(fs.readFileSync(path.join(root, 'garda-agent-orchestrator/runtime/reviews', 'T-WALK-' + lane + '-receipt.json'), 'utf8'));
                    const origin = originalDelta.get(lane)!;
                    assert.equal(receipt.review_execution_contract_sha256, origin.review_execution_contract_sha256);
                    for (const key of ['review_context_sha256', 'review_tree_state_sha256', 'review_scope_sha256', 'code_scope_sha256'])
                        assert.equal(receipt['reused_from_' + key], origin[key], 'Final reuse must preserve the original signed receipt lineage');
                }
            }
            if (entry.interruptTestRemediationCompile) {
                assert.ok(compileInterrupted, 'The simulated toolchain must interrupt TEST remediation');
                const failed = result.steps.filter(step => step.gate === 'restart-review-cycle' && step.exitCode);
                assert.equal(failed.length, 1, 'Exactly one native restart must fail');
                assert.match(failed[0].output, /synthetic interruption of the compile command/u);
                assert.ok(result.steps.some(step => step.index > failed[0].index && step.gate === 'restart-review-cycle' && step.exitCode === 0));
                assert.equal(result.events.filter(event => event.type === 'COHERENT_CYCLE_RESTARTED').length, 0);
            }
            if (entry.evidenceFault) assert.ok(evidenceFaultApplied, 'The declared evidence fault must actually fire');
            if (entry.repairs.some(step => step.kind === 'new-test')) {
                assert.ok(addedTestDeclared, 'New test must join real task validation');
                const selected = result.steps.find(step => step.gate === 'task-test-selection' && step.exitCode === 0
                    && step.command?.includes(newTest));
                assert.ok(selected, 'New target must be selected through the native workflow command');
                for (const target of base.selectionTargets!) assert.ok(selected.command!.includes(target),
                    'Reselection must retain every original required target: ' + target);
                assert.ok(result.steps.some(step => step.index > selected.index && step.gate === 'full-suite-validation'
                    && step.exitCode === 0), 'The expanded selection must pass native task-test validation');
            }
        }
    };
    if (entry.exerciseCloseoutRecovery) scenario.cleanup = async root => {
        await recoveryOwner?.killTree();
        await base.cleanup?.(root);
    };
    return scenario;
}
