import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { type WalkEdit, type WalkScenario } from './navigator-walk';
import { MATRIX_LANES, matrixLaunchContract, matrixScenarioId, type MatrixMode, type ReviewMatrixRow } from './common-review-matrix';
import { stackScenario } from './walk-stack-scenarios';
import { stackCommand, stackInvocations, type StackManifest } from './walk-stack-fixtures';
import { inspectPreservedDeltaAuthority } from './walk-preserved-delta-field-scenarios';

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
    const helper = 'tests/helpers/matrix-shared' + path.posix.extname(suite.source);
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
    const originalDelta = new Map<string, Record<string, unknown>>();
    const freshReceipts = new Map<string, MatrixReceiptOrigin>();
    const repairs = entry.repairs.map(step => ({ reviewType: step.lane, attempt: step.attempt,
        edits: step.kind === 'source' ? sources.slice(0, step.files ?? 1).map(file => ({ path: file, append: (comment + ' fixed\n').repeat(step.lines) }))
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
            ...entry.repairs.some(step => step.kind === 'helper') ? [{ path: helper, append: comment + ' initial task helper change\n' }] : []],
        remediationSequence: repairs, failureAttempts: Object.fromEntries([...new Set(repairs.map(step => step.reviewType))]
            .map(lane => [lane, repairs.filter(step => step.reviewType === lane).map(step => step.attempt)])),
        ...matrixLaunchContract(entry), enforceReviewExpectations: true,
        ...(graph ? { dependencyGraph: graph } : {}),
        ...(entry.evidenceFault ? { expectedFailingGates: ['required-reviews-check'], disturbanceReason: entry.evidenceFault,
            progressBoundary: () => String(evidenceFaultApplied) } : {}),
        ...(entry.reportFault ? { disturbances: [{ kind: 'broken-report', lane: 'test' }],
            expectedFailingGates: ['record-review-result'], unreachableReviewer: entry.reportFault === 'unreachable' } : {}),
        ...(entry.stopOnFailure ? { expectedBlockedGate: 'implementation',
            expectedGuidance: /Recorded 'test' review verdict is 'TEST REVIEW FAILED'\. Do not launch downstream reviewers or rerun 'test' before implementation changes are made\./u } : {}),
        configure: root => {
            addedTestDeclared = false;
            evidenceFaultApplied = false; originalDelta.clear(); freshReceipts.clear(); base.configure?.(root);
            const file = path.join(root, 'garda-agent-orchestrator/live/config/paths.json');
            const paths = JSON.parse(fs.readFileSync(file, 'utf8'));
            paths.file_roles = { ...paths.file_roles, ...Object.fromEntries([...sources, newSource].map(source => [source, 'source'])),
                [newTest]: 'test', [helper]: 'test' };
            fs.writeFileSync(file, JSON.stringify(paths));
        },
        prepare: async (root, steps, run) => {
            await base.prepare?.(root, steps, run);
            const last = steps.at(-1), reviewsRoot = path.join(root, 'garda-agent-orchestrator/runtime/reviews');
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
            if (justRecordedTest && ['passed-delta-then-test', 'source-then-two-test-repairs'].includes(entry.id)) {
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
        inspectResult: (root, result) => {
            base.inspectResult?.(root, result);
            if (entry.stopOnFailure) {
                assert.equal(result.outcome, 'blocked');
                return;
            }
            assert.equal(result.outcome, 'done');
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
            if (['passed-delta-then-test', 'source-then-two-test-repairs'].includes(entry.id)) {
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
    return scenario;
}
