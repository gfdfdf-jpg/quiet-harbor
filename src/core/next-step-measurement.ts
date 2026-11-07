import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { types } from 'node:util';

export interface NextStepCpuMilliseconds { user: number; system: number }
export interface NextStepBoundaryTiming { count: number; total_ms: number; max_ms: number; throws: number }
export interface NextStepMeasurement {
    phases_ms: Record<string, number>;
    work: Record<string, number>;
    cpu_ms?: Record<string, NextStepCpuMilliseconds>;
    io?: Record<string, NextStepBoundaryTiming>;
    subprocesses?: Record<string, NextStepBoundaryTiming>;
    runtime?: {
        diagnostics_version: 2; node_version: string; platform: string; arch: string; pid: number;
        started_utc: string; phase_timings: 'inclusive'; cpu_scope: 'parent_process';
        rss_before_bytes?: number; rss_after_bytes?: number;
    };
}
let active: NextStepMeasurement | null = null;
let timelineByteNormalizer: ((content: Buffer) => number) | undefined;

export function countNextStepWork(name: string, amount = 1): void {
    if (active) active.work[name] = (active.work[name] || 0) + amount;
}

/** Keep raw I/O bytes, with an optional separate budget projection for controlled fixtures. */
export function countNextStepTimelineBytes(content: Buffer): void {
    if (!active) return;
    countNextStepWork('timeline_bytes', content.length);
    if (!timelineByteNormalizer) return;
    try {
        // Do not let diagnostics modify the authenticated bytes used by navigation.
        const normalized = timelineByteNormalizer(Buffer.from(content));
        if (!Number.isSafeInteger(normalized) || normalized < 0) throw new Error('Invalid normalized byte count');
        countNextStepWork('timeline_bytes_normalized', normalized);
    } catch {
        countNextStepWork('timeline_bytes_normalization_failed');
    }
}

/** Count actual array-copy results without touching caller getters or proxy traps. */
export function countNextStepArrayCopy<T>(name: string, value: T): T {
    if (active) {
        if (types.isProxy(value)) countNextStepWork('array_copy_measurement_opaque');
        else if (Array.isArray(value)) {
            const length = Object.getOwnPropertyDescriptor(value, 'length');
            if (length && 'value' in length && typeof length.value === 'number') countNextStepWork(name, length.value);
        }
    }
    return value;
}

function readCpuUsage(): NodeJS.CpuUsage | null {
    try { return process.cpuUsage(); } catch { countNextStepWork('cpu_measurement_unavailable'); return null; }
}
function readResidentBytes(): number | undefined {
    try { return process.memoryUsage().rss; } catch { return undefined; }
}

export function measureNextStepPhase<T>(name: string, action: () => T): T {
    if (!active) return action();
    const measurement = active;
    const started = performance.now(), cpuStarted = readCpuUsage();
    countNextStepWork(name);
    try { return action(); } finally {
        measurement.phases_ms[name] = (measurement.phases_ms[name] || 0) + performance.now() - started;
        const cpuEnded = readCpuUsage();
        if (cpuStarted && cpuEnded) {
            const user = (cpuEnded.user - cpuStarted.user) / 1000, system = (cpuEnded.system - cpuStarted.system) / 1000;
            if (Number.isFinite(user) && Number.isFinite(system) && user >= 0 && system >= 0) {
                const phases = measurement.cpu_ms ??= {}, prior = phases[name] ?? { user: 0, system: 0 };
                phases[name] = { user: prior.user + user, system: prior.system + system };
            }
        }
    }
}

// Aggregate elapsed API-boundary costs without sampling CPU for every filesystem call.
// These inclusive timings overlap (for example readFileSync may call openSync).
function measureBoundary<T>(kind: 'io' | 'subprocesses', name: string, action: () => T): T {
    if (!active) return action();
    const measurement = active, started = performance.now();
    let failed = false;
    try { return action(); } catch (error) { failed = true; throw error; } finally {
        const elapsed = performance.now() - started;
        const timings = measurement[kind] ??= {};
        const row = timings[name] ??= { count: 0, total_ms: 0, max_ms: 0, throws: 0 };
        row.count += 1; row.total_ms += elapsed; row.max_ms = Math.max(row.max_ms, elapsed);
        if (failed) row.throws += 1;
    }
}

