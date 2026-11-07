import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { StandFinding } from '../../../../scripts/node-foundation/synthetic/model';
import type { WalkResult } from './navigator-walk';

export function walkHash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Readers see either the previous complete file or the new complete file, never a prefix. */
export function atomicWalkJson(file: string, value: unknown): void {
    atomicWalkText(file, JSON.stringify(value) + '\n');
}

export function atomicWalkText(file: string, value: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
    try {
        fs.writeFileSync(temporary, value, { flag: 'wx' });
        fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
}

export interface FinishedWalk { result: WalkResult; findings: StandFinding[] }
interface RecordFile extends FinishedWalk { version: number; runHash: string; digest: string }

/** A checksum catches syntactically valid truncation/editing as well as malformed JSON. */
export class WalkRunStore {
    constructor(readonly root: string, readonly runHash: string) {}
    private file(id: string): string { return path.join(this.root, 'scenarios', walkHash(id) + '.json'); }
    save(value: FinishedWalk): void {
        atomicWalkJson(this.file(value.result.scenarioId), { version: 1, runHash: this.runHash,
            ...value, digest: walkHash(value) });
    }
    read(id: string): FinishedWalk | undefined {
        try {
            const value = JSON.parse(fs.readFileSync(this.file(id), 'utf8')) as RecordFile;
            const result = value.result;
            if (value.version !== 1 || value.runHash !== this.runHash || result.scenarioId !== id
                || !['done', 'blocked', 'dead_end', 'loop', 'step_limit', 'agent_stuck', 'exception'].includes(result.outcome)
                || typeof result.detail !== 'string' || !Array.isArray(result.steps) || !Array.isArray(result.events)
                || !Array.isArray(result.reviews) || !result.reviewsByLane || !Array.isArray(value.findings)
                || value.digest !== walkHash({ result, findings: value.findings })) return undefined;
            return { result, findings: value.findings };
        } catch { return undefined; }
    }
    private familyFile(ids: string[]): string { return path.join(this.root, 'families', walkHash(ids) + '.json'); }
    finishFamily(ids: string[]): void {
        const records = ids.map(id => this.read(id));
        if (records.some(value => !value)) throw new Error('Cannot finish a family with missing results');
        atomicWalkJson(this.familyFile(ids), { runHash: this.runHash, digest: walkHash(records) });
    }
    readFamily(ids: string[]): FinishedWalk[] | undefined {
        try {
            const marker = JSON.parse(fs.readFileSync(this.familyFile(ids), 'utf8')) as { runHash: string; digest: string };
            const records = ids.map(id => this.read(id));
            return marker.runHash === this.runHash && records.every(value => value)
                && marker.digest === walkHash(records) ? records as FinishedWalk[] : undefined;
        } catch { return undefined; }
    }
    invalidate(ids: string[]): void {
        fs.rmSync(this.familyFile(ids), { force: true });
        for (const id of ids) fs.rmSync(this.file(id), { force: true });
    }
}

export function assertWalkResumeIdentity(previous: unknown, current: unknown): void {
    if (walkHash(previous) !== walkHash(current)) throw new Error('Synthetic walk resume refused: seed, level, provider, scenario manifest or run-inputs.json hash differs. Use identical stand and production inputs.');
}

export function walkProgress(records: FinishedWalk[], total: number, elapsedMs: number, completedThisRun: number) {
    const counts = { done: 0, blocked: 0, loop: 0, agent_stuck: 0, crash: 0 };
    for (const { result } of records) {
        if (result.outcome in counts) counts[result.outcome as keyof typeof counts]++;
        else counts.crash++;
    }
    return { partial: records.length < total, finished: records.length, total, counts, elapsedMs,
        etaMs: completedThisRun ? Math.round(elapsedMs / completedThisRun * (total - records.length)) : null };
}
