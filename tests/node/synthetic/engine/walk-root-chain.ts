import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { countNextStepWork } from '../../../../src/core/next-step-measurement';

/**
 * Directories above every disposable walk root: the temp directory and each of its ancestors, lexical and canonical.
 * The product authenticates every ancestor of each invocation input (invocation-file-observation.ts), at initial
 * capture and again at each dependency validation. That work is real, but its size is set by where TMP points, not by
 * the navigator. Counter budgets are stated at a fixed reference chain; the stand measures the actual chain per call.
 *
 * Reference: the 1.4.4 counter calibrations ran with TMP=C:/Users/<user>/AppData/Local/Temp/garda-sol-<package>
 * (C:/, Users, <user>, AppData, Local, Temp, garda-sol-<package>); see the README section on work counters.
 * Changing this value restates every file-probe budget and needs a baseline decision.
 */
export const REFERENCE_ROOT_CHAIN_DIRECTORIES = 7;
const PROBE_PREFIX = 'root_chain_probe:';
const NONCANONICAL_KEY = 'root_chain_noncanonical';
/** Path probes counted by the product's file_probes io measurement, plus fd identity reads of a chain directory. */
const PATH_PROBES = ['lstatSync', 'statSync', 'existsSync', 'readdirSync', 'readlinkSync', 'realpathSync'] as const;

/** `canonical`: the temp spelling is its own native real path, so the product's per-spelling memo walks it once. */
export interface RootChain { temp: string; canonical: boolean; directories: string[]; levels: Map<string, number> }
export interface RootChainProbe {
    /** Directories in the measured chain. */
    directories: number;
    /** Complete walks of the chain: the minimum count over all chain directories. */
    walks: number;
    /** Probes on chain directories, including partial (non-uniform) probes that remain ordinary work. */
    probes: number;
    /** Subtracted from the raw probe count: walks x (directories - reference). Negative on a shallower root. */
    adjustment: number;
}

const comparable = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
const nativeRealpath = fs.realpathSync.native;

/** Lexical ancestors of the temp directory, then any additional canonical (junction/symlink/8.3) ancestors. */
export function rootChain(temp: string = os.tmpdir()): RootChain {
    const directories: string[] = [], levels = new Map<string, number>();
    const add = (start: string) => {
        const lineage: string[] = [];
        for (let current = path.resolve(start); ; current = path.dirname(current)) {
            lineage.unshift(current);
            if (path.dirname(current) === current) break;
        }
        for (const directory of lineage) {
            if (levels.has(comparable(directory))) continue;
            levels.set(comparable(directory), directories.length); directories.push(directory);
        }
    };
    add(temp);
    let canonical = false;
    try {
        const real = nativeRealpath(temp);
        canonical = real === path.resolve(temp);
        add(real);
    } catch { /* A missing temp directory has no canonical spelling to add. */ }
    return { temp: path.resolve(temp), canonical, directories, levels };
}

/**
 * The product memoizes path observations by exact spelling. Under a non-canonical temp spelling (drive-letter or name
 * case, 8.3 short names, a symlinked alias) it authenticates both the lexical and the canonical ancestor chain of every
 * input, inside the fixture as well as above it. That doubling is caused by how TMP is spelled, not by the navigator.
 * The stand therefore runs every walk under the native real path of its temp directory: same location, one spelling.
 * Separator style and trailing separators already resolve to the same spelling. Returns the canonical temp directory.
 */
export function canonicalizeTempRoot(): string {
    const temp = os.tmpdir();
    let canonical: string;
    try { canonical = nativeRealpath(temp); } catch { return temp; }
    if (canonical !== temp) for (const name of ['TMPDIR', 'TMP', 'TEMP']) process.env[name] = canonical;
    return os.tmpdir();
}

let cached: RootChain | undefined;
function currentChain(): RootChain {
    const temp = path.resolve(os.tmpdir());
    if (cached?.temp !== temp) cached = rootChain(temp);
    return cached;
}
function chainLevel(target: unknown): number | undefined {
    let text: string;
    if (typeof target === 'string') text = target;
    else if (Buffer.isBuffer(target)) text = target.toString('utf8');
    else if (target instanceof URL) {
        if (target.protocol !== 'file:') return undefined;
        text = fileURLToPath(target);
    } else return undefined;
    if (process.platform === 'win32' && /^\\\\\?\\[A-Za-z]:/u.test(text)) text = text.slice(4);
    return currentChain().levels.get(comparable(path.resolve(text)));
}
function record(probe: string, level: number): void {
    const chain = currentChain();
    // Spelling-dependent work cannot be normalized by depth; the metrics refuse it instead of comparing it.
    if (!chain.canonical) countNextStepWork(NONCANONICAL_KEY);
    countNextStepWork(PROBE_PREFIX + probe + ':' + level + '/' + chain.directories.length);
}

