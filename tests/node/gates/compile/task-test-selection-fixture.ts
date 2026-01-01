import { mock, type TestContext, type SuiteContext } from 'node:test';
import * as selection from '../../../../src/cli/commands/workflow/workflow-command-task-test-selection';

/** Isolate execution/lifecycle fixtures from task admission, covered by the native workflow selection suite. */
export function withCurrentTaskTestSelectionFixture(context: TestContext | SuiteContext): void {
    const reader = mock.method(selection, 'readTaskTestSelection', () => ({ status: 'current' as const, command: null, targets: [] }));
    (context as TestContext).after(() => reader.mock.restore());
}
