import { CONTRACT } from '../../../../scripts/node-foundation/synthetic/oracle';
import { observeStandOracle } from './stand-check-observation';
import type { WalkResult, WalkReview, WalkScenario, WalkStep } from './navigator-walk';

/**
 * Review economy of disturbed variants (tests/node/synthetic/README.md, "Review economy of disturbed variants").
 * The bound restates the operator's review rules from facts of the undisturbed baseline and of the disturbance.
 * Previously required lanes are based on the baseline and modeled changes, not on Garda dropping a lane during recovery.
 */

export type ReviewMode = 'FULL' | 'DELTA';
type LaneState = 'pending' | 'in-flight' | 'unrecorded' | 'passed';

/** What a sweep edit disturbance writes. The bound derives the fix's files, lines and reach from it. */
export const SWEEP_EDITS = Object.freeze({
    'edit-production': { path: 'src/app.ts', append: '\n// synthetic disturbance\n', role: 'production' },
    'edit-production-large': { path: 'src/app.ts', append: '\n' + '// synthetic production change\n'.repeat(241), role: 'production' },
    'edit-test': { path: 'tests/app.test.ts', append: '\n// synthetic disturbance\n', role: 'test' },
    'edit-document': { path: 'docs/guide.md', append: '\n// synthetic disturbance\n', role: 'document' },
    'edit-test-large': { path: 'tests/app.test.ts', append: '\n' + '// synthetic test change\n'.repeat(51), role: 'test' },
    'add-test-file': { path: 'tests/added.test.ts', append: 'import test from "node:test";\ntest("added coverage", () => undefined);\n', role: 'new-test' },
    'edit-shared-test-helper': { path: 'tests/helpers/render.ts', append: '\n// synthetic helper change\n', role: 'test-helper' },
    'add-production-file': { path: 'src/added.ts', append: 'export const added = true;\n', role: 'new-production' },
    'edit-protected': { path: 'src/auth/session.ts', append: '\n// synthetic protected change\n', role: 'protected' }
} as const);
type SweepEditKind = keyof typeof SWEEP_EDITS;

export const ECONOMY_RULES = Object.freeze({
    'not-run': 'Review has not run yet: FULL, as planned.',
    'in-flight': 'The edit reached an unfinished review: its reviewed tree cannot yet be authenticated, so a fresh review is FULL.',
    'first-review': 'A review first required after a criteria change, a change of the task\'s files, or an edit that reaches its scope '
        + 'has not run yet: one FULL.',
    untouched: 'Nothing reached the review (no code, criteria or evidence of it changed): kept, not repeated.',
    documents: 'Only documents changed: no review; nothing else repeats.',
    'outside-scope': 'Passed review (or a finished one not yet recorded), fix outside its scope: kept, not repeated. A review the '
        + 'task did not require stays unlaunched.',
    'small-fix': 'Passed review (or a finished one not yet recorded), small fix inside its scope: DELTA.',
    'large-fix': 'Passed review (or a finished one not yet recorded), large fix inside its scope: FULL.',
    'scope-expansion': 'A non-test, non-document file enters the task scope: everything FULL.',
    'protected-owner': 'A protected area changed: its owning review runs FULL; other reached reviews follow their own fix rules.',
    criteria: 'Task criteria changed: everything FULL.',
    policy: 'An approved review-lane policy change: passed reviews are kept (reuse binds scope and rules, not the lane '
        + 'selection); a lane it newly requires runs once in FULL.',
    'broken-report': 'Broken reviewer report: the same open reviewer corrects it; no new launch.',
    'lost-evidence': 'Lost or broken review evidence, no code change: only that lane and lanes depending on it repeat. The rule names no mode.',
    'lost-evidence-with-fix': 'A code or test edit together with lost evidence of a review: that review repeats once in FULL; the edit follows '
        + 'the rules for the other reviews.',
    'task-evidence': 'Task evidence that belongs to no review was lost: no review repeats, only that evidence is rebuilt.',
    reset: 'The task was reset: passed reviews are not kept, every review that ran repeats once in FULL.'
} as const);
export type EconomyRule = keyof typeof ECONOMY_RULES;

