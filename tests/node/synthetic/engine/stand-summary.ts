import type { StandFinding } from '../../../../scripts/node-foundation/synthetic/model';
import type { WalkReport } from './walk-report';
import type { TimingReport } from './step-timing-session';
import type { QuietEvidence } from './step-timing';
import type { PropertyTrace, StandProperties } from './stand-properties';

export interface StandCheck { id: string; status: 'running' | 'PASS' | 'FAIL'; log: string; exit_code?: number | null; reused?: boolean; executed_tests?: string[]; oracles_executed?: string[] }
export interface Pillar { verdict: 'PASS' | 'FAIL'; assessment: 'PASS' | 'FAIL' | 'INCOMPLETE' | 'INCONCLUSIVE' | 'UNBASELINED' | 'NEEDS_CALIBRATION'; reasons: string[]; details: string[] }
export interface SummaryInput {
    level: string; final: boolean; partial: boolean; checks: StandCheck[]; baselineProblems: string[];
    walk?: WalkReport; partialFindings?: StandFinding[]; progress?: unknown; policyFindings?: StandFinding[];
    quiet?: QuietEvidence; timing?: TimingReport; timingRequested: boolean;
    traceability?: PropertyTrace[]; traceProblems?: string[]; limits?: StandProperties['limits'];
    shard?: { index: number; total: number }; ci?: boolean;
    policyProblems?: string[];
}
export function buildStandSummary(input: SummaryInput) {
    const findings = input.walk?.findings ?? input.partialFindings ?? [];
    const failedChecks = (ids: string[]) => input.checks.filter(check => ids.includes(check.id) && check.status === 'FAIL').map(check => check.id + ' failed');
    const incomplete = (ids: string[]) => ids.some(id => !input.checks.some(check => check.id === id && check.status !== 'running'));
    const pillar = (reasons: string[], pending: boolean, details: string[]): Pillar => ({ verdict: reasons.length || pending ? 'FAIL' : 'PASS',
        assessment: reasons.length ? 'FAIL' : pending ? 'INCOMPLETE' : 'PASS', reasons, details });
    const reviewFindings = findings.filter(finding => /economy|reviews:|modes:|review-order|follow-up/iu.test(finding.id));
    const navigatorFindings = findings.filter(finding => !/walk:(?:counter|time|missing-baseline)/u.test(finding.id) && !reviewFindings.includes(finding));
    const counters = input.walk?.anomalies.filter(anomaly => anomaly.severity === 'failure' && !anomaly.kind.startsWith('time-')) ?? [];
    const walkPending = !input.walk || incomplete(['walk']);
    const missingStackReviews = !input.partial && ['full', 'sweep'].includes(input.level)
        ? (input.walk?.stackReviewLogic ?? []).flatMap(stack => ['review-edit', 'lost-evidence', 'reset-and-wrong-gate']
            .filter(family => !stack.cases.some(item => item.id === `stack-${stack.stack}-${family}`))
            .map(family => 'Missing compact review case: stack-' + stack.stack + '-' + family)) : [];
    const pillars = {
        navigator_correctness: pillar([...(input.walk && findings.length ? [] : failedChecks(['walk'])), ...navigatorFindings.map(f => f.id)], walkPending,
            ['walk/navigator-walk.md', 'walk/partial-findings.json', 'walk/scenarios/']),
        stack_independence: pillar([...failedChecks(['contract', 'fixture-contract']),
            ...findings.filter(f => /stack-|adapter|gate-tour/u.test(f.id)).map(f => f.id)], walkPending || incomplete(['contract', 'fixture-contract']),
            ['contract.json', 'contract-selection.log', 'contract-tour.log', 'contract-rename.log', 'fixture-contract.log', 'walk/navigator-walk.json']),
        review_logic: { ...pillar([...failedChecks(['economy', 'policy-reuse']), ...reviewFindings.map(f => f.id), ...missingStackReviews, ...(input.policyFindings ?? []).map(f => f.id),
            ...(input.walk?.stackReviewLogic ?? []).filter(stack => stack.verdict === 'FAIL').map(stack => 'Stack review logic failed: ' + stack.stack)],
            walkPending || incomplete(['economy', 'policy-reuse']), ['economy.log', 'policy-reuse.log', 'policy.json', 'walk/navigator-walk.json', 'walk/review-rotation.json']),
            stacks: input.walk?.stackReviewLogic ?? [] },
        speed: pillar([...input.baselineProblems, ...counters.map(a => a.route + ': ' + a.metric + '=' + a.observed + ' > ' + a.limit)], walkPending,
            ['walk/navigator-walk.json', 'timing/step-timing.json', 'timing/preflight.json'])
    };
    if (counters.some(anomaly => anomaly.kind === 'missing-baseline') && !input.baselineProblems.length) {
        pillars.speed.assessment = 'NEEDS_CALIBRATION';
        pillars.speed.reasons.push('NEEDS_CALIBRATION: explicit platform route/state/counter budgets are missing; inspect raw walk evidence');
    }
    const work = pillars.speed.assessment;
    const timing = input.ci ? 'INCONCLUSIVE' : input.timing?.verdict ?? (input.quiet && !input.quiet.quiet ? 'INCONCLUSIVE' : input.timingRequested ? 'INCOMPLETE' : 'INCONCLUSIVE');
    if (pillars.speed.assessment === 'PASS' && timing !== 'PASS') {
        pillars.speed.verdict = (input.level === 'short' || input.ci) && timing === 'INCONCLUSIVE' ? 'PASS' : 'FAIL';
        pillars.speed.assessment = timing;
        pillars.speed.reasons.push(...(input.quiet?.reasons ?? []), ...(input.ci ? ['CI runner step timing is always INCONCLUSIVE and cannot supply a baseline']
            : !input.timingRequested ? ['Step timing not requested; quiet-machine comparison remains required'] : []));
    }
    const harnessProblems = [...input.baselineProblems, ...(input.policyProblems ?? []), ...failedChecks(input.checks.filter(check => !['walk', 'timing', 'contract',
        'fixture-contract', 'economy', 'policy-reuse'].includes(check.id)).map(check => check.id)),
        ...(input.traceProblems ?? []), ...(input.traceability ?? []).filter(row => row.status === 'FAIL').map(row => 'Property failed: ' + row.id)];
    if (harnessProblems.length) for (const value of Object.values(pillars)) {
        value.verdict = 'FAIL'; value.assessment = 'FAIL'; value.reasons.push(...harnessProblems);
    }
    return { schema_version: 1, updated_at: new Date().toISOString(), state: input.shard ? 'partial' : input.final ? 'final' : 'running', level: input.level,
        shard: input.shard,
        scope: input.partial ? 'selected scenarios only' : input.level === 'short' ? 'representative short selection' : 'complete level',
        verdict: input.shard ? 'PARTIAL' : Object.values(pillars).every(value => value.verdict === 'PASS') ? 'PASS' : 'FAIL', pillars,
        speed: { work_budgets: work, step_timing: timing, timing_requested: input.timingRequested,
            missing_routes: input.timing?.missing_routes ?? [], quiet: input.quiet,
            history_rule: 'Linear event work is allowed; each event read/verified once per call. Repeated clones/parsing and subprocess growth fail the deterministic budgets.' },
        checks: input.checks, progress: input.progress,
        totals: { findings: findings.length, coverage: input.walk?.coverage, economy: input.walk?.economy,
            counter_anomalies: counters.length, scenarios: input.walk?.scenarios.length, steps: input.walk?.executedSteps },
        timing: input.timing, baseline_problems: input.baselineProblems, policy_problems: input.policyProblems ?? [],
        traceability: input.traceability ?? [], trace_problems: input.traceProblems ?? [], limits: input.limits ?? [] };
}
export function renderStandSummary(report: ReturnType<typeof buildStandSummary>): string {
    const rows = report.timing?.routes ?? [];
    return ['# Garda reference stand', '', `${report.verdict}; ${report.state}; level ${report.level}; ${report.scope}.`, '',
        ...(report.shard ? [`Shard ${report.shard.index}/${report.shard.total}: partial evidence, never a verdict.`, ''] : []),
        '| Pillar | PASS/FAIL | Assessment | Details |', '|---|---|---|---|',
        ...Object.entries(report.pillars).map(([key, value]) => `| ${key} | ${value.verdict} | ${value.assessment} | ${value.details.map(file => `[${file}](${file})`).join(', ')} |`), '',
        `Work budgets: ${report.speed.work_budgets}. Step timing: ${report.speed.step_timing}.`, '',
        ...Object.entries(report.pillars).flatMap(([key, value]) => value.reasons.map(reason => `- ${key}: ${reason.replace(/\n/gu, ' ')}`)), '',
        '## What this run proves', '',
        'PASS applies only to the level, scenarios, source identity and checks shown here. Known findings also fail acceptance. NOT_REQUESTED is not evidence.', '',
        ...report.limits.map(limit => '- Does not prove ' + limit.unproved + '. External acceptance: ' + limit.external + '.'), '',
        '## Property traceability', '',
        '| Property | Concept / registry gate | Status | Checks actually requested |', '|---|---|---|---|',
        ...report.traceability.map(row => `| ${row.id}: ${row.statement} | ${[...row.concept, ...row.gates].join(', ')} | ${row.status} | ${row.checks.map(check => `${check.id} → [${check.run}](${check.run}.log): ${check.status} (${check.detail})`).join('<br>')} |`), '',
        ...report.trace_problems.map(problem => '- TRACEABILITY FAILURE: ' + problem), '',
        '## Review logic by stack', '',
        '| Stack | Verdict | Scenarios | Reviews (lane:mode) |', '|---|---|---|---|',
        ...report.pillars.review_logic.stacks.map(stack => `| ${stack.stack} | ${stack.verdict} | ${stack.cases.length} | ${stack.cases.map(item => item.id + ': ' + item.modes.join(', ')).join('<br>')} |`), '',
        '## Step timing', '', 'resolver-warm only. Five warmups, 100 samples, nearest-rank p95. Inclusive diagnostics are separate.', '',
        '| Stack/scenario/route/history | N | Median baseline/candidate | Δms / Δ% | p95 baseline/candidate | Δms / Δ% | Limits | Verdict | Raw |',
        '|---|---:|---|---|---|---|---|---|---|',
        ...rows.map(row => `| ${row.key} (${row.history}) | ${row.samples_ms.length} | ${row.comparison?.median.baseline_ms ?? 'missing'} / ${row.median_ms ?? 'missing'} | ${row.comparison?.median.delta_ms ?? '—'} / ${row.comparison?.median.delta_percent ?? '—'} | ${row.comparison?.p95.baseline_ms ?? 'missing'} / ${row.p95_ms ?? 'missing'} | ${row.comparison?.p95.delta_ms ?? '—'} / ${row.comparison?.p95.delta_percent ?? '—'} | ${JSON.stringify(row.limits)} | ${row.verdict} | [samples and inputs](timing/${row.raw_manifest}) |`), '',
        ...report.speed.missing_routes.map(key => '- Missing checkpoint: ' + key), '',
        'Raw counters, canonical-byte work, route coverage, review counts/modes and replay commands: [navigator report](walk/navigator-walk.json).', '',
        'Short and CI permit INCONCLUSIVE step timing when work budgets pass; neither makes a timing acceptance claim. Local full/sweep require complete timing. Coverage obligations remain unchanged.', ''
    ].join('\n');
}
