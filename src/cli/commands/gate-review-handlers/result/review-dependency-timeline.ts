import * as fs from 'node:fs';
import { readTaskTimelineJsonlEntries } from '../../../../gate-runtime/timeline/task-events-helpers';
import { rememberReviewTimelineSource } from '../../../../gates/review/review-artifact-recovery';
import {
    type ReviewDependencyTimelineEvent
} from '../../../../gates/review/review-dependencies';

export function readDependencyTimelineEvents(timelinePath: string, options?: { fromSnapshot: boolean }): ReviewDependencyTimelineEvent[] {
    if (!fs.existsSync(timelinePath) || !fs.statSync(timelinePath).isFile()) {
        return [];
    }
    const records: Array<Readonly<Record<string, unknown>> | null> = options?.fromSnapshot
        ? readTaskTimelineJsonlEntries(timelinePath).filter(entry => entry.rawLine.trim().length > 0).map(entry => entry.record)
        : fs.readFileSync(timelinePath, 'utf8').split('\n').filter(line => line.trim().length > 0).map(line => {
            try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; }
        });
    const events = records.flatMap((parsed, sequence) => {
            if (parsed === null) return [];
            try {
                const details = parsed.details && typeof parsed.details === 'object' && !Array.isArray(parsed.details)
                    ? parsed.details as Record<string, unknown>
                    : null;
                const rawIntegrity = parsed.integrity && typeof parsed.integrity === 'object' && !Array.isArray(parsed.integrity)
                    ? parsed.integrity as Record<string, unknown>
                    : null;
                const taskSequence = typeof rawIntegrity?.task_sequence === 'number'
                    ? rawIntegrity.task_sequence
                    : Number(rawIntegrity?.task_sequence);
                const eventSha256 = String(rawIntegrity?.event_sha256 || '').trim().toLowerCase();
                const prevEventSha256Raw = rawIntegrity?.prev_event_sha256;
                const prevEventSha256 = prevEventSha256Raw == null
                    ? null
                    : String(prevEventSha256Raw).trim().toLowerCase() || null;
                return [{
                    event_type: String(parsed.event_type || '').trim().toUpperCase(),
                    task_id: String(parsed.task_id || '').trim(),
                    actor: String(parsed.actor || '').trim(),
                    outcome: String(parsed.outcome || '').trim().toUpperCase(),
                    sequence,
                    details,
                    integrity: rawIntegrity
                        && Number.isInteger(taskSequence)
                        && taskSequence > 0
                        && /^[0-9a-f]{64}$/.test(eventSha256)
                        && (prevEventSha256 == null || /^[0-9a-f]{64}$/.test(prevEventSha256))
                        ? {
                            schema_version: typeof rawIntegrity.schema_version === 'number'
                                ? rawIntegrity.schema_version
                                : Number(rawIntegrity.schema_version) || 1,
                            task_sequence: taskSequence,
                            prev_event_sha256: prevEventSha256,
                            event_sha256: eventSha256
                        }
                        : null
                }];
            } catch {
                return [];
            }
        });
    rememberReviewTimelineSource(events, timelinePath);
    return events;
}
