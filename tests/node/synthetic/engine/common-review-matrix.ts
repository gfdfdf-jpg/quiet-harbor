import type { WalkScenario } from './navigator-walk';
import { STACK_MANIFESTS } from './walk-stack-fixtures';

export const MATRIX_MODES = ['strict_sequential', 'parallel_all', 'test_after_code', 'code_first_optional'] as const;
export const MATRIX_LANES = ['code', 'db', 'security', 'refactor', 'api', 'performance', 'infra', 'dependency', 'test'] as const;
export type MatrixMode = typeof MATRIX_MODES[number];
export type MatrixRepair = 'source' | 'test' | 'document' | 'new-test' | 'new-source' | 'helper' | 'source-test' | 'new-config';
export interface MatrixRepairStep { lane: string; attempt: number; kind: MatrixRepair; lines: number; files?: number }
export interface ReviewMatrixRow {
    id: string; rule: string; required: string[]; repairs: MatrixRepairStep[];
    /** Explicit oracle. No expected outcome is taken from the product's classification or receipts. */
    launches: string[]; initialSourceFiles?: number; stopOnFailure?: boolean;
    graph?: 'independent' | 'chain' | 'fanout';
    evidenceFault?: 'lost-receipt' | 'corrupt-receipt' | 'lost-report' | 'corrupt-report' | 'lost-context' | 'corrupt-context';
    reportFault?: 'broken' | 'unreachable';
    interruptTestRemediationCompile?: boolean;
    /** Frozen project policy input, selected before task entry. */
    structuralTestThreshold?: number;
    changeIntentAfterSecurityPass?: boolean;
    exerciseCloseoutRecovery?: boolean;
}
const INITIAL = ['code:FULL', 'refactor:FULL', 'api:FULL', 'test:FULL'];
const FIELD_LANES = ['code', 'db', 'security', 'refactor', 'api', 'performance', 'test'];
const repair = (lane: string, kind: MatrixRepair, lines = 1, attempt = 1, files?: number): MatrixRepairStep =>
    ({ lane, kind, lines, attempt, ...(files ? { files } : {}) });
const row = (id: string, rule: string, repairs: MatrixRepairStep[], tail: string[], extra: Partial<ReviewMatrixRow> = {}): ReviewMatrixRow =>
    ({ id, rule, required: ['refactor', 'api'], repairs, launches: [...INITIAL, ...tail], ...extra });

