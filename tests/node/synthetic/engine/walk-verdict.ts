import type { StandFinding } from '../../../../scripts/node-foundation/synthetic/model';
import type { WalkResult } from './navigator-walk';
import { buildWalkReport } from './walk-report';
import { anomalyFindings } from './walk-metrics';
import { stackAdapterRegressions } from './walk-stack-scenarios';

/** Both a single run and merge judge raw records with this exact reducer, after coverage is a union. */
export function judgeWalk(results: readonly WalkResult[], findings: readonly StandFinding[], level: string, partial: boolean) {
    const ordered = [...results].sort((a, b) => a.scenarioId < b.scenarioId ? -1 : a.scenarioId > b.scenarioId ? 1 : 0);
    const all = [...findings];
    for (const id of stackAdapterRegressions(ordered)) all.push({ layer: 'walk', kind: 'contract', id: 'walk:' + id,
        summary: 'Adapter parity is incomplete or weaker than the generic peer.', detail: { replay: 'GARDA_SYNTHETIC_WALK_ONLY=' + id.split(':').at(-1) } });
    const report = buildWalkReport(ordered, all);
    all.push(...anomalyFindings(report.anomalies));
    if (!['short', 'sample'].includes(level) && !partial) {
        all.push(...report.coverage.unaccounted.map(id => ({ layer: 'walk' as const, kind: 'contract' as const,
            id: 'walk:uncovered:' + id, summary: 'Source route neither reached nor explained: ' + id,
            detail: { route: id, step: null, replay: 'GARDA_SYNTHETIC_WALK_LEVEL=' + level } })));
        all.push(...report.coverage.invalidExemptions.map(id => ({ layer: 'walk' as const, kind: 'contract' as const,
            id: 'walk:invalid-exemption:' + id, summary: 'Invalid coverage exemption: ' + id, detail: { route: id } })));
    }
    report.findings = all.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    // Stack outcomes include every finding, including the adapter parity checks above.
    return buildWalkReport(ordered, report.findings);
}