// Serialize data descriptors only. Diagnostics must not execute caller-controlled
// getters, proxy traps or toJSON hooks. Opaque metadata is never evidence of equality.
export function describeProcessInputs(inputs: unknown, visit?: (kind: 'value' | 'field') => void): { text: string; opaque: boolean } {
    let opaque = false, remaining = 10_000;
    const ancestors = new Set<object>();
    const unknown = () => { opaque = true; return 'opaque'; };
    const encode = (value: unknown, depth: number): string => {
        visit?.('value');
        if (depth > 32 || --remaining < 0) return unknown();
        if (value === null) return 'null';
        if (typeof value === 'string') return JSON.stringify(value);
        if (typeof value === 'number') return Object.is(value, -0) ? 'number:-0' : 'number:' + String(value);
        if (typeof value === 'boolean') return value ? 'true' : 'false';
        if (typeof value === 'undefined') return 'undefined';
        if (typeof value === 'bigint') return 'bigint:' + value.toString();
        if (typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) return unknown();
        const prototype = Object.getPrototypeOf(value);
        // process.env has a Node-owned prototype. Its own descriptors contain its values.
        if (value !== process.env && prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null)
            return unknown();
        if (Object.getOwnPropertySymbols(value).length > 0) opaque = true;
        ancestors.add(value);
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const fields = Object.keys(descriptors).map(key => {
            visit?.('field');
            const descriptor = descriptors[key];
            return JSON.stringify(key) + ':enumerable=' + String(descriptor.enumerable) + ':'
                + ('value' in descriptor ? encode(descriptor.value, depth + 1) : unknown());
        });
        ancestors.delete(value);
        return (Array.isArray(value) ? 'array:' : 'object:') + '{' + fields.join(',') + '}';
    };
    const text = encode(inputs, 0);
    return { text, opaque };
}

// Fixed labels keep shell strings, arguments and environment values out of timing keys.
function processDiagnosticLabel(api: string, command: unknown): string {
    if (api === 'execSync') return 'shell';
    const name = typeof command === 'string' ? path.basename(command).toLowerCase() : '';
    return /^(?:git|node|icacls|cmd|powershell|pwsh|bash|sh|wsl)(?:\.exe)?$/u.test(name) ? name : 'other';
}

// Capture the synchronous Node boundary, including callers that bypass our Git helper.
// Navigation is synchronous; restore every function before returning or throwing.
function captureProcessWork(): () => void {
    type ProcessApi = Record<string, (...args: unknown[]) => unknown>;
    // The CommonJS builtin object is mutable; TS namespace views themselves are not.
    const native = require('node:child_process') as ProcessApi;
    const originals = new Map<string, (...args: unknown[]) => unknown>();
    const restore = () => {
        for (const [name, original] of originals) {
            try { native[name] = original; } catch { countNextStepWork('process_measurement_unavailable'); }
        }
    };
    try {
        for (const name of ['spawnSync', 'execFileSync', 'execSync']) {
            const original = native[name]; originals.set(name, original);
            native[name] = function (this: unknown, ...args: unknown[]): unknown {
                const command = processDiagnosticLabel(name, args[0]);
                let processKey = 'process:' + name + ':' + command + ':metadata-unavailable';
                try {
                    const metadata = describeProcessInputs({ args, cwd: process.cwd(), environment: process.env });
                    const digest = createHash('sha256').update(metadata.text).digest('hex');
                    if (metadata.opaque) {
                        countNextStepWork('process_metadata_opaque');
                        // Do not merge unknown inputs into a false identical-command bucket.
                        processKey = 'process:' + name + ':' + command + ':opaque:' + active?.work.process_metadata_opaque;
                        countNextStepWork(processKey);
                    } else {
                        processKey = 'process:' + name + ':' + command + ':' + digest;
                        countNextStepWork(processKey);
                    }
                } catch { countNextStepWork('process_measurement_unavailable'); }
                // A call stopped by its own timeout is a load observation, not work: its caller's bounded retry
                // runs the same command again. Count it separately so diagnostics can tell the two apart.
                const countTimeout = (error: unknown) => {
                    if ((error as { code?: unknown } | null)?.code === 'ETIMEDOUT') countNextStepWork('subprocess_timeout:' + command);
                };
                return measureNextStepPhase('subprocess.' + name + '.' + command, () =>
                    measureBoundary('subprocesses', processKey, () => {
                        let result: unknown;
                        try { result = Reflect.apply(original, this, args); } catch (error) { countTimeout(error); throw error; }
                        if (name === 'spawnSync') countTimeout((result as { error?: unknown } | null)?.error);
                        return result;
                    }));
            };
        }
    } catch { restore(); countNextStepWork('process_measurement_unavailable'); }
    return restore;
}