/** Finite guard/transition classes, not a claim to enumerate infinitely long programs or repair sequences. */
export const COMMON_REVIEW_MATRIX: readonly ReviewMatrixRow[] = [
    row('audit-s1-config-expansion', 'R1: a failed CODE baseline cannot authorize DELTA after a new non-test config joins scope.',
        [repair('code', 'new-config')], [], { launches: ['code:FULL', ...INITIAL] }),
    row('audit-s2-changed-intent', 'R2: changing task-intent invalidates every old PASS; mandatory lanes restart in FULL.', [], [],
        { required: ['db', 'security'], changeIntentAfterSecurityPass: true,
            launches: ['code:FULL', 'db:FULL', 'security:FULL', 'code:FULL', 'db:FULL', 'security:FULL', 'test:FULL'] }),
    row('audit-s3-production-structural-fix', 'R3/R4/R5: bounded production and structural test fix repeats CODE/REFACTOR/PERFORMANCE in DELTA; first TEST is FULL.',
        [repair('performance', 'source-test', 28)], [], { required: FIELD_LANES.filter(lane => !['code', 'test'].includes(lane)),
            structuralTestThreshold: 20, launches: [...FIELD_LANES.slice(0, -1).map(lane => lane + ':FULL'),
                'code:DELTA', 'refactor:DELTA', 'performance:DELTA', 'test:FULL'] }),
    row('audit-s4-structural-test-28', 'R4/R5: 28 structural test lines repeat REFACTOR/TEST in DELTA; other accepted lanes are reused.',
        [repair('test', 'test', 28)], [], { required: FIELD_LANES.filter(lane => !['code', 'test'].includes(lane)),
            structuralTestThreshold: 20, launches: [...FIELD_LANES.map(lane => lane + ':FULL'), 'refactor:DELTA', 'test:DELTA'] }),
    row('audit-recovery-no-fresh-review', 'Recovery of a wrong command, occupied native test marker and closeout adds zero fresh reviews.', [], [],
        { exerciseCloseoutRecovery: true }),
    row('initial-full', 'Every required lane starts in FULL exactly once.', [], []),
    row('test-small-test', 'Small test-only fix preserves all upstream lanes.', [repair('test', 'test')], ['test:DELTA']),
    row('test-small-source', 'A production fix reaches CODE and TEST, preserving unrelated reviews.',
        [repair('test', 'source')], ['code:DELTA', 'test:DELTA']),
    row('test-document', 'A real failed review cannot be satisfied by a docs-only DELTA.',
        [repair('test', 'document')], ['test:FULL']),
    row('test-new-test', 'A new test stays a test-only repair.', [repair('test', 'new-test')], ['test:DELTA']),
    row('test-new-source', 'Production scope expansion requires FULL.', [repair('test', 'new-source')], INITIAL),
    row('passed-delta-then-test', 'Accepted CODE/API DELTA survives a later TEST-only repair and refreshed validation.',
        [repair('api', 'source'), repair('test', 'test')], ['code:DELTA', 'api:DELTA', 'test:FULL', 'test:DELTA'],
        { launches: ['code:FULL', 'refactor:FULL', 'api:FULL', 'code:DELTA', 'api:DELTA', 'test:FULL', 'test:DELTA'] }),
    row('compile-interrupts-test-remediation', 'A compile interruption preserves accepted CODE/API DELTA and resumes the same TEST DELTA.',
        [repair('api', 'source'), repair('test', 'test')], [],
        { launches: ['code:FULL', 'refactor:FULL', 'api:FULL', 'code:DELTA', 'api:DELTA', 'test:FULL', 'test:DELTA'],
            interruptTestRemediationCompile: true }),
    row('source-then-two-test-repairs', 'Repeated test repairs preserve the same original accepted DELTA authority.',
        [repair('api', 'source'), repair('test', 'test'), repair('test', 'test', 1, 2)], [],
        { launches: ['code:FULL', 'refactor:FULL', 'api:FULL', 'code:DELTA', 'api:DELTA', 'test:FULL', 'test:DELTA', 'test:DELTA'] }),
    ...[49, 50, 51].map(lines => row('test-refactor-' + lines,
        'The test refactor boundary is >50 changed lines; equality preserves REFACTOR.', [repair('test', 'test', lines)],
        [...(lines > 50 ? ['refactor:DELTA'] : []), 'test:DELTA'])),
    ...[239, 240, 241].map(lines => row('source-line-limit-' + lines,
        'The DELTA line ceiling is inclusive at 240; exceeding it changes affected lanes to FULL and preserves unrelated lanes.', [repair('test', 'source', lines)],
        lines > 240 ? ['code:FULL', 'test:FULL'] : ['code:DELTA', 'test:DELTA'])),
    ...[3, 4, 5].map(files => row('source-file-limit-' + files,
        'The DELTA file ceiling is inclusive at four in-scope files; the affected-lane selection remains unchanged.', [repair('test', 'source', 1, 1, files)],
        files > 4 ? ['code:FULL', 'test:FULL'] : ['code:DELTA', 'test:DELTA'], { initialSourceFiles: 5 })),
    row('consecutive-delta-cap', 'After three consecutive DELTAs the next review is FULL, then DELTA is allowed again.',
        Array.from({ length: 5 }, (_, i) => repair('test', 'test', 1, i + 1)),
        ['test:DELTA', 'test:DELTA', 'test:DELTA', 'test:FULL', 'test:DELTA']),
    row('failed-review-blocks', 'A failed TEST blocks continuation without any additional reviewer launch.',
        [repair('test', 'test')], [], { stopOnFailure: true }),
    ...MATRIX_LANES.filter(lane => lane !== 'test').map(lane => {
        const lanes = MATRIX_LANES.filter(value => ['code', 'refactor', 'api', 'test', lane].includes(value));
        const at = lanes.indexOf(lane);
        return row('failed-' + lane + '-production', 'Only the failed owner and production-related lanes repeat.',
            [repair(lane, 'source')], [], { required: lanes.filter(value => !['code', 'test'].includes(value)),
                launches: [...lanes.slice(0, at + 1).map(value => value + ':FULL'),
                    ...[...new Set(['code', lane])].map(value => value + ':DELTA'),
                    ...lanes.slice(at + 1).map(value => value + ':FULL')] });
    }),
    ...(['independent', 'chain', 'fanout'] as const).flatMap(graph => [
        row('dependency-' + graph, 'An upstream production repair invalidates every accepted dependent and preserves independent lanes.',
            [repair('test', 'source')], graph === 'independent' ? ['code:DELTA', 'test:DELTA']
                : ['code:DELTA', 'refactor:DELTA', 'api:DELTA', 'test:DELTA'], { graph }),
        row('dependency-helper-' + graph, 'A middle-node repair distinguishes a chain from a fanout, with no new CODE review.',
            [repair('test', 'helper')], ['refactor:DELTA', ...(graph === 'chain' ? ['api:DELTA'] : []), 'test:DELTA'], { graph })
    ]),
    ...(['lost-receipt', 'corrupt-receipt', 'lost-report', 'corrupt-report', 'lost-context', 'corrupt-context'] as const)
        .map(evidenceFault => row('evidence-' + evidenceFault,
            'Derived context is rebuilt without a reviewer; lost authentic result evidence requires only its own fresh review.',
            [], evidenceFault.endsWith('context') ? [] : ['test:FULL'], { evidenceFault })),
    row('report-correction-same-reviewer', 'Invalid report is corrected by its original reviewer without a new launch.', [], [],
        { reportFault: 'broken' }),
    row('report-correction-unavailable-reviewer', 'If the original reviewer cannot be reached, only its lane gets a fresh launch.',
        [], ['test:FULL'], { reportFault: 'unreachable' })
];