/**
 * Cases the operator's rules do not decide. The widest answer to any of them repeats each review that already ran
 * once in FULL; a planned review still runs once. Launches beyond that are judged under every answer, launches
 * between the strict bound and the widest answer stay unjudged until the operator answers. None is open now.
 */
export const ECONOMY_QUESTIONS: Readonly<Record<string, string>> = Object.freeze({});
export type EconomyQuestion = string;

/**
 * The operator's answers (2 November 2026) to the questions this bound once left open; each is a rule above.
 * The bound applies them; they never widen what the rules allow.
 */
export const ECONOMY_ANSWERS = Object.freeze({
    'unrecorded-review': 'A finished but unrecorded review, then a code or test edit, is a passed review followed by a fix: its result '
        + 'is recorded against the tree it reviewed and the edit follows outside-scope / small-fix / large-fix.',
    'task-evidence': 'Task evidence not tied to a review (full-suite-validation.json, preflight.json) is lost: no review repeats.',
    'edit-with-lost-evidence': 'A code edit together with lost evidence of one review: only that review repeats in FULL; the edit follows '
        + 'the rules for the other reviews.',
    'task-reset': 'A task reset keeps no passed review: every review repeats.'
} as const);
/** The widest answer to every question, for a review that already ran. */
const WIDEST_ANSWER = Object.freeze({ repeats: 1, modes: Object.freeze(['FULL', 'DELTA'] as ReviewMode[]) });

export interface EconomyFacts {
    /** Every undisturbed review with the step that launched it and the step that recorded its result. */
    reviews: Array<{ lane: string; mode: string; launched: number; completed?: number | null; recorded: number | null;
        prepared?: number | null }>;
    /** Files the baseline's reviews covered: a fix that keeps this list can be small. */
    scope: string[];
    /** A declared graph only: an implied graph controls launch order and re-opens nothing. */
    dependencies: Record<string, readonly string[]>;
}

export interface LaneBound {
    lane: string;
    state: LaneState;
    /** Launches of this lane the baseline still plans from the injection on, including their expected modes. */
    planned: Array<{ mode: string }>;
    /** Launches the rules allow on top of the planned ones, and their modes. */
    repeats: number;
    /** Required launches: among planned launches for a first review, otherwise on top of planned launches. */
    required: number;
    /** A required launch must have this mode when the rule specifies it. */
    requiredMode?: ReviewMode;
    modes: readonly ReviewMode[];
    rule: EconomyRule;
    /** Undecided questions whose widest answer allows more on this lane; empty when the rules decide it. */
    questions: string[];
}

export interface EconomyExcess {
    kind: 'extra-launch' | 'full-where-delta' | 'delta-where-full' | 'unknown-mode';
    lane: string;
    review: WalkReview;
    rule: EconomyRule;
    allowed: string;
}

/** A review the rules require to repeat that the run kept instead. */
export interface EconomyMissed {
    kind: 'missed-review';
    lane: string;
    rule: EconomyRule;
    required: number;
    launched: number;
    requiredMode?: ReviewMode;
}

export interface EconomyVerdict {
    disturbances: string[];
    bounds: LaneBound[];
    /** Launches after the disturbance, in order. */
    observed: WalkReview[];
    excess: EconomyExcess[];
    missed: EconomyMissed[];
    unjudged: Array<{ lane: string; questions: string[]; launches: number }>;
}

/**
 * Baseline facts of the bound, or undefined when the baseline had a failed review: the sweep baselines pass
 * every review, and a failure's own remediation rules are judged by the scenario families instead.
 */
