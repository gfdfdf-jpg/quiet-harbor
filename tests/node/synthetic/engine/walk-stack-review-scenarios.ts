import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { REVIEW_LANES } from '../../../../scripts/node-foundation/synthetic/model';
import { taskValidationProcessViolations, type TaskValidationPlan, type TaskValidationProcessEvidence } from '../../../../src/core/task-validation-plan';
import { reviewEconomyBound, SWEEP_EDITS, type EconomyFacts } from './walk-economy';
import type { WalkResult, WalkScenario, WalkStep } from './navigator-walk';
import { STACK_FIXTURE_ROOT, STACK_MANIFESTS, readStackExecutions, type StackManifest } from './walk-stack-fixtures';
import { applyStackEdits, stackScenario } from './walk-stack-scenarios';
import { legacySourceRoute } from './walk-legacy-task-contract';
import { mutateSweepFile, WRONG_GATES, WRONG_GATE_CHECKPOINTS, type ArtifactKind, type SweepDisturbance } from './walk-sweep';

const BUNDLE = 'garda-agent-orchestrator';
const REVIEWS = BUNDLE + '/runtime/reviews/';
const LANES = ['code', 'security', 'refactor', 'test'];
export const STACK_REVIEW_FAMILIES = ['policy-change', 'review-edit', 'lost-receipt', 'corrupt-receipt',
    'lost-context', 'corrupt-context', 'lost-report', 'corrupt-report', 'report-correction',
    'wrong-gate', 'repeated-command', 'stale-lock', 'reset'] as const;
export type StackReviewFamily = typeof STACK_REVIEW_FAMILIES[number];

/**
 * Canonical change roles feed the existing independent rule oracle, never the product's observed policy.
 * `repeats: 'allowed'` expects every repeat the bound permits; `'required'` expects only the repeats a rule requires,
 * so a lane whose rule permits but does not require a repeat (a derived lane file) keeps its passed review.
 */
export function stackReviewExpectation(kinds: readonly string[], dependencies: EconomyFacts['dependencies'] = {}, lanes: readonly string[] = LANES,
    repeats: 'allowed' | 'required' = 'allowed') {
    const facts: EconomyFacts = { scope: [SWEEP_EDITS['edit-production'].path], dependencies,
        reviews: lanes.map(lane => ({ lane, mode: 'FULL', launched: 0, completed: 1, recorded: 2 })) };
    const bounds = reviewEconomyBound(3, kinds, facts);
    const repeat = bounds.filter(bound => repeats === 'required' ? bound.required : bound.repeats)
        .map(bound => bound.modes.map(mode => bound.lane + ':' + mode).join('|'));
    return { bounds, modes: [...lanes.map(lane => lane + ':FULL'), ...repeat] };
}

function expectations(modes: string[]) {
    const lanes = [...new Set(modes.map(mode => mode.split(':')[0]))];
    return { expectedModes: modes, expectedReviews: Object.fromEntries(lanes.map(lane =>
        [lane, modes.filter(mode => mode.startsWith(lane + ':')).length])) };
}
function recorded(steps: readonly WalkStep[], lane = 'test'): number {
    return steps.filter(step => step.gate === 'record-review-result' && step.exitCode === 0
        && step.command?.includes('--review-type "' + lane + '"')).length;
}
function justRecorded(steps: readonly WalkStep[], lane = 'test'): boolean {
    const last = steps.at(-1);
    return last?.gate === 'record-review-result' && last.exitCode === 0
        && !!last.command?.includes('--review-type "' + lane + '"');
}
function inspectSelectionMissing(root: string): void {
    // This native reader may load next-step through CLI dependencies. Load it only inside the instrumented walk.
    const { readTaskTestSelection } = require('../../../../src/cli/commands/workflow/workflow-command-task-test-selection') as
        typeof import('../../../../src/cli/commands/workflow/workflow-command-task-test-selection');
    const bundleRoot = path.join(root, BUNDLE), config = path.join(bundleRoot, 'live/config');
    const selection = readTaskTestSelection({ targetRoot: root, bundleRoot,
        configPath: path.join(config, 'workflow-config.json'),
        optionalSkillSelectionPolicyPath: path.join(config, 'optional-skill-selection-policy.json') }, 'T-WALK');
    assert.equal(selection.status, 'missing', 'T-457: a new entry must have no inherited selection');
    assert.equal(selection.command, null);
    assert.deepEqual(selection.targets, []);
}

