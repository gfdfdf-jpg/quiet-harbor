import { contractSelections } from './stand-contract';

/** The executor and traceability checker consume the same schedule. No second list of runnable checks. */
export interface ScheduledStandCheck { id: string; file: string; phase: 'unit' | 'parallel' | 'contract' | 'walk' | 'timing'; pattern?: string }
export function standCheckPlan(level: string, contractSource: string): ScheduledStandCheck[] {
    return [
        { id: 'stand-unit', file: 'reference-stand-unit.test.js', phase: 'unit' },
        { id: 'shard-unit', file: 'reference-stand-shards.test.js', phase: 'unit' },
        { id: 'stand-meta', file: 'synthetic-stand-properties.test.js', phase: 'unit' },
        { id: 'field-unit', file: 'synthetic-field-cases.test.js', phase: 'unit' },
        { id: 'field-lifecycle', file: 'synthetic-field-lifecycle.test.js', phase: 'parallel' },
        { id: 'validation-plan-unit', file: '../core/task-validation-plan.test.js', phase: 'unit' },
        { id: 'stack-review-unit', file: 'synthetic-stack-review.test.js', phase: 'unit' },
        { id: 'fixture-contract', file: 'synthetic-stack-fixtures.test.js', phase: 'unit' },
        { id: 'economy', file: 'synthetic-walk-economy.test.js', phase: 'unit' },
        { id: 'policy-reuse', file: 'synthetic-policy-reuse.test.js', phase: 'parallel',
            pattern: level === 'short' ? '^a policy change finishes and reuses an already-started reviewer$' : undefined },
        ...contractSelections(contractSource).map(part => ({ ...part, file: '../policy/stack-universal-gates-contract.test.js', phase: 'contract' as const })),
        { id: 'walk', file: 'synthetic-navigator-walk.test.js', phase: 'walk' },
        { id: 'timing', file: 'synthetic-navigator-walk.test.js', phase: 'timing' }
    ];
}