export function economyFacts(scenario: Pick<WalkScenario, 'dependencyGraph' | 'edits' | 'fix' | 'failures' | 'failureAttempts'>,
    result: Pick<WalkResult, 'reviews' | 'steps'>): EconomyFacts | undefined {
    if (Object.values(scenario.failures ?? {}).some(count => (count ?? 0) > 0)
        || Object.values(scenario.failureAttempts ?? {}).some(attempts => attempts.length > 0)) return undefined;
    const reviews = result.reviews.map(review => {
        const launched = review.step ?? -1;
        const completed = review.completed === undefined ? launched : review.completed;
        const recorded = completed === null ? undefined : result.steps.find(step => step.index > completed && step.gate === 'record-review-result'
            && step.route?.endsWith('/' + review.lane) && !step.exitCode);
        // The step whose prepare-reviewer-launch handed the reviewer its inputs; from then on the reviewer reads them.
        const prepared = result.steps.filter(step => step.index < launched && step.gate === 'prepare-reviewer-launch'
            && step.route?.endsWith('/' + review.lane) && !step.exitCode).at(-1);
        return { lane: review.lane, mode: review.mode, launched,
            ...(review.completed === undefined ? {} : { completed: review.completed }), recorded: recorded?.index ?? null,
            ...(prepared ? { prepared: prepared.index } : {}) };
    });
    return { reviews, scope: [...new Set([...scenario.edits, ...scenario.fix ?? []].map(edit => edit.path))].sort(),
        dependencies: scenario.dependencyGraph?.dependencies ?? {} };
}

function changedLines(text: string): number {
    return text.split('\n').length - 1;
}

/**
 * docs/configuration.md: the code review covers production code, the test review tests and the code they verify;
 * a test edit over 50 changed lines reaches `refactor` and `test`. Documents reach no review.
 */
function reachedLanes(kinds: readonly SweepEditKind[]): string[] {
    return [...new Set(kinds.flatMap(kind => {
        const edit = SWEEP_EDITS[kind];
        if (edit.role === 'production' || edit.role === 'new-production') return ['code', 'test'];
        if (edit.role === 'protected') return ['code', 'security', 'test'];
        if (edit.role === 'test-helper') return ['refactor', 'test'];
        if (edit.role === 'new-test') return ['test'];
        if (edit.role === 'test') return changedLines(edit.append) > CONTRACT.testRefactorChangedLinesThreshold ? ['refactor', 'test'] : ['test'];
        return [];
    }))];
}

function isSmallFix(kinds: readonly SweepEditKind[], scope: readonly string[], consecutiveDeltas: number): boolean {
    const edits = kinds.map(kind => SWEEP_EDITS[kind]).filter(edit => edit.role !== 'document');
    return new Set(edits.map(edit => edit.path)).size <= CONTRACT.maxDeltaChangedFiles
        && edits.reduce((sum, edit) => sum + changedLines(edit.append), 0) <= CONTRACT.maxDeltaChangedLines
        && edits.every(edit => edit.role === 'new-test' || edit.role === 'test-helper' || scope.includes(edit.path))
        && edits.every(edit => edit.role !== 'new-production')
        && consecutiveDeltas < CONTRACT.maxConsecutiveDeltaReviews;
}

/** The lane a runtime artifact belongs to, or null when it belongs to the task as a whole. */
export function artifactLane(file: string, lanes: readonly string[]): string | null {
    const normalized = file.replace(/\\/gu, '/');
    const name = normalized.split('/').at(-1) ?? '';
    return lanes.find(lane => normalized.includes('/reviews/T-WALK/' + lane + '/')
        || new RegExp('^T-WALK-' + lane + '(?:-|\\.)').test(name)) ?? null;
}

/** Short role of an artifact, for grouping: digests and the task prefix removed. */
export function artifactRole(file: string): string {
    return (file.replace(/\\/gu, '/').split('/').at(-1) ?? file).replace(/[a-f0-9]{16,64}/gu, '#').replace(/^T-WALK-/u, '');
}

/** The recorded result of a review: its receipt or its review artifact. Other lane files are derived or launch inputs. */
function isRecordedReviewEvidence(file: string, lane: string): boolean {
    const name = file.replace(/\\/gu, '/').split('/').at(-1) ?? '';
    return name === 'T-WALK-' + lane + '.md' || name === 'T-WALK-' + lane + '-receipt.json';
}

/** The output an open reviewer returned, before Garda records it. */
function isOpenReviewerReport(file: string): boolean {
    return /\/review-output-[^/]*\.md$/u.test(file.replace(/\\/gu, '/'));
}

function dependents(lane: string, dependencies: EconomyFacts['dependencies']): string[] {
    const reached = new Set([lane]);
    for (let grew = true; grew;) {
        grew = false;
        for (const [downstream, upstream] of Object.entries(dependencies)) {
            if (!reached.has(downstream) && upstream.some(entry => reached.has(entry))) { reached.add(downstream); grew = true; }
        }
    }
    return [...reached];
}

