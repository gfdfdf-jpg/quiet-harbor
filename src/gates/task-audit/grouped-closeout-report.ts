import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { isPlainRecord } from '../../core/records';
import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import type { TaskAuditSummaryResult } from './task-audit-summary';
import { formatFinalCloseoutMarkdown, formatFinalUserReport } from './task-audit-summary-renderers';

type FinalCloseout = TaskAuditSummaryResult['final_closeout'];

export function readGroupedCloseoutReport(
    reviewsRoot: string, taskId: string, completionEventSha256: string, expected?: FinalCloseout
) {
    const read = (suffix: string) => fs.readFileSync(path.join(reviewsRoot, taskId + suffix));
    const json = read('-final-closeout.json');
    const markdown = read('-final-closeout.md');
    const report = read('-final-user-report.md');
    if (expected && (!json.equals(Buffer.from(JSON.stringify(expected, null, 2) + '\n'))
        || !markdown.equals(Buffer.from(formatFinalCloseoutMarkdown(expected) + '\n'))
        || !report.equals(Buffer.from(formatFinalUserReport(expected) + '\n')))) {
        throw new Error('Grouped closeout files differ from the canonical rendered report.');
    }
    const artifact: unknown = JSON.parse(json.toString('utf8'));
    if (!isPlainRecord(artifact) || artifact.task_id !== taskId || artifact.status !== 'READY'
        || artifact.artifact_state !== 'MATERIALIZED') {
        throw new Error('Grouped closeout report is not materialized for the current task.');
    }
    const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    return {
        artifact: artifact as unknown as FinalCloseout,
        binding: {
            completion_event_sha256: completionEventSha256,
            closeout_sha256: sha256(json),
            markdown_sha256: sha256(markdown),
            user_report_sha256: sha256(report)
        }
    };
}

export function readCommittedGroupedCloseoutReport(
    reviewsRoot: string, timelinePath: string, taskId: string, completionEventSha256: string
) {
    const report = readGroupedCloseoutReport(reviewsRoot, taskId, completionEventSha256);
    let matches = false;
    const inspection = inspectTaskEventFile(timelinePath, taskId, { onIntegrityEvent(event) {
        if (event.event_type !== 'STATUS_CHANGED') return;
        const details = isPlainRecord(event.details) ? event.details : null;
        const binding = isPlainRecord(details?.grouped_closeout) ? details.grouped_closeout : null;
        matches = event.actor === 'orchestrator' && event.outcome === 'INFO' && details?.new_status === 'DONE'
            && Object.entries(report.binding).every(([key, value]) => binding?.[key] === value);
    } });
    if (!matches || inspection.violations.length) {
        throw new Error('The terminal status event does not authenticate the grouped closeout report.');
    }
    return report;
}
