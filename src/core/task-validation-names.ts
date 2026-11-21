import { isDeepStrictEqual } from 'node:util';

/** Display/CLI names change; authenticated gate, event and artifact IDs do not. */
export function taskValidationGateName(name: string): string {
    return name === 'task-test-validation' ? 'full-suite-validation' : name;
}

/** Normalize at the input boundary without rewriting stored configuration/history. */
export function normalizeTaskValidationConfigNames(raw: Record<string, unknown>): Record<string, unknown> {
    if (raw.task_test_validation === undefined) return raw;
    if (raw.full_suite_validation !== undefined && !isDeepStrictEqual(raw.full_suite_validation, raw.task_test_validation)) {
        throw new Error('Conflicting task_test_validation and full_suite_validation aliases. Keep one validation section, then retry.');
    }
    const { task_test_validation, ...rest } = raw;
    return { ...rest, full_suite_validation: task_test_validation };
}