/** All technologies get exactly these three ordinary full-level cases. A8 keeps two unaffected lanes visible. */
export function stackCompactReviewScenario(manifest: StackManifest, family: 'review-edit' | 'lost-evidence' | 'reset-and-wrong-gate', auto = false): WalkScenario {
    const base = stackScenario(manifest, 8, auto && manifest.adapter ? 'auto' : 'generic');
    let phase = 0, executionFloor = 0, newEntryChecked = false;
    const lanes = base.expectedModes.map(mode => mode.split(':')[0]);
    const small = stackReviewExpectation(['edit-production'], {}, lanes);
    const large = stackReviewExpectation(['edit-production-large'], {}, lanes);
    const dependencies = Object.fromEntries(REVIEW_LANES.map(lane => [lane, lane === 'test' ? ['security'] : []]));
    const lost = stackReviewExpectation(['delete-artifact:' + REVIEWS + 'T-WALK-security-receipt.json'], dependencies, lanes);
    const reset = stackReviewExpectation(['reset-task'], {}, lanes);
    const largeRepeats = large.modes.slice(lanes.length);
    // The 241-line source edit exceeds the 120-line API-change performance threshold;
    // this is the first performance review, while unchanged API review is reused.
    if (lanes.includes('api')) largeRepeats.splice(largeRepeats.findIndex(mode => mode.startsWith('test:')), 0, 'performance:FULL');
    const modes = family === 'review-edit' ? [...small.modes, ...largeRepeats]
        : family === 'lost-evidence' ? lost.modes : reset.modes;
    const scenario: WalkScenario = { ...base, id: `stack-${manifest.id}-${family}`, ...expectations(modes),
        enforceReviewExpectations: true,
        progressBoundary: () => String(phase),
        ...(family === 'lost-evidence' ? { dependencyGraph: { preparation_order: [...REVIEW_LANES], dependencies } } : {}),
        disturbanceReason: 'Stack review rules: ' + family,
        expectedFailingGates: family === 'lost-evidence' ? ['required-reviews-check'] : [],
        ...(family === 'reset-and-wrong-gate' ? { injection: { seed: Number(process.env.GARDA_SYNTHETIC_SEED ?? 0x6a726461), baseline: base.id, step: -1,
            gate: 'required-reviews-check', checkpoint: {}, disturbances: [{ kind: 'reset-task' },
                { kind: 'wrong-gate', gate: 'completion-gate' }] } } : {}),
        configure: root => { phase = 0; executionFloor = 0; newEntryChecked = false; base.configure?.(root); },
        prepare: async (root, steps, run) => {
            await base.prepare?.(root, steps, run);
            if (family === 'reset-and-wrong-gate') {
                const entered = steps.filter(step => step.gate === 'enter-task-mode' && step.exitCode === 0);
                if (entered.length === 2 && !newEntryChecked) { inspectSelectionMissing(root); newEntryChecked = true; }
                return;
            }
            if (!justRecorded(steps) || recorded(steps) !== phase + 1 || phase >= (family === 'review-edit' ? 2 : 1)) return;
            // The initial task, and then the small edit, must finish every required review before the next fault.
            for (const lane of lanes) assert.equal(recorded(steps, lane), phase === 1 && ['code', 'test'].includes(lane) ? 2 : 1);
            executionFloor = readStackExecutions(root).length;
            if (family === 'review-edit') {
                const suite = manifest.suites[0];
                applyStackEdits(root, [{ path: suite.source, append: (suite.comment + ' post-review code change\n').repeat(phase ? 241 : 1) }]);
            } else {
                // Remove the receipt, not just an optional runner report. Native recovery must mint a fresh review.
                fs.unlinkSync(path.join(root, REVIEWS, 'T-WALK-security-receipt.json'));
                // Rebuild task validation as well; every declared technology must execute again.
                fs.unlinkSync(path.join(root, REVIEWS, 'T-WALK-full-suite-validation.json'));
            }
            phase++;
        },
        inspectResult: (root, result) => {
            base.inspectResult?.(root, result);
            if (result.outcome !== 'done') return;
            const validation = JSON.parse(fs.readFileSync(path.join(root, REVIEWS, 'T-WALK-full-suite-validation.json'), 'utf8')) as {
                task_test_validation_plan: TaskValidationPlan; task_test_process_evidence: TaskValidationProcessEvidence };
            assert.equal(validation.task_test_process_evidence.invocations.length, base.fixture!.taskTestInvocations!.length);
            assert.deepEqual(taskValidationProcessViolations(validation.task_test_validation_plan, validation.task_test_process_evidence), [],
                'Native evidence binds every declared command, in addition to fixture source/output checks');
            if (family === 'reset-and-wrong-gate') {
                assert.ok(newEntryChecked, 'T-457 selection inspected after native re-entry');
                // Native reset archives the first timeline. The command trace retains both entries and the audit output.
                const entries = result.steps.filter(step => step.gate === 'enter-task-mode' && step.exitCode === 0);
                assert.equal(entries.length, 2);
                const currentEntry = result.events.map((event, index) => event.type === 'TASK_MODE_ENTERED' ? index : -1)
                    .filter(index => index >= 0).at(-1);
                assert.notEqual(currentEntry, undefined);
                assert.ok(result.events.slice(currentEntry! + 1).some(event => event.type === 'TASK_TEST_SELECTION_RECORDED'));
                assert.ok(result.steps.some(step => step.index > entries[1].index && step.gate === 'task-test-selection' && step.exitCode === 0));
                assert.equal(result.steps.filter(step => step.wrongGate).length, 1);
                assert.equal(result.steps.flatMap(step => step.preparation ?? []).filter(action => action.command.startsWith('task-reset ')
                    && /^RESET_COMPLETE$/mu.test(action.output)).length, 1);
                assert.equal(result.events.filter(event => event.type === 'REVIEW_CYCLE_RESTARTED').length, 0, 'Wrong gate adds no review cycle');
            } else {
                assert.equal(phase, family === 'review-edit' ? 2 : 1, 'Every post-review fault fired');
                for (const technology of new Set(manifest.technologies.map(tech => tech.id))) {
                    assert.ok(readStackExecutions(root).slice(executionFloor).some(record => record.purpose === 'own'
                        && record.technology === technology && record.exitCode === 0), 'Rebuilt validation: ' + technology);
                }
            }
        }
    };
    return scenario;
}