export function matrixScenarioId(stack: string, rowId: string, mode: MatrixMode): string {
    return 'review-matrix-' + stack + '--' + rowId + '--' + mode;
}
export interface MatrixCell { id: string; stack: string; row: string; mode: MatrixMode }
export function commonReviewMatrixCells(): MatrixCell[] {
    return STACK_MANIFESTS.flatMap(stack => COMMON_REVIEW_MATRIX.flatMap(entry => MATRIX_MODES.map(mode =>
        ({ id: matrixScenarioId(stack.id, entry.id, mode), stack: stack.id, row: entry.id, mode }))));
}
/** Partitions distribute complete cells only. The final reducer still requires the entire Cartesian product. */
export function selectCommonReviewCells(cells: readonly MatrixCell[], shard: { index: number; total: number },
    partition: { index: number; total: number } = { index: 1, total: 1 }): MatrixCell[] {
    for (const [selection, maximum] of [[shard, 128], [partition, 24]] as const)
        if (!Number.isSafeInteger(selection.index) || !Number.isSafeInteger(selection.total) || selection.index < 1
            || selection.index > selection.total || selection.total > maximum)
            throw new Error('Invalid common review matrix shard/worker partition');
    return cells.filter((_cell, index) => index % shard.total === shard.index - 1)
        .filter((_cell, index) => index % partition.total === partition.index - 1);
}
export function matrixLaunchContract(row: ReviewMatrixRow): Pick<WalkScenario, 'expectedModes' | 'expectedReviews'> {
    return { expectedModes: [...row.launches], expectedReviews: Object.fromEntries([...new Set(row.launches.map(value => value.split(':')[0]))]
        .map(lane => [lane, row.launches.filter(value => value.startsWith(lane + ':')).length])) };
}
export interface MatrixCellResult { id: string; outcome: string; launches: string[]; findings: string[]; nativeSteps: number }
/** Completeness is independent of execution: missing, duplicate, foreign, partial or extra-launch cells refuse GREEN. */
export function reviewMatrixProblems(results: readonly MatrixCellResult[], expected = commonReviewMatrixCells()): string[] {
    const problems: string[] = [], seen = new Set<string>(), wanted = new Map(expected.map(cell => [cell.id, cell]));
    for (const result of results) {
        const cell = wanted.get(result.id);
        if (!cell) { problems.push('foreign-cell:' + result.id); continue; }
        if (seen.has(result.id)) problems.push('duplicate-cell:' + result.id);
        seen.add(result.id);
        const entry = COMMON_REVIEW_MATRIX.find(row => row.id === cell.row)!;
        if (result.outcome !== (entry.stopOnFailure ? 'blocked' : 'done')) problems.push('outcome:' + result.id);
        if (!Number.isSafeInteger(result.nativeSteps) || result.nativeSteps < 1) problems.push('missing-native-trace:' + result.id);
        if (JSON.stringify(result.launches) !== JSON.stringify(entry.launches)) problems.push('review-contract:' + result.id);
        for (const finding of result.findings) problems.push('native:' + result.id + ':' + finding);
    }
    for (const cell of expected) if (!seen.has(cell.id)) problems.push('missing-cell:' + cell.id);
    return problems;
}