function laneState(lane: string, step: number, facts: EconomyFacts): LaneState {
    const started = facts.reviews.filter(review => review.lane === lane && review.launched < step).at(-1);
    if (!started) return 'pending';
    if (started.completed !== undefined && (started.completed === null || started.completed >= step)) return 'in-flight';
    return started.recorded !== null && started.recorded < step ? 'passed' : 'unrecorded';
}

function parseDisturbances(disturbances: readonly string[]): Array<{ kind: string; target: string }> {
    return disturbances.map(id => {
        const kind = id.split(':')[0];
        return { kind, target: id.slice(kind.length + 1) };
    });
}

/**
 * What the rules allow per lane after these disturbances (`disturbanceId` strings). `extraLanes` names further lanes
 * to bound, for example lanes the run launched although the baseline never reviewed them; it changes no other bound.
 * `requiredAtDone` is an independent scenario expectation, not a selection reported by the disturbed run.
 * For a new lane only, `firstRequired` may also include a positive selection from the final preflight.
 */
export function reviewEconomyBound(step: number, disturbances: readonly string[], facts: EconomyFacts, extraLanes: readonly string[] = [],
    requiredAtDone?: readonly string[], firstRequired: readonly string[] | undefined = requiredAtDone): LaneBound[] {
    const parsed = parseDisturbances(disturbances);
    const fixKinds = parsed.flatMap(entry => entry.kind in SWEEP_EDITS && SWEEP_EDITS[entry.kind as SweepEditKind].role !== 'document'
        ? [entry.kind as SweepEditKind] : []);
    const reached = new Set(reachedLanes(fixKinds));
    const scopeChanged = fixKinds.some(kind => {
        const edit = SWEEP_EDITS[kind];
        return edit.role === 'new-production' || (edit.role === 'production' || edit.role === 'protected') && !facts.scope.includes(edit.path);
    });
    const criteria = parsed.some(entry => entry.kind === 'change-criteria');
    const policy = parsed.some(entry => entry.kind === 'change-policy');
    const onlyDocuments = parsed.some(entry => entry.kind === 'edit-document') && !fixKinds.length;
    const baselineLanes = [...new Set(facts.reviews.map(review => review.lane))];
    const lost = new Set<string>(), broken = new Set<string>(), lostRecorded = new Set<string>();
    let reset = false, taskEvidence = false;
    for (const { kind, target } of parsed) {
        if (kind === 'reset-task') reset = true;
        if (!['delete-artifact', 'corrupt-artifact', 'stale-artifact'].includes(kind)) continue;
        const lane = artifactLane(target, baselineLanes);
        if (!lane) taskEvidence = true;
        else if (kind !== 'delete-artifact' && isOpenReviewerReport(target) && laneState(lane, step, facts) === 'unrecorded') broken.add(lane);
        else {
            lost.add(lane);
            // Deleted or corrupted recorded evidence of a recorded review is lost for certain; a stale timestamp is not.
            if (kind !== 'stale-artifact' && isRecordedReviewEvidence(target, lane) && laneState(lane, step, facts) === 'passed') lostRecorded.add(lane);
        }
    }
    const reopened = new Set([...lost].flatMap(lane => dependents(lane, facts.dependencies)));
    return [...new Set([...baselineLanes, ...reached, ...extraLanes])].map((lane): LaneBound => {
        const state = laneState(lane, step, facts);
        const planned = facts.reviews.filter(review => review.lane === lane && review.launched >= step).map(review => ({ mode: review.mode }));
        const keep = (rule: EconomyRule) => ({ lane, state, planned, repeats: 0, required: 0, modes: [] as ReviewMode[], rule, questions: [] as string[] });
        // The current criteria mutation preserves the reviewed scope and reset preserves the planned files.
        // Only an independently modeled change may remove a baseline lane, not Garda's own reclassification.
        const stillRequired = !(criteria || policy || reset) || !requiredAtDone || requiredAtDone.includes(lane);
        if (!baselineLanes.includes(lane)) {
            // Which lanes a changed file set, changed criteria or an adopted policy require is review policy, not a repeat
            // rule: such a first review runs once in FULL. Within the reviewed files only an edit that reaches the lane can require it.
            return criteria || policy || scopeChanged || reached.has(lane) ? { ...keep('first-review'), planned: [{ mode: 'FULL' }],
                required: Number((firstRequired?.includes(lane) ?? false) || lane === 'code' && fixKinds.some(kind => {
                    const role = SWEEP_EDITS[kind].role;
                    return role === 'production' || role === 'new-production' || role === 'protected';
                }) || lane === 'test' && fixKinds.some(kind => ['add-test-file', 'edit-test-large', 'edit-shared-test-helper'].includes(kind))
                    || lane === 'security' && fixKinds.includes('edit-protected')),
                requiredMode: 'FULL' }
                : keep(fixKinds.length ? 'outside-scope' : 'untouched');
        }
        // A reviewer handed its inputs (prepared) but not yet launched in the walk's count may have read a lost input.
        // Recovery may require one extra FULL, but the first required FULL must still happen.
        const handedOff = facts.reviews.some(review => review.lane === lane && review.prepared != null
            && review.prepared < step && step <= review.launched);
        if (state === 'pending' && lost.has(lane) && handedOff && !fixKinds.length && !criteria && !reset) {
            return { ...keep('lost-evidence'), repeats: 1, required: Number(stillRequired), requiredMode: 'FULL', modes: ['FULL'] };
        }
        if (state === 'pending') return { ...keep('not-run'), required: Number(stillRequired), requiredMode: 'FULL' };
        const strict = ((): LaneBound => {
            if (criteria) return { ...keep('criteria'), repeats: 1, required: Number(stillRequired), requiredMode: 'FULL', modes: ['FULL'] };
            if (policy && !reset && !scopeChanged && !fixKinds.length && !lost.has(lane) && !reopened.has(lane)) return keep('policy');
            if (reset) return { ...keep('reset'), repeats: 1, required: Number(stillRequired), modes: ['FULL'] };
            if (scopeChanged) return { ...keep('scope-expansion'), repeats: 1, required: 1, modes: ['FULL'] };
            const lostRequired = lostRecorded.has(lane) ? 1 : 0;
            if (lost.has(lane) && fixKinds.length) return { ...keep('lost-evidence-with-fix'), repeats: 1,
                required: Math.max(lostRequired, Number(reached.has(lane))), modes: ['FULL'] };
            // Operator answer 3: with an edit, a lane depending on the lost one follows the edit's rules like any other.
            if (reopened.has(lane) && !fixKinds.length) {
                return { ...keep('lost-evidence'), repeats: 1, required: lostRequired, modes: ['FULL', 'DELTA'] };
            }
            if (reached.has(lane)) {
                if (state === 'in-flight') return { ...keep('in-flight'), repeats: 1, required: 1, modes: ['FULL'] };
                if (lane === 'security' && fixKinds.includes('edit-protected')) {
                    return { ...keep('protected-owner'), repeats: 1, required: 1, modes: ['FULL'] };
                }
                const before = facts.reviews.filter(review => review.lane === lane && review.launched < step).reverse();
                const deltas = before.findIndex(review => review.mode !== 'DELTA');
                return isSmallFix(fixKinds, facts.scope, deltas < 0 ? before.length : deltas)
                    ? { ...keep('small-fix'), repeats: 1, required: 1, modes: ['DELTA'] }
                    : { ...keep('large-fix'), repeats: 1, required: 1, modes: ['FULL'] };
            }
            if (broken.has(lane)) return keep('broken-report');
            return keep(fixKinds.length ? 'outside-scope' : onlyDocuments ? 'documents' : taskEvidence ? 'task-evidence' : 'untouched');
        })();
        // Every question is answered (ECONOMY_ANSWERS); a new one would be listed here for the lanes it concerns.
        const questions: string[] = [];
        // A question matters only where its widest answer allows more than the strict bound.
        const moot = strict.repeats >= WIDEST_ANSWER.repeats && strict.modes.includes('FULL');
        return { ...strict, questions: moot ? [] : questions };
    });
}

