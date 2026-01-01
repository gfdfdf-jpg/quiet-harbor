import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseTaskMdTableRow, replaceTaskMdTableCell } from '../../../../src/core/task-md-table';
import { inspectParentCompletion } from '../../../../src/gates/parent-audit/parent-audit-state';
import { readParentEvents } from '../../../../src/gates/parent-audit/parent-audit-auth';
import { completeRestoredParentAcceptance } from '../../../../src/gates/parent-audit/parent-audit-restored-completion';
import { buildTaskAuditSummary } from '../../../../src/gates/task-audit/task-audit-summary';
import { readNativeChildSourceAcceptance } from '../../../../src/gates/task-audit/task-audit-summary-decomposed-parent-proofs';

/** Fault controls on the actual restored native repair tree, before parent implementation.
 * No PASS artifacts, receipts or gate outcomes are fabricated. Restore only each control's
 * exact temporary-fixture bytes, then let the ordinary parent lifecycle run to completion. */
export function assertRestoredParentPhaseGuards(root: string, taskId: string): void {
    const initial = inspectParentCompletion(root, taskId)!;
    assert.equal(initial.implementationPending, true, 'authenticated restored WIP must resume its own implementation');
    assert.equal(initial.ready, false, 'implementation readiness is never aggregate acceptance');
    assert.equal(initial.childSources.length, 2, 'both native child SOURCE proofs must be qualified');
    const ownAudit = buildTaskAuditSummary({ repoRoot: root, taskId });
    assert.notEqual(ownAudit.scope_category, 'decomposed-parent');
    assert.ok(ownAudit.gates.some(gate => gate.gate === 'classify-change'));
    assert.notEqual(ownAudit.status, 'PASS', 'the restored parent has not passed its own current cycle');
    assert.throws(() => readNativeChildSourceAcceptance(root, taskId), /SOURCE|source|acceptance/u);

    const blocked = () => {
        const inspection = inspectParentCompletion(root, taskId)!;
        assert.notEqual(inspection.implementationPending, true, 'invalid prerequisites cannot resume implementation');
        assert.equal(inspection.ready, false);
        assert.ok(inspection.violations.length > 0);
        assert.equal(buildTaskAuditSummary({ repoRoot: root, taskId }).status, 'BLOCKED');
    };
    const changed = (file: string, bytes: Buffer, check: () => void) => {
        const original = fs.readFileSync(file);
        try { fs.writeFileSync(file, bytes); check(); }
        finally { fs.writeFileSync(file, original); }
        assert.equal(inspectParentCompletion(root, taskId)!.implementationPending, true,
            'restored original bytes must qualify again without cached failure or success');
    };
    const events = readParentEvents(root, taskId);
    const restore = [...events].reverse().find(event => event.event_type === 'FULL_SUITE_REPAIR_WIP_RESTORED')!;
    const details = restore.details as { manifest_path: string };
    const manifestPath = path.resolve(root, details.manifest_path);
    changed(manifestPath, Buffer.concat([fs.readFileSync(manifestPath), Buffer.from(' ')]), blocked);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { patches: { unstaged: { path: string } } };
    const patchPath = path.resolve(root, manifest.patches.unstaged.path);
    changed(patchPath, Buffer.concat([fs.readFileSync(patchPath), Buffer.from('tampered archive\n')]), blocked);
    const child = initial.childSources[0];
    const sourcePath = path.resolve(root, child.artifactPath);
    changed(sourcePath, Buffer.concat([fs.readFileSync(sourcePath), Buffer.from(' ')]), blocked);

    const queuePath = path.join(root, 'TASK.md'), queue = fs.readFileSync(queuePath, 'utf8');
    const withStatus = (id: string, status: string) => {
        let matched = false;
        const rows = queue.split('\n').map(line => {
            if (parseTaskMdTableRow(line)[0]?.trimmed !== id) return line;
            matched = true;
            return replaceTaskMdTableCell(line, 1, ` ${status} `)!;
        });
        assert.ok(matched, 'control must change the exact fixture task row');
        return Buffer.from(rows.join('\n'));
    };
    changed(queuePath, withStatus(child.taskId, 'TODO'), blocked);
    changed(queuePath, withStatus(taskId, 'DONE'), () => {
        assert.equal(inspectParentCompletion(root, taskId)!.ready, false, 'handwritten DONE is not aggregate acceptance');
        assert.notEqual(buildTaskAuditSummary({ repoRoot: root, taskId }).status, 'PASS', 'own completion is still required');
        assert.throws(() => completeRestoredParentAcceptance(root, taskId), /requires accepted native parent SOURCE/u);
        assert.equal(readParentEvents(root, taskId).some(event => event.event_type === 'DECOMPOSED_PARENT_COMPLETED'), false);
    });
}
