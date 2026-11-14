import type { CounterBaseline, RouteMetrics } from './walk-metrics';

/** Suggest an initial envelope from UNDISTURBED observations. No runner calls this or writes a baseline. */
export function proposeCounterBaseline(metrics: readonly RouteMetrics[], provenance: string): CounterBaseline {
    return { schema: 1, provenance, routes: Object.fromEntries(metrics.map(route => [route.route,
        Object.fromEntries(Object.entries(route.counters).filter(([key]) => /^(?:subprocess:|file_probes:|file_hash:file$|payload_reads$|timeline_|json_parse_verified_timeline_event$|visit:verified_timeline_(?:index|selected)_event$|visit:timeline_cloned_event$)/u.test(key)).map(([key, distribution]) => [key, {
            expected: distribution.median,
            tolerance: Math.max(0, Math.ceil(distribution.max - distribution.median)),
            // These count boundaries, not the size of the timeline itself. History growth must not silently
            // get a larger allowance just because a source run already has a positive slope.
            constantWithEvents: /^(?:subprocess:|file_hash:file$|timeline_payload_read:file$|timeline_parse$|timeline_verify$)/u.test(key),
            growthTolerance: 0
        }]))
    ])) };
}
