import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { observeStandOracle } from './stand-check-observation';
import type { StandFinding } from '../../../../scripts/node-foundation/synthetic/model';
import type { WalkResult } from './navigator-walk';

const JSON_CHUNK = 1 << 20;

function jsonValue(key: string, value: unknown): unknown {
    return value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function'
        ? (value as { toJSON(key: string): unknown }).toJSON(key) : value;
}

/** Native serialization of a subtree, or RangeError's signal that it does not fit in one string. */
function streamJsonValue(value: unknown, emit: (text: string) => void): boolean {
    try {
        const text = JSON.stringify(value);
        if (text === undefined) return false;
        emit(text); return true;
    } catch (error) {
        if (!(error instanceof RangeError) || value === null || typeof value !== 'object') throw error;
    }
    if (Array.isArray(value)) {
        emit('[');
        for (let index = 0; index < value.length; index++) {
            if (index) emit(',');
            if (!streamJsonValue(jsonValue(String(index), value[index]), emit)) emit('null');
        }
        emit(']'); return true;
    }
    emit('{');
    let first = true;
    for (const key of Object.keys(value)) {
        const item = jsonValue(key, (value as Record<string, unknown>)[key]);
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
        emit((first ? '' : ',') + JSON.stringify(key) + ':');
        first = false;
        streamJsonValue(item, emit);
    }
    emit('}'); return true;
}

/**
 * Emits exactly the bytes of JSON.stringify(value) in pieces. Subtrees that fit are serialized natively; a container
 * whose text exceeds the engine's string limit is written member by member. Pieces end on token boundaries, so no
 * surrogate pair is split between two UTF-8 encodings.
 */
export function streamWalkJson(value: unknown, sink: (chunk: string) => void): void {
    let buffer = '';
    const emit = (text: string) => {
        if (buffer.length + text.length <= JSON_CHUNK) { buffer += text; return; }
        if (buffer) sink(buffer);
        buffer = '';
        if (text.length > JSON_CHUNK) sink(text); else buffer = text;
    };
    if (!streamJsonValue(jsonValue('', value), emit)) throw new Error('Value has no JSON representation');
    if (buffer) sink(buffer);
}

/** sha256 of JSON.stringify(value), without requiring that text to fit in one string. */
export function walkHash(value: unknown): string {
    const hash = createHash('sha256');
    streamWalkJson(value, chunk => hash.update(chunk, 'utf8'));
    return hash.digest('hex');
}

/** Preserve atomic replacement under a short Windows sharing conflict. Never
 * unlink the destination or swallow a permanent write failure. The same bounded
 * delays as the production atomic writer apply; JSON stays streamed. */
function replaceWalkArtifact(temporary: string, file: string): void {
    const delays = [10, 25, 50, 100];
    for (let attempt = 0; ; attempt++) {
        try { fs.renameSync(temporary, file); return; }
        catch (error: unknown) {
            const code = String((error as NodeJS.ErrnoException | undefined)?.code || '');
            if (!['EACCES', 'EBUSY', 'EPERM'].includes(code) || attempt >= delays.length) throw error;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delays[attempt]);
        }
    }
}

/** Readers see either the previous complete file or the new complete file, never a prefix. Bytes equal JSON.stringify. */
export function atomicWalkJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
    try {
        const descriptor = fs.openSync(temporary, 'wx');
        try {
            const write = (chunk: string) => { const bytes = Buffer.from(chunk, 'utf8'); for (let offset = 0; offset < bytes.length;)
                offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset); };
            streamWalkJson(value, write); write('\n');
        } finally { fs.closeSync(descriptor); }
        replaceWalkArtifact(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
}

export function atomicWalkText(file: string, value: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
    try {
        fs.writeFileSync(temporary, value, { flag: 'wx' });
        replaceWalkArtifact(temporary, file);
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
        return this.readSealed(id)?.record;
    }
    /** The verified record and its content digest (independent of the run hash, so it survives a merge). */
    readSealed(id: string): { record: FinishedWalk; digest: string } | undefined {
        try {
            const value = JSON.parse(fs.readFileSync(this.file(id), 'utf8')) as RecordFile;
            const result = value.result;
            if (value.version !== 1 || value.runHash !== this.runHash || result.scenarioId !== id
                || !['done', 'blocked', 'dead_end', 'loop', 'step_limit', 'agent_stuck', 'exception'].includes(result.outcome)
                || typeof result.detail !== 'string' || !Array.isArray(result.steps) || !Array.isArray(result.events)
                || !Array.isArray(result.reviews) || !result.reviewsByLane || !Array.isArray(value.findings)
                || value.digest !== walkHash({ result, findings: value.findings })) return undefined;
            return { record: { result, findings: value.findings }, digest: value.digest };
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

/**
 * `results.json`: the ordered record identities and content digests, never a second copy of the records. Scenario
 * records already sit beside it in `scenarios/` with their own checksums; one copy of every result in a single JSON
 * text exceeds the engine's string limit on a full shard.
 */
export interface WalkResultIndex { schema: 2; records: Array<{ id: string; digest: string }>; findings: StandFinding[]; executionFindings?: StandFinding[] }
export function walkResultIndex(store: WalkRunStore, ids: readonly string[], findings: StandFinding[], executionFindings?: StandFinding[]): WalkResultIndex {
    const records = ids.map(id => {
        const sealed = store.readSealed(id);
        if (!sealed) throw new Error('Walk result has no verified scenario record: ' + id);
        return { id, digest: sealed.digest };
    });
    return { schema: 2, records, findings, ...executionFindings ? { executionFindings } : {} };
}
export function readWalkResultIndex(file: string): WalkResultIndex {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as WalkResultIndex;
    if (value?.schema !== 2 || !Array.isArray(value.records) || !Array.isArray(value.findings)
        || value.records.some(entry => typeof entry?.id !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.digest ?? ''))
        || value.executionFindings !== undefined && !Array.isArray(value.executionFindings)) throw new Error('Unsupported or malformed walk result index: ' + file);
    return value;
}

export function assertWalkResumeIdentity(previous: unknown, current: unknown): void {
    observeStandOracle('resume-identity');
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