let installed = false;
/**
 * Installed once, beneath the product's per-call measurement wrappers, which wrap whatever fs function is current.
 * Every probe the product counts therefore passes here first; this only labels the ones that hit a chain directory.
 * Outside a measurement countNextStepWork is a no-op.
 */
export function installRootChainProbes(): void {
    if (installed) return;
    installed = true;
    type Api = Record<string, (...args: unknown[]) => unknown>;
    // The CommonJS builtin object is mutable and is the object the product's measurement wraps; namespace views are not.
    const api = require('node:fs') as Api;
    const label = (original: (...args: unknown[]) => unknown, probe: string) => function (this: unknown, ...args: unknown[]) {
        const level = chainLevel(args[0]);
        if (level !== undefined) record(probe, level);
        return Reflect.apply(original, this, args);
    };
    for (const name of PATH_PROBES) {
        const original = api[name], wrapper = label(original, name) as ((...args: unknown[]) => unknown) & { native?: unknown };
        if (name === 'realpathSync') wrapper.native = label((original as unknown as Api).native, 'realpathSync.native');
        api[name] = wrapper;
    }
    // A descriptor opened on a chain directory makes its fstat calls chain probes too.
    const descriptors = new Map<number, number>();
    const open = api.openSync, close = api.closeSync, fstat = api.fstatSync;
    api.openSync = function (this: unknown, ...args: unknown[]) {
        const descriptor = Reflect.apply(open, this, args), level = chainLevel(args[0]);
        if (typeof descriptor === 'number' && level !== undefined) descriptors.set(descriptor, level);
        return descriptor;
    };
    api.closeSync = function (this: unknown, ...args: unknown[]) {
        try { return Reflect.apply(close, this, args); } finally { if (typeof args[0] === 'number') descriptors.delete(args[0]); }
    };
    api.fstatSync = function (this: unknown, ...args: unknown[]) {
        const level = typeof args[0] === 'number' ? descriptors.get(args[0]) : undefined;
        if (level !== undefined) record('fstatSync', level);
        return Reflect.apply(fstat, this, args);
    };
}

/**
 * Per probe API: the complete chain walks and their adjustment to the reference chain. A probe of only some chain
 * directories is not a walk; it stays in the remainder like any other probe. Inconsistent chain sizes or more chain
 * probes than the product counted mean the labels cannot be trusted: no adjustment, and the reason is returned.
 */
export function rootChainProbes(work: Readonly<Record<string, number>>, io: Readonly<Record<string, { count: number }>> = {},
    reference = REFERENCE_ROOT_CHAIN_DIRECTORIES): { probes: Record<string, RootChainProbe>; problem?: string } {
    if (work[NONCANONICAL_KEY]) return { probes: {}, problem: 'Walk root measured under a non-canonical temp spelling' };
    const levels = new Map<string, Map<number, number>>(), sizes = new Set<number>();
    for (const [key, count] of Object.entries(work)) {
        if (!key.startsWith(PROBE_PREFIX)) continue;
        const match = /^(.+):(\d+)\/(\d+)$/u.exec(key.slice(PROBE_PREFIX.length));
        if (!match) return { probes: {}, problem: 'Malformed root-chain probe key: ' + key };
        const level = Number(match[2]), size = Number(match[3]);
        if (level >= size) return { probes: {}, problem: 'Root-chain level outside its chain: ' + key };
        sizes.add(size);
        const byLevel = levels.get(match[1]) ?? new Map<number, number>();
        byLevel.set(level, (byLevel.get(level) ?? 0) + count); levels.set(match[1], byLevel);
    }
    if (sizes.size > 1) return { probes: {}, problem: 'Root-chain size changed within one call: ' + [...sizes].join(', ') };
    const directories = [...sizes][0] ?? 0, probes: Record<string, RootChainProbe> = {};
    for (const [probe, byLevel] of levels) {
        const total = [...byLevel.values()].reduce((sum, count) => sum + count, 0);
        if (total > (io[probe]?.count ?? 0)) return { probes: {}, problem: 'Root-chain probes exceed measured ' + probe + ': ' + total };
        const walks = byLevel.size === directories ? Math.min(...byLevel.values()) : 0;
        probes[probe] = { directories, walks, probes: total, adjustment: walks * (directories - reference) };
    }
    return { probes };
}