function describeAllowed(bound: LaneBound): string {
    const strict = bound.repeats ? bound.repeats + ' ' + bound.modes.join('/') + ' repeat' : 'no repeat';
    const planned = bound.planned.length ? bound.planned.length + ' planned launch' + (bound.planned.length > 1 ? 'es' : '') + ' and ' : '';
    return planned + strict + (bound.questions.length ? ' (widest open answer: ' + WIDEST_ANSWER.repeats + ' FULL repeat)' : '');
}

/**
 * Judges launches in every terminal variant. Only a DONE walk can be missing a future required launch.
 */
export function judgeReviewEconomy(result: Pick<WalkResult, 'outcome' | 'reviews' | 'sweep'> & Partial<Pick<WalkResult, 'events'>>): EconomyVerdict | null {
    observeStandOracle('review-economy');
    const sweep = result.sweep;
    if (!sweep?.economy) return null;
    const observed = result.reviews.filter(review => (review.step ?? -1) >= sweep.step);
    const classified = result.events?.filter(event => event.type === 'PREFLIGHT_CLASSIFIED'
        && event.details.required_reviews && typeof event.details.required_reviews === 'object'
        && !Array.isArray(event.details.required_reviews)).at(-1);
    const requiredAtDone = classified ? Object.entries(classified.details.required_reviews as Record<string, unknown>)
        .filter(([, required]) => required === true).map(([lane]) => lane) : undefined;
    const firstRequired = sweep.requiredAtDone ?? requiredAtDone;
    const bounds = reviewEconomyBound(sweep.step, sweep.disturbances, sweep.economy,
        [...observed.map(review => review.lane), ...firstRequired ?? []], sweep.requiredAtDone, firstRequired);
    const excess: EconomyExcess[] = [], missed: EconomyMissed[] = [], unjudged: EconomyVerdict['unjudged'] = [];
    for (const bound of bounds) {
        const laneLaunches = observed.filter(review => review.lane === bound.lane);
        const launches = laneLaunches.slice(bound.planned.length);
        const requiredLaunches = bound.state === 'pending' ? laneLaunches : launches;
        const qualifying = bound.requiredMode ? requiredLaunches.filter(review => review.mode === bound.requiredMode) : requiredLaunches;
        if (result.outcome === 'done' && qualifying.length < bound.required) {
            missed.push({ kind: 'missed-review', lane: bound.lane, rule: bound.rule, required: bound.required, launched: qualifying.length,
                ...(bound.requiredMode ? { requiredMode: bound.requiredMode } : {}) });
        }
        const open = bound.questions.length > 0;
        const widest = open ? WIDEST_ANSWER : bound;
        let undecided = 0;
        laneLaunches.slice(0, bound.planned.length).forEach((review, index) => {
            const expected = bound.planned[index].mode;
            const kind = review.mode !== 'FULL' && review.mode !== 'DELTA' ? 'unknown-mode'
                : review.mode === 'DELTA' && expected === 'FULL' ? 'delta-where-full'
                    : review.mode === 'FULL' && expected === 'DELTA' ? 'full-where-delta' : null;
            if (kind) excess.push({ kind, lane: bound.lane, review, rule: bound.rule, allowed: 'planned ' + expected + ' launch' });
        });
        launches.forEach((review, index) => {
            const allowed = describeAllowed(bound);
            if (review.mode !== 'FULL' && review.mode !== 'DELTA') excess.push({ kind: 'unknown-mode', lane: bound.lane, review, rule: bound.rule, allowed });
            if (index >= widest.repeats) excess.push({ kind: 'extra-launch', lane: bound.lane, review, rule: bound.rule, allowed });
            if (review.mode === 'DELTA' && widest.modes.length === 1 && widest.modes[0] === 'FULL') {
                excess.push({ kind: 'delta-where-full', lane: bound.lane, review, rule: bound.rule, allowed });
            } else if (index < widest.repeats && review.mode === 'FULL' && !widest.modes.includes('FULL')) {
                excess.push({ kind: 'full-where-delta', lane: bound.lane, review, rule: bound.rule, allowed });
            } else if (index < widest.repeats && open && (index >= bound.repeats || review.mode === 'FULL' && !bound.modes.includes('FULL'))) undecided += 1;
        });
        if (undecided) unjudged.push({ lane: bound.lane, questions: bound.questions, launches: undecided });
    }
    return { disturbances: sweep.disturbances, bounds, observed, excess, missed, unjudged };
}