// Observe raw readers as well as canonical snapshots, so diagnostics expose bypasses.
function capturePayloadWork(): () => void {
    type Api = Record<string, (...args: unknown[]) => unknown>;
    const native = require('node:fs') as Api;
    const json = JSON as unknown as Api;
    const originals: Array<{ api: Api; name: string; original: (...args: unknown[]) => unknown }> = [];
    const descriptors = new Map<number, { path: string; observed: boolean }>();
    let wholeFileDepth = 0;
    const fileName = (value: unknown): string | null => typeof value === 'string' ? path.resolve(value)
        : typeof value === 'number' ? descriptors.get(value)?.path || null : null;
    const wrap = (api: Api, name: string, invoke: (original: (...args: unknown[]) => unknown, self: unknown, args: unknown[]) => unknown, label = name) => {
        const original = api[name]; originals.push({ api, name, original });
        const wrapper = function (this: unknown, ...args: unknown[]) {
            return measureBoundary('io', label, () => invoke(original, this, args));
        };
        // Preserve the public native entrypoint on the callable JS realpath wrapper.
        if (name === 'realpathSync') {
            const descriptor = Object.getOwnPropertyDescriptor(original, 'native');
            if (descriptor) Object.defineProperty(wrapper, 'native', descriptor);
        }
        api[name] = wrapper;
    };
    const restore = () => {
        for (const { api, name, original } of [...originals].reverse()) {
            try { if (api[name] !== original) api[name] = original; }
            catch { countNextStepWork('payload_measurement_unavailable'); }
        }
    };
    try {
        const call = (original: (...args: unknown[]) => unknown, self: unknown, args: unknown[]) => Reflect.apply(original, self, args);
        for (const name of ['lstatSync', 'statSync', 'fstatSync', 'existsSync', 'readdirSync', 'readlinkSync', 'realpathSync'])
            wrap(native, name, call);
        wrap(native.realpathSync as unknown as Api, 'native', call, 'realpathSync.native');
        wrap(native, 'openSync', (original, self, args) => {
            const result = Reflect.apply(original, self, args);
            if (typeof result === 'number' && typeof args[0] === 'string')
                descriptors.set(result, { path: path.resolve(args[0]), observed: false });
            return result;
        });
        wrap(native, 'closeSync', (original, self, args) => {
            try { return Reflect.apply(original, self, args); }
            finally { if (typeof args[0] === 'number') descriptors.delete(args[0]); }
        });
        wrap(native, 'readSync', (original, self, args) => {
            const result = Reflect.apply(original, self, args);
            const descriptor = typeof args[0] === 'number' ? descriptors.get(args[0]) : undefined;
            if (!wholeFileDepth && descriptor && typeof result === 'number' && result >= 0 && !descriptor.observed) {
                countNextStepWork('payload_read:' + descriptor.path); descriptor.observed = true;
            }
            return result;
        });
        wrap(native, 'readFileSync', (original, self, args) => {
            const name = fileName(args[0]);
            wholeFileDepth += 1;
            try {
                const result = Reflect.apply(original, self, args);
                if (name) countNextStepWork('payload_read:' + name);
                else countNextStepWork('payload_read:opaque');
                return result;
            } finally { wholeFileDepth -= 1; }
        });
        wrap(json, 'parse', (original, self, args) => {
            countNextStepWork('json_parse_total');
            return Reflect.apply(original, self, args);
        }, 'JSON.parse');
    } catch { restore(); countNextStepWork('payload_measurement_unavailable'); }
    return restore;
}

export function withNextStepMeasurement<T>(action: () => T, receive?: (value: NextStepMeasurement) => void,
    options?: { normalizeTimelineBytes?: (content: Buffer) => number }): T {
    if (active || (!receive && process.env.GARDA_NEXT_STEP_TIMING !== '1')) return action();
    const measurement: NextStepMeasurement = { phases_ms: {}, work: {}, cpu_ms: {}, runtime: {
        diagnostics_version: 2, node_version: process.version, platform: process.platform, arch: process.arch,
        pid: process.pid, started_utc: new Date().toISOString(), phase_timings: 'inclusive', cpu_scope: 'parent_process',
        rss_before_bytes: readResidentBytes()
    } };
    active = measurement;
    timelineByteNormalizer = options?.normalizeTimelineBytes;
    const restoreProcessWork = captureProcessWork();
    const restorePayloadWork = capturePayloadWork();
    try { return measureNextStepPhase('total', action); } finally {
        restorePayloadWork();
        restoreProcessWork();
        active = null;
        timelineByteNormalizer = undefined;
        if (measurement.runtime) measurement.runtime.rss_after_bytes = readResidentBytes();
        // Diagnostics must never change a navigation result or mask its original exception.
        try {
            receive?.(measurement);
            if (process.env.GARDA_NEXT_STEP_TIMING === '1') {
                process.stderr.write('GARDA_NEXT_STEP_TIMING ' + JSON.stringify(measurement) + '\n');
            }
        } catch { /* Optional diagnostics are best effort. */ }
    }
}
