import type { StandFinding } from '../../../../scripts/node-foundation/synthetic/model';
import type { WalkReport } from './walk-report';
import type { TimingReport } from './step-timing-session';
import type { QuietEvidence } from './step-timing';

export interface StandCheck { id: string; status: 'running' | 'PASS' | 'FAIL'; log: string; exit_code?: number | null; reused?: boolean }
export interface Pillar { verdict: 'PASS' | 'FAIL'; assessment: 'PASS' | 'FAIL' | 'INCOMPLETE' | 'INCONCLUSIVE' | 'UNBASELINED'; reasons: string[]; details: string[] }
export interface SummaryInput {
    level: string; final: boolean; partial: boolean; checks: StandCheck[]; baselineProblems: string[];
    walk?: WalkReport; partialFindings?: StandFinding[]; progress?: unknown; policyFindings?: StandFinding[];
    quiet?: QuietEvidence; timing?: TimingReport; timingRequested: boolean;
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
    const pillars = {
        navigator_correctness: pillar([...(input.walk && findings.length ? [] : failedChecks(['walk'])), ...navigatorFindings.map(f => f.id)], walkPending,
            ['walk/navigator-walk.md', 'walk/partial-findings.json', 'walk/scenarios/']),
        stack_independence: pillar([...failedChecks(['contract', 'fixture-contract']),
            ...findings.filter(f => /stack-|adapter|gate-tour/u.test(f.id)).map(f => f.id)], walkPending || incomplete(['contract', 'fixture-contract']),
            ['contract.json', 'contract-selection.log', 'contract-tour.log', 'contract-rename.log', 'fixture-contract.log', 'walk/navigator-walk.json']),
        review_logic: pillar([...failedChecks(['economy', 'policy-reuse']), ...reviewFindings.map(f => f.id), ...(input.policyFindings ?? []).map(f => f.id)],
            walkPending || incomplete(['economy', 'policy-reuse']), ['economy.log', 'policy-reuse.log', 'policy.json', 'walk/navigator-walk.json']),
        speed: pillar([...input.baselineProblems, ...counters.map(a => a.route + ': ' + a.metric + '=' + a.observed + ' > ' + a.limit)], walkPending,
            ['walk/navigator-walk.json', 'timing/step-timing.json', 'timing/preflight.json'])
    };
    const work = pillars.speed.assessment;
    const timing = input.timing?.verdict ?? (input.quiet && !input.quiet.quiet ? 'INCONCLUSIVE' : input.timingRequested ? 'INCOMPLETE' : 'INCONCLUSIVE');
    if (pillars.speed.assessment !== 'FAIL' && timing !== 'PASS') {
        pillars.speed.verdict = 'FAIL'; pillars.speed.assessment = timing;
        pillars.speed.reasons.push(...(input.quiet?.reasons ?? []), ...(!input.timingRequested ? ['Step timing not requested; quiet-machine comparison remains required'] : []));
    }
    const harnessProblems = [...input.baselineProblems, ...failedChecks(['stand-unit'])];
    if (harnessProblems.length) for (const value of Object.values(pillars)) {
        value.verdict = 'FAIL'; value.assessment = 'FAIL'; value.reasons.push(...harnessProblems);
    }
    return { schema_version: 1, updated_at: new Date().toISOString(), state: input.final ? 'final' : 'running', level: input.level,
        scope: input.partial ? 'selected scenarios only' : input.level === 'short' ? 'representative short selection' : 'complete level',
        verdict: Object.values(pillars).every(value => value.verdict === 'PASS') ? 'PASS' : 'FAIL', pillars,
        speed: { work_budgets: work, step_timing: timing, timing_requested: input.timingRequested,
            missing_routes: input.timing?.missing_routes ?? [], quiet: input.quiet,
            history_rule: 'Linear event work is allowed; each event read/verified once per call. Repeated clones/parsing and subprocess growth fail the deterministic budgets.' },
        checks: input.checks, progress: input.progress,
        totals: { findings: findings.length, coverage: input.walk?.coverage, economy: input.walk?.economy,
            counter_anomalies: counters.length, scenarios: input.walk?.scenarios.length, steps: input.walk?.executedSteps },
        timing: input.timing, baseline_problems: input.baselineProblems };
}
export function renderStandSummary(report: ReturnType<typeof buildStandSummary>): string {
    const rows = report.timing?.routes ?? [];
    return ['# Garda reference stand', '', `${report.verdict}; ${report.state}; level ${report.level}; ${report.scope}.`, '',
        '| Pillar | PASS/FAIL | Assessment | Details |', '|---|---|---|---|',
        ...Object.entries(report.pillars).map(([key, value]) => `| ${key} | ${value.verdict} | ${value.assessment} | ${value.details.map(file => `[${file}](${file})`).join(', ')} |`), '',
        `Work budgets: ${report.speed.work_budgets}. Step timing: ${report.speed.step_timing}.`, '',
        ...Object.entries(report.pillars).flatMap(([key, value]) => value.reasons.map(reason => `- ${key}: ${reason.replace(/\n/gu, ' ')}`)), '',
        '## Step timing', '', 'resolver-warm only. Five warmups, 100 samples, nearest-rank p95. Inclusive diagnostics are separate.', '',
        '| Stack/scenario/route/history | N | Median baseline/candidate | Δms / Δ% | p95 baseline/candidate | Δms / Δ% | Limits | Verdict | Raw |',
        '|---|---:|---|---|---|---|---|---|---|',
        ...rows.map(row => `| ${row.key} (${row.history}) | ${row.samples_ms.length} | ${row.comparison?.median.baseline_ms ?? 'missing'} / ${row.median_ms ?? 'missing'} | ${row.comparison?.median.delta_ms ?? '—'} / ${row.comparison?.median.delta_percent ?? '—'} | ${row.comparison?.p95.baseline_ms ?? 'missing'} / ${row.p95_ms ?? 'missing'} | ${row.comparison?.p95.delta_ms ?? '—'} / ${row.comparison?.p95.delta_percent ?? '—'} | ${JSON.stringify(row.limits)} | ${row.verdict} | [samples and inputs](timing/${row.raw_manifest}) |`), '',
        ...report.speed.missing_routes.map(key => '- Missing checkpoint: ' + key), '',
        'Raw counters, canonical-byte work, route coverage, review counts/modes and replay commands: [navigator report](walk/navigator-walk.json).', '',
        'FAIL/INCOMPLETE and FAIL/INCONCLUSIVE do not certify acceptance. A short run covers its documented selection; full and sweep retain their coverage obligations.', ''
    ].join('\n');
}