export const STACK_COMPACT_REVIEW_SCENARIOS = STACK_MANIFESTS.flatMap(manifest =>
    (['review-edit', 'lost-evidence', 'reset-and-wrong-gate'] as const).map(family => stackCompactReviewScenario(manifest, family)));

interface RotationCatalog { multiModule: string[]; multiTechnology: string[] }
export interface PermanentReviewCase { stack: string; family: StackReviewFamily }
export function validatePermanentReviewCases(value: unknown): PermanentReviewCase[] {
    const cases = (value as { cases?: PermanentReviewCase[] } | null)?.cases;
    if (!Array.isArray(cases) || cases.some(item => !item || !STACK_MANIFESTS.some(manifest => manifest.id === item.stack)
        || !STACK_REVIEW_FAMILIES.includes(item.family)) || new Set(cases.map(item => item.stack + ':' + item.family)).size !== cases.length)
        throw new Error('Permanent review cases require unique known stack/family pairs');
    return cases;
}
const shapes = JSON.parse(fs.readFileSync(path.join(STACK_FIXTURE_ROOT, 'review-rotation.json'), 'utf8')) as RotationCatalog;
export interface StackReviewRotation {
    seed: number; count: number; permanent: PermanentReviewCase[];
    families: Array<{ family: StackReviewFamily; stacks: string[]; scenarios: string[] }>;
}
function deepCaseSuffixes(family: StackReviewFamily): string[] {
    if (family === 'wrong-gate') return WRONG_GATE_CHECKPOINTS.flatMap(checkpoint => WRONG_GATES.map(gate => `-${checkpoint}-${gate}`));
    if (family === 'policy-change') return ['-prepare-code', '-complete-code', '-record-code', '-passed-reviews'];
    if (family === 'repeated-command' || family === 'stale-lock') return ['-before-compile', '-before-reviews', '-after-reviews'];
    if (family === 'report-correction') return ['', '-invalid-shape', '-missing-semantics', '-unreachable'];
    return [''];
}
/** Seeded ranking is stable across processes and excludes the mandatory unknown stack from N. */
export function stackReviewRotation(seed: number, count = 3, permanent = validatePermanentReviewCases(
    JSON.parse(fs.readFileSync(path.join(STACK_FIXTURE_ROOT, '../../node/synthetic/stack-review-cases.json'), 'utf8')))): StackReviewRotation {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Review rotation seed must be uint32');
    const known = STACK_MANIFESTS.filter(manifest => manifest.id !== 'unknown-quartz');
    if (!Number.isSafeInteger(count) || count < 3 || count > known.length) throw new Error('Review rotation N must be 3..18');
    let state = seed || 0x6a726461;
    const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
    return { seed, count, permanent, families: STACK_REVIEW_FAMILIES.map(family => {
        const ranked = known.map(manifest => ({ manifest, rank: random() })).sort((a, b) => a.rank - b.rank);
        const selected = new Set<string>();
        for (const predicate of [(manifest: StackManifest) => shapes.multiModule.includes(manifest.id),
            (manifest: StackManifest) => shapes.multiTechnology.includes(manifest.id), (manifest: StackManifest) => !!manifest.adapter]) {
            if (![...selected].some(id => predicate(known.find(manifest => manifest.id === id)!)))
                selected.add(ranked.find(entry => predicate(entry.manifest))!.manifest.id);
        }
        for (const { manifest } of ranked) { if (selected.size >= count) break; selected.add(manifest.id); }
        const stacks = [...new Set(['unknown-quartz', ...selected, ...permanent.filter(item => item.family === family).map(item => item.stack)])];
        return { family, stacks, scenarios: stacks.flatMap(id => deepCaseSuffixes(family).map(suffix => `deep-stack-${id}-${family}${suffix}`)) };
    }) };
}

