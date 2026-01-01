import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withInvocationReadObservation } from '../../../../src/core/invocation-read-observation';
import { readTaskQueueEntries } from '../../../../src/core/task-queue-read';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../../src/core/next-step-measurement';
import { readNativeDecomposedParentFacts } from '../../../../src/gates/task-audit/task-audit-summary-lifecycle';
import { readNativeParentObligationProofs, withNativeParentReadScope } from '../../../../src/gates/task-audit/task-audit-summary-parent-obligation-proofs';

const taskId = 'T-READ-PARENT';
function fixture(t: TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-parent-read-cost-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const queue = path.join(root, 'TASK.md');
    fs.writeFileSync(queue, [
        '## Active Queue', '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        `| ${taskId} | IN_PROGRESS | P1 | audit | Leaf | test | 2026-10-16 | balanced | ordinary leaf |`, ''
    ].join('\n'));
    return { root, queue };
}

function measure(action: () => void): NextStepMeasurement {
    let result: NextStepMeasurement | undefined;
    withNextStepMeasurement(action, value => { result = value; });
    return result!;
}

test('entry and ordinary parent audit share one verified queue payload', t => {
    const { root, queue } = fixture(t);
    const measurement = measure(() => withInvocationReadObservation(() => {
        assert.ok(readTaskQueueEntries(root).has(taskId));
        assert.equal(readNativeParentObligationProofs(root, taskId), null);
    }));
    assert.equal(measurement.work['payload_read:' + queue], 1);
    assert.throws(() => withInvocationReadObservation(() => {
        readTaskQueueEntries(root);
        assert.equal(readNativeParentObligationProofs(root, taskId), null);
        const replacement = queue + '.replacement';
        fs.writeFileSync(replacement, fs.readFileSync(queue));
        fs.renameSync(replacement, queue);
    }), /Invocation file observation changed/u);
});

test('nested read scope shares the queue but keeps both live qualification checkpoints', t => {
    const { root, queue } = fixture(t);
    const measurement = measure(() => withNativeParentReadScope(root, taskId, () => {
        for (let index = 0; index < 6; index++) assert.equal(readNativeDecomposedParentFacts(root, taskId), null);
        return true;
    }, Boolean));
    assert.equal(measurement.work['payload_read:' + queue], 3, 'one capture and two live checkpoints');
    assert.throws(() => withNativeParentReadScope(root, taskId, scope => {
        assert.equal(readNativeDecomposedParentFacts(root, taskId), null);
        scope.proofRechecks.push(() => fs.writeFileSync(queue, 'changed queue'));
        return true;
    }, Boolean), /Original parent inputs changed/u);
});

test('shared invocation bytes do not bypass transaction hard-link authority', t => {
    const { root, queue } = fixture(t), alias = path.join(root, 'queue-copy.md');
    assert.throws(() => withInvocationReadObservation(() => {
        readTaskQueueEntries(root);
        fs.linkSync(queue, alias);
        readNativeParentObligationProofs(root, taskId);
    }), /Unsafe transaction path/u);
});