/** A single wrong gate keeps its stricter whole-run checks (walk:wrong-gate-*); the economy judgment would repeat them. */
export function isWrongGateOnly(disturbances: readonly string[]): boolean {
    return disturbances.length === 1 && disturbances[0].startsWith('wrong-gate:');
}

/**
 * The step that sent the agent into this launch: the last restart before it, else the rebuild of its review context.
 * Without a launch (a missed review) it is the last restart of the run, else the step that closed the review gate.
 */
export function economyRecoveryStep(result: Pick<WalkResult, 'steps'>, injectionStep: number, review?: WalkReview): WalkStep | undefined {
    const launched = review?.step ?? Number.MAX_SAFE_INTEGER;
    const window = result.steps.filter(step => step.index >= injectionStep && step.index < launched);
    return window.filter(step => /^restart-/u.test(step.gate ?? '') || step.gate === 'task-reset').at(-1)
        ?? (review ? window.find(step => step.gate === 'build-review-context' && step.route?.endsWith('/' + review.lane))
            ?? result.steps.find(step => step.index === launched)
            : window.find(step => step.gate === 'required-reviews-check'));
}

/** Excess grouped per finding kind and lane: one stable finding per lane, however many launches it repeated. */
export function economyExcessByLane(verdict: EconomyVerdict): Array<{ key: string; entries: EconomyExcess[] }> {
    const groups = new Map<string, EconomyExcess[]>();
    for (const entry of verdict.excess) groups.set(entry.kind + ':' + entry.lane, [...groups.get(entry.kind + ':' + entry.lane) ?? [], entry]);
    return [...groups].map(([key, entries]) => ({ key, entries }));
}

