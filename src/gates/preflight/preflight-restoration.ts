import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readValidationFile } from '../../core/project-validation-identity';
import { isPlainRecord } from '../../core/records';
import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import { normalizePath } from '../shared/helpers';

const MAX_PREFLIGHT_BYTES = 1024 * 1024;

export interface LostPreflightSnapshot {
    sha256: string;
    text: string | null;
    payload: Record<string, unknown>;
    classifiedForecast?: unknown;
}

/** An older task may reconstruct its exact bytes if an authenticated compile bound their hash. */
export function restoredPreflightText(snapshot: LostPreflightSnapshot, current: unknown): string | null {
    if (!isPlainRecord(current)) return null;
    if (snapshot.text !== null) {
        return equivalentPreflightClassification(snapshot.payload, current) ? snapshot.text : null;
    }
    const candidate = JSON.parse(JSON.stringify(current)) as Record<string, unknown>;
    if (isPlainRecord(candidate.budget_forecast) && isPlainRecord(snapshot.classifiedForecast)
        && typeof snapshot.classifiedForecast.timestamp_utc === 'string') {
        candidate.budget_forecast.timestamp_utc = snapshot.classifiedForecast.timestamp_utc;
    }
    const text = `${JSON.stringify(candidate, null, 2)}\n`;
    return createHash('sha256').update(text, 'utf8').digest('hex') === snapshot.sha256 ? text : null;
}

export function preflightSnapshotPath(preflightPath: string): string {
    return path.join(path.dirname(preflightPath), `${path.basename(preflightPath, '.json')}-snapshot.json`);
}

/** The forecast's clock is observational; every classification and scope fact must still match. */
export function equivalentPreflightClassification(previous: Record<string, unknown>, current: unknown): boolean {
    if (!isPlainRecord(current)) return false;
    const comparable = (value: Record<string, unknown>): Record<string, unknown> => {
        const copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
        if (isPlainRecord(copy.budget_forecast)) delete copy.budget_forecast.timestamp_utc;
        return copy;
    };
    return isDeepStrictEqual(comparable(previous), comparable(current));
}

/** Read retained bytes or a compile-bound reconstruction candidate from authenticated task history. */
export function readLostPreflightSnapshot(repoRoot: string, taskId: string, preflightPath: string,
    allowCurrent = false): LostPreflightSnapshot | null {
    const relative = path.relative(repoRoot, preflightPath).replace(/\\/gu, '/');
    if (relative.startsWith('../') || path.isAbsolute(relative)
        || path.basename(preflightPath) !== `${taskId}-preflight.json`) return null;
    let latest: Readonly<Record<string, unknown>> | null = null;
    let latestCompile: Readonly<Record<string, unknown>> | null = null;
    const timelinePath = path.join(path.dirname(preflightPath), '..', 'task-events', `${taskId}.jsonl`);
    const inspection = inspectTaskEventFile(timelinePath, taskId, { onIntegrityEvent: event => {
        if (['TASK_MODE_ENTERED', 'TASK_RESET', 'TASK_DISCARDED', 'PREFLIGHT_STARTED', 'PREFLIGHT_FAILED'].includes(String(event.event_type))) {
            latest = null; latestCompile = null;
        } else if (event.event_type === 'PREFLIGHT_CLASSIFIED') {
            latest = event; latestCompile = null;
        } else if (latest && ['COMPILE_GATE_PASSED', 'COMPILE_GATE_FAILED', 'COMPILE_GATE_REFUSED'].includes(String(event.event_type))) {
            latestCompile = event;
        }
    } });
    const event = latest as Readonly<Record<string, unknown>> | null;
    const details = isPlainRecord(event?.details) ? event.details : null;
    const compile = latestCompile as Readonly<Record<string, unknown>> | null;
    const compileDetails = isPlainRecord(compile?.details) ? compile.details : null;
    const classifiedSha256 = String(details?.output_sha256 || '').trim().toLowerCase();
    const compileSha256 = compile?.event_type === 'COMPILE_GATE_PASSED' && compile.outcome === 'PASS'
        && normalizePath(compileDetails?.preflight_path) === normalizePath(preflightPath)
        ? String(compileDetails?.preflight_hash_sha256 || '').trim().toLowerCase() : '';
    const sha256 = /^[a-f0-9]{64}$/u.test(classifiedSha256) ? classifiedSha256 : compileSha256;
    if (inspection.status !== 'PASS' || !/^[a-f0-9]{64}$/u.test(sha256)
        || normalizePath(details?.output_path) !== normalizePath(preflightPath)) return null;
    try {
        const current = readValidationFile(repoRoot, relative, MAX_PREFLIGHT_BYTES);
        if (!allowCurrent && current.identity.sha256 === sha256) return null;
    } catch (error) {
        // Missing is recoverable; an unsafe existing path must retain its ordinary refusal.
        try { fs.lstatSync(preflightPath); return null; }
        catch (statError) { if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') return null; }
        void error;
    }
    const snapshotPath = preflightSnapshotPath(preflightPath);
    try {
        const snapshot = readValidationFile(repoRoot, path.relative(repoRoot, snapshotPath).replace(/\\/gu, '/'), MAX_PREFLIGHT_BYTES);
        if (snapshot.identity.sha256 !== sha256) return null;
        const text = snapshot.bytes.toString('utf8');
        const payload: unknown = JSON.parse(text);
        if (!isPlainRecord(payload) || payload.task_id !== taskId) return null;
        return { sha256, text, payload };
    } catch {
        // Never bypass a present but untrusted snapshot. For older tasks with no snapshot,
        // a verified compile event can authenticate an exact reconstruction instead.
        try { fs.lstatSync(snapshotPath); return null; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null; }
        if (!compileDetails || compileSha256 !== sha256) return null;
        return {
            sha256,
            text: null,
            payload: {
                task_id: taskId,
                detection_source: compileDetails.preflight_detection_source || compileDetails.scope_detection_source,
                authorized_files: compileDetails.scope_authorized_files,
                changed_files: compileDetails.scope_changed_files
            },
            classifiedForecast: details?.budget_forecast
        };
    }
}