/** Same native disturbances as the legacy stand, bound to each stack's own code, tests and commands. */
export function stackDeepReviewScenario(manifest: StackManifest, family: StackReviewFamily): WalkScenario {
    if (family === 'review-edit' || family === 'reset') {
        const compact = stackCompactReviewScenario(manifest, family === 'reset' ? 'reset-and-wrong-gate' : family, true);
        return { ...compact, id: `deep-stack-${manifest.id}-${family}` };
    }
    const base = stackScenario(manifest, 8, manifest.adapter ? 'auto' : 'generic');
    const artifactKind = family.includes('receipt') ? 'receipt' : family.includes('context') ? 'context' : 'report';
    const artifactPath = REVIEWS + 'T-WALK-test-' + (artifactKind === 'context' ? 'review-context.json'
        : 'receipt.json');
    const targetPath = artifactKind === 'report' ? REVIEWS + 'T-WALK-test.md' : artifactPath;
    const fault: SweepDisturbance = family === 'policy-change' ? { kind: 'change-policy' }
        : family === 'wrong-gate' ? { kind: 'wrong-gate', gate: 'completion-gate' }
        : family === 'repeated-command' ? { kind: 'repeat-last' } : { kind: 'stale-lock' };
    const artifactFamily = /^(?:lost|corrupt)-/u.test(family);
    const disturbance: SweepDisturbance = artifactFamily ? { kind: family.startsWith('lost-') ? 'delete-artifact' : 'corrupt-artifact',
        artifact: { path: targetPath, kind: artifactKind as ArtifactKind } } : fault;
    // The bound is computed for the artifact this family actually deletes or corrupts after the test review was recorded.
    // Lost or corrupt recorded evidence (receipt, report) requires the test lane once (C6.2.3). A review context is a
    // derived lane file: the rules permit a repeat but require none, so its passed review is kept while the restored
    // context binds the same reviewed inputs (C6.2.1; README "Review economy of disturbed variants").
    const expected = stackReviewExpectation(artifactFamily ? [disturbance.kind + ':' + targetPath] : [], {},
        base.expectedModes.map(mode => mode.split(':')[0]), 'required');
    // A repeated review after a lost context has no DELTA base (§6.2); receipt/report loss retains the oracle's alternatives.
    if (artifactFamily && artifactKind === 'context') expected.modes = expected.modes.map(mode => mode.includes('|') ? 'test:FULL' : mode);
    let fired = false;
    return { ...base, id: `deep-stack-${manifest.id}-${family}`, ...expectations(expected.modes),
        enforceReviewExpectations: true, disturbanceReason: 'Rotated stack review family: ' + family,
        progressBoundary: () => String(fired),
        ...(family === 'report-correction' ? { disturbances: [{ kind: 'broken-report' as const, lane: 'test' }],
            expectedFailingGates: ['record-review-result'] }
            : artifactFamily ? { expectedFailingGates: ['required-reviews-check'] }
                : { injection: { seed: Number(process.env.GARDA_SYNTHETIC_SEED ?? 0x6a726461), baseline: base.id, step: -1, gate: 'required-reviews-check', checkpoint: {}, disturbances: [fault] } }),
        configure: root => { fired = false; base.configure?.(root); },
        prepare: async (root, steps, run) => {
            await base.prepare?.(root, steps, run);
            if (artifactFamily && !fired && justRecorded(steps)) { mutateSweepFile(root, disturbance); fired = true; }
        },
        inspectResult: (root, result) => {
            base.inspectResult?.(root, result);
            if (result.outcome === 'done' && artifactFamily) assert.ok(fired);
        }
    };
}