/** The disturbance combination without its targets, for grouping. */
function disturbanceKinds(disturbances: readonly string[]): string {
    return [...new Set(disturbances.map(id => id.split(':')[0]))].sort().join('+');
}

function shortDisturbances(disturbances: readonly string[]): string {
    return disturbances.map(id => /^[a-z-]+-artifact:/u.test(id) ? id.split(':')[0] + ':' + artifactRole(id.slice(id.indexOf(':') + 1)) : id).join(' + ');
}

export interface EconomyGroup {
    route: string; disturbance: string; kind: EconomyExcess['kind'] | EconomyMissed['kind']; rule: EconomyRule; lanes: string[];
    records: number; variants: number; steps: number[]; source: string[]; example: string; replay: string; scenarios: string[];
}
export interface EconomyQuestionGroup { question: string; text: string; variants: number; examples: Array<{ scenario: string; disturbances: string; observed: string; replay: string }> }
export interface EconomySummary {
    /** Terminal variants with baseline facts. */
    /** `overBound` also counts launches with an unsafe or unknown mode. */
    judged: number; withinBound: number; overBound: number; unjudged: number;
    /** Variants that kept a review the rules require to repeat. */
    missedReview: number;
    /** Single wrong-gate variants: the report groups their whole-run checks separately. */
    wrongGate: number;
    groups: EconomyGroup[]; questions: EconomyQuestionGroup[];
    rules: typeof ECONOMY_RULES;
}

const MAX_QUESTION_EXAMPLES = 8;

