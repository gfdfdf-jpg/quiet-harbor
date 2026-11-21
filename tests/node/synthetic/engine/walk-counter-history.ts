import * as fs from 'node:fs';
import * as path from 'node:path';
import { counterBudgets, type CounterBaseline } from './walk-metrics';
import { RECORDED_COUNTERS } from './walk-recorded-work';
import { walkHash } from './walk-run-store';

/** The migration changes relative rules, never the ordinary constants or other ceilings. */
export function assertRecordedBudgetMigration(before: CounterBaseline, after: CounterBaseline): void {
    if (walkHash(before.routes) !== walkHash(after.routes)) throw new Error('Ordinary route constants must remain unchanged');
    const ids = [...new Set([...Object.keys(before.states ?? {}), ...Object.keys(after.states ?? {})])];
    const routes = [...new Set([...Object.keys(before.routes), ...Object.values(before.states ?? {}).flatMap(state => Object.keys(state.routes)),
        ...Object.values(after.states ?? {}).flatMap(state => Object.keys(state.routes))])];
    for (const id of ids) {
        if (before.states?.[id]?.inherits !== after.states?.[id]?.inherits) throw new Error('Counter inheritance must remain unchanged: ' + id);
        for (const route of routes) {
            const fixed = (baseline: CounterBaseline) => Object.fromEntries(Object.entries(counterBudgets(baseline, route, id) ?? {})
                .filter(([key]) => !RECORDED_COUNTERS.has(key)));
            if (walkHash(fixed(before)) !== walkHash(fixed(after))) throw new Error('Unrelated counter ceiling changed: ' + id + '/' + route);
        }
    }
    for (const id of after.recordedWork?.retireStates ?? []) for (const counters of Object.values(after.states?.[id]?.routes ?? {}))
        if (Object.keys(counters).some(key => RECORDED_COUNTERS.has(key))) throw new Error('Obsolete relative override remains: ' + id);
}

interface HistoryMetadata { baseline_update?: { evidence: string; previous_sha256: string } }
interface DecisionRecord { kind: string; previous_sha256: string; previous: unknown; accepted: unknown }
const withoutUpdate = (value: unknown) => Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'baseline_update'));

/** Archived samples certify their original accepted baseline. Current relative
 * acceptance is checked separately from recorded inputs, not against old maxima.
 * Follow the real, checksummed acceptance ledger; never invent a historical seal. */
export function calibrationCounterBaseline(root: string, current: CounterBaseline, platform: string): CounterBaseline {
    if (!current.recordedWork) return current;
    const directory = path.resolve(root), platformFile = platform !== 'win32';
    const select = (value: unknown): CounterBaseline | null => platformFile
        ? (value as { platforms: Record<string, { baseline: CounterBaseline | null }> }).platforms[platform]?.baseline ?? null
        : value as CounterBaseline;
    let document: unknown = platformFile ? JSON.parse(fs.readFileSync(path.join(directory, 'walk-counter-platforms.json'), 'utf8')) : current;
    const seen = new Set<string>();
    for (;;) {
        const active = select(document);
        if (!active) throw new Error('Missing historical platform counter baseline');
        if (!active.recordedWork) return active;
        const metadata = (document as HistoryMetadata).baseline_update;
        if (!metadata) throw new Error('Relative calibration requires an explicit accepted baseline decision');
        const file = path.resolve(directory, metadata.evidence), relative = path.relative(directory, file);
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || seen.has(file))
            throw new Error('Invalid counter baseline history path');
        seen.add(file);
        const record = JSON.parse(fs.readFileSync(file, 'utf8')) as DecisionRecord;
        if (path.basename(file) !== walkHash(record) + '.json' || record.kind !== (platformFile ? 'counter-platforms' : 'counters')
            || record.previous_sha256 !== metadata.previous_sha256
            || walkHash(withoutUpdate(record.accepted)) !== walkHash(withoutUpdate(document))) throw new Error('Counter baseline history differs from its acceptance');
        const previous = select(record.previous);
        if (!previous) throw new Error('Missing previous counter calibration');
        if (!previous.recordedWork) assertRecordedBudgetMigration(previous, active);
        document = record.previous;
    }
}