const POLICY_ADOPTION_ROUTE = legacySourceRoute('src/gates/next-step/next-step-startup-routing.ts',
    'Ask the operator to approve the changed review policy, or revert it.');

export const STACK_DEEP_REVIEW_SCENARIOS =STACK_MANIFESTS.flatMap(manifest =>
    STACK_REVIEW_FAMILIES.flatMap(family => {
        const base = stackDeepReviewScenario(manifest, family);
        return deepCaseSuffixes(family).map(suffix => {
            const scenario = { ...base, id: base.id + suffix, injection: base.injection ? structuredClone(base.injection) : undefined };
            if (scenario.injection && family === 'wrong-gate') {
                const checkpoint = WRONG_GATE_CHECKPOINTS.find(checkpoint => suffix.startsWith('-' + checkpoint + '-'))!;
                const gate = WRONG_GATES.find(gate => suffix === '-' + checkpoint + '-' + gate)!;
                scenario.injection.gate = checkpoint;
                scenario.injection.disturbances = [{ kind: 'wrong-gate', gate }];
            } else if (scenario.injection && family === 'policy-change') {
                scenario.injection.gate = suffix === '-prepare-code' ? 'prepare-reviewer-launch' : suffix === '-complete-code'
                    ? 'complete-reviewer-launch' : suffix === '-record-code' ? 'record-review-result' : 'required-reviews-check';
                scenario.injection.checkpoint = suffix === '-passed-reviews' ? {} : { lane: 'code' };
                // The frozen policy refuses the change at POST_PREFLIGHT (C6.1.1); the modeled user approves adoption,
                // which keeps every passed review (C6.2.4), so the base review counts and modes stay the expectation.
                // compareWalk accepts only that refusal answered by the adoption; this route must also be reached.
                scenario.expectedRoutes = [...scenario.expectedRoutes ?? [], POLICY_ADOPTION_ROUTE];
            } else if (scenario.injection && (family === 'repeated-command' || family === 'stale-lock')) {
                scenario.injection.gate = suffix === '-before-compile' ? 'compile-gate' : suffix === '-before-reviews'
                    ? 'build-review-context' : 'required-reviews-check';
            } else if (family === 'report-correction' && suffix === '-unreachable') {
                scenario.unreachableReviewer = true;
                Object.assign(scenario, expectations([...base.expectedModes, 'test:FULL']));
            } else if (family === 'report-correction' && suffix) {
                scenario.disturbances = [{ kind: suffix === '-invalid-shape' ? 'invalid-report-shape' : 'missing-report-semantics', lane: 'test' }];
            }
            return scenario;
        });
    }));