/** Findings grouped by recovery route and disturbance kind; undecided variants grouped by operator question. */
export function summarizeReviewEconomy(results: readonly WalkResult[]): EconomySummary {
    const groups = new Map<string, EconomyGroup & { seen: Set<string> }>();
    const questions = new Map<string, EconomyQuestionGroup & { seen: Set<string> }>();
    let judged = 0, withinBound = 0, overBound = 0, unjudged = 0, wrongGate = 0, missedReview = 0;
    for (const result of results) {
        const verdict = judgeReviewEconomy(result);
        if (!verdict || !result.sweep) continue;
        if (isWrongGateOnly(verdict.disturbances)) { wrongGate += 1; continue; }
        judged += 1;
        if (verdict.excess.length) overBound += 1;
        if (verdict.unjudged.length) unjudged += 1;
        if (verdict.missed.length) missedReview += 1;
        if (!verdict.excess.length && !verdict.unjudged.length && !verdict.missed.length) withinBound += 1;
        const replay = 'GARDA_SYNTHETIC_SEED=' + result.sweep.seed + ' GARDA_SYNTHETIC_WALK_ONLY=' + result.scenarioId;
        const observed = verdict.observed.map(review => review.lane + ':' + review.mode).join(' ') || '(no launch)';
        for (const excess of [...verdict.excess, ...verdict.missed]) {
            const step = 'review' in excess ? economyRecoveryStep(result, result.sweep.step, excess.review)
                : economyRecoveryStep(result, result.sweep.step);
            const route = step?.route ?? '(unknown)', disturbance = disturbanceKinds(verdict.disturbances);
            const key = [route, disturbance, excess.kind, excess.rule].join('|');
            const group = groups.get(key) ?? { route, disturbance, kind: excess.kind, rule: excess.rule, lanes: [], records: 0, variants: 0, steps: [],
                source: step?.routes ?? [], example: shortDisturbances(verdict.disturbances) + ' at step ' + result.sweep.step + ': ' + observed,
                replay, scenarios: [], seen: new Set<string>() };
            group.records += 1;
            if (!group.lanes.includes(excess.lane)) group.lanes.push(excess.lane);
            if (!group.seen.has(result.scenarioId)) { group.seen.add(result.scenarioId); group.variants += 1; group.scenarios.push(result.scenarioId); }
            if (!group.steps.includes(result.sweep.step)) group.steps.push(result.sweep.step);
            groups.set(key, group);
        }
        for (const question of new Set(verdict.unjudged.flatMap(entry => entry.questions))) {
            const id = question.split(':')[0], target = question.slice(id.length + 1);
            const group = questions.get(question) ?? { question, text: ECONOMY_QUESTIONS[id as EconomyQuestion] + (target ? ' Artifact: ' + target + '.' : ''),
                variants: 0, examples: [], seen: new Set<string>() };
            if (!group.seen.has(result.scenarioId)) {
                group.seen.add(result.scenarioId); group.variants += 1;
                if (group.examples.length < MAX_QUESTION_EXAMPLES) group.examples.push({ scenario: result.scenarioId,
                    disturbances: shortDisturbances(verdict.disturbances) + ' at step ' + result.sweep.step, observed, replay });
            }
            questions.set(question, group);
        }
    }
    const strip = <T extends { seen: Set<string> }>({ seen: _seen, ...rest }: T): Omit<T, 'seen'> => rest;
    return { judged, withinBound, overBound, unjudged, missedReview, wrongGate,
        groups: [...groups.values()].map(group => ({ ...strip(group), steps: [...group.steps].sort((a, b) => a - b) }))
            .sort((a, b) => b.records - a.records || a.route.localeCompare(b.route)),
        questions: [...questions.values()].map(group => strip(group)).sort((a, b) => b.variants - a.variants || a.question.localeCompare(b.question)),
        rules: ECONOMY_RULES };
}

export function renderReviewEconomy(summary: EconomySummary): string[] {
    return ['## Review economy of disturbed variants', '',
        summary.judged + ' terminal variants were judged: ' + summary.withinBound + ' within the bound, ' + summary.overBound
            + ' with launch findings, ' + summary.missedReview + ' keeping a review the rules require to repeat, ' + summary.unjudged
            + ' with launches left unjudged by an operator question. ' + summary.wrongGate
            + ' single wrong-gate variants keep their walk:wrong-gate-* checks.', '',
        '| Recovery route | Disturbance | Finding | Lanes | Records | Variants | Steps | Rule | Example | Replay |', '|---|---|---|---|---:|---:|---|---|---|---|',
        ...summary.groups.map(group => '| ' + [group.route, group.disturbance, group.kind, group.lanes.join(', '), group.records, group.variants,
            group.steps.join(' '), group.rule, group.example, group.replay].join(' | ') + ' |'), '',
        '### Operator questions', '', ...summary.questions.length ? summary.questions.flatMap(group => ['- ' + group.question + ' (' + group.variants + ' variants): ' + group.text,
            ...group.examples.map(example => '  - ' + example.disturbances + ': ' + example.observed + '; ' + example.replay)]) : ['None.'], ''];
}