export function stackReviewIdentity(id: string): { stack: string; family: string } | null {
    for (const manifest of STACK_MANIFESTS) for (const prefix of ['stack-', 'deep-stack-']) {
        if (id.startsWith(prefix + manifest.id + '-')) {
            const family = id.slice((prefix + manifest.id + '-').length);
            return { stack: manifest.id, family: prefix === 'deep-stack-'
                ? STACK_REVIEW_FAMILIES.find(known => family === known || family.startsWith(known + '-')) ?? family : family };
        }
    }
    return null;
}

export function stackReviewResults(results: readonly WalkResult[], findings: readonly { id: string }[]) {
    return STACK_MANIFESTS.map(manifest => {
        const cases = results.filter(result => stackReviewIdentity(result.scenarioId)?.stack === manifest.id).map(result => ({
            id: result.scenarioId, family: stackReviewIdentity(result.scenarioId)!.family, outcome: result.outcome,
            reviews: result.reviewsByLane, modes: result.reviews.map(review => review.lane + ':' + review.mode),
            findings: findings.filter(finding => !/^walk:(?:counter|time|missing-baseline)/u.test(finding.id)
                && finding.id.split(':').includes(result.scenarioId)).map(finding => finding.id) }));
        return { stack: manifest.id, verdict: !cases.length ? 'INCOMPLETE' : cases.every(result => result.outcome === 'done' && !result.findings.length) ? 'PASS' : 'FAIL', cases };
    });
}

/** Differences are replayable observations; retaining a pair never changes its review expectation. */
export function stackReviewDifferences(results: readonly WalkResult[]) {
    const families = new Map<string, Map<string, string[]>>();
    for (const result of results) {
        const identity = stackReviewIdentity(result.scenarioId);
        if (!identity || !result.scenarioId.startsWith('deep-stack-')) continue;
        const caseId = result.scenarioId.slice(('deep-stack-' + identity.stack + '-').length);
        const signatures = families.get(caseId) ?? new Map<string, string[]>();
        const signature = JSON.stringify({ outcome: result.outcome, modes: result.reviews.map(review => review.lane + ':' + review.mode) });
        signatures.set(signature, [...signatures.get(signature) ?? [], identity.stack]);
        families.set(caseId, signatures);
    }
    return [...families].filter(([, signatures]) => signatures.size > 1).map(([caseId, signatures]) => ({
        family: STACK_REVIEW_FAMILIES.find(family => caseId === family || caseId.startsWith(family + '-'))!, caseId,
        variants: [...signatures].map(([signature, stacks]) => ({ ...JSON.parse(signature) as { outcome: string; modes: string[] }, stacks })) }));
}
