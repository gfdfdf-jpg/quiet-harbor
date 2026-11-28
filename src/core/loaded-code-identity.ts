import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { lstatFileIdentitySync } from './file-stat';
import {
    readInvocationFileContent, readInvocationFileContentWithObservation, readInvocationPathObservation,
    type InvocationPathObservation
} from './invocation-file-observation';
import { registerInvocationDependency } from './invocation-read-observation';
import { countNextStepWork, measureNextStepPhase } from './next-step-measurement';
interface SourceReceipt { readonly file: string; readonly sha256: string }
interface SourceIssuer extends SourceReceipt {
    readonly version: 1; readonly issuer: string;
    read(module: NodeModule): SourceReceipt | null;
}
export interface LoadedCodeClosureBinding {
    readonly version: 1;
    readonly domain: string;
    readonly sha256: string;
    /** Native fresh check for producers immediately before authenticated publication. */
    assertCurrent(): void;
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const slot = Symbol.for('garda.loaded-source-receipts.v1');
function currentIssuer(): SourceIssuer {
    const value = Object.getOwnPropertyDescriptor(globalThis, slot)?.value as SourceIssuer | undefined;
    if (!value || value.version !== 1 || typeof value.read !== 'function') {
        countNextStepWork('loaded_code_receipts_unavailable');
        throw new Error('Loaded-code receipts are unavailable; native fallback is required.');
    }
    return value;
}
function identityText(realpath: string, stat: fs.BigIntStats): string {
    return JSON.stringify([realpath, String(stat.dev), String(stat.ino), String(stat.mode),
        String(stat.nlink), String(stat.size), String(stat.birthtimeNs), String(stat.mtimeNs), String(stat.ctimeNs)]);
}
function identity(file: string): string {
    countNextStepWork('loaded_code_identity_probe');
    const stat = measureNextStepPhase('code.identity_stat', () => lstatFileIdentitySync(file, { bigint: true }));
    const realpath = measureNextStepPhase('code.identity_realpath', () => fs.realpathSync.native(file));
    return identityText(realpath, stat);
}
/** Win32 Q2 regular-file observations of this exact path already hold identity()'s lstat and native realpath. */
function observedIdentity(file: string, observation: InvocationPathObservation | null): string | null {
    if (!observation || observation.path !== file) return null;
    const { stat, identity: lstat, realPath } = observation;
    if (!('value' in stat) || !stat.value.isFile() || !('value' in lstat) || !lstat.value.isFile() || !('value' in realPath)
        || realPath.value !== file) return null;
    return identityText(realPath.value, lstat.value);
}
function nativeHash(file: string): string {
    const before = identity(file), bytes = measureNextStepPhase('code.native_read', () => fs.readFileSync(file));
    countNextStepWork('loaded_code_native_bytes', bytes.length);
    if (identity(file) !== before) throw new Error('Loaded-code file changed during native read: ' + file);
    return hash(bytes);
}
function compare(left: string, right: string): number {
    countNextStepWork('compare:loaded_code_path'); return left < right ? -1 : left > right ? 1 : 0;
}
/** Generic CODE identity only: roots are resolved by fixed owners. This is no result/publication seal.
 * Every module must have an actual early-loader source receipt; disk hashes alone never qualify.
 * Complete data, policy, workspace, native admission and effect checks remain the owner's job.
 */
export function captureLoadedCodeClosure(domain: string, resolvedRoots: readonly string[]): LoadedCodeClosureBinding {
    return measureNextStepPhase('code.capture', () => {
        if (!domain || !resolvedRoots.length || resolvedRoots.some(file => !path.isAbsolute(file)))
            throw new Error('Loaded-code closure requires an explicit domain and resolved roots.');
        const issuer = currentIssuer(), roots = Array.from(new Set([require.resolve('./loaded-code-identity'), ...resolvedRoots])).sort(compare);
        const retainedModules = new Map<string, NodeModule>();
        const graph = (retain: boolean): Array<[string, string, string[]]> => {
            if (currentIssuer() !== issuer) throw new Error('Loaded-code receipt authority changed.');
            const pending = [...roots], seen = new Set<string>(), rows: Array<[string, string, string[]]> = [];
            while (pending.length) {
                const file = pending.pop()!; if (seen.has(file)) continue; seen.add(file);
                countNextStepWork('visit:loaded_code_module');
                const module = require.cache[file], receipt = module ? issuer.read(module) : null;
                if (!module || !receipt || receipt.file !== file || (!file.endsWith('.js') && !file.endsWith('.json')))
                    throw new Error('Loaded-code module lacks an actual source receipt: ' + file);
                if (retain) retainedModules.set(file, module);
                else if (retainedModules.get(file) !== module) throw new Error('Loaded-code module instance changed: ' + file);
                const children: string[] = [];
                for (const child of module.children) {
                    countNextStepWork('visit:loaded_code_edge');
                    if (child.filename) { children.push(child.filename); pending.push(child.filename); }
                }
                children.sort(compare); rows.push([file, receipt.sha256, children]);
            }
            return rows.sort((a, b) => compare(a[0], b[0]));
        };
        const rows = measureNextStepPhase('code.initial_graph', () => graph(true)), graphSha256 = hash(JSON.stringify(rows));
        const files: Array<[string, string]> = [[issuer.file, issuer.sha256]];
        for (const [file, sha256] of rows) { countNextStepWork('visit:loaded_code_receipt'); files.push([file, sha256]); }
        const identities = new Map<string, string>();
        measureNextStepPhase('code.initial_files', () => {
            for (const [file, sha256] of files) {
                countNextStepWork('visit:loaded_code_initial_file');
                const observedBefore = process.platform === 'win32' ? observedIdentity(file, readInvocationPathObservation(file)) : null;
                if (observedBefore === null) {
                    const before = identity(file);
                    const observed = measureNextStepPhase('code.file_content', () => readInvocationFileContent(file));
                    const actual = observed ? observed.sha256 : nativeHash(file);
                    if (actual !== sha256) throw new Error('Loaded code differs from current executable bytes: ' + file);
                    if (identity(file) !== before) throw new Error('Loaded-code file identity changed during capture: ' + file);
                    identities.set(file, before);
                    continue;
                }
                // The alias is the canonical observation. A read made now validated it before and after the bytes.
                const read = measureNextStepPhase('code.file_content', () => readInvocationFileContentWithObservation(file));
                if (!read || read.alias.path !== file) throw new Error('Loaded-code file observation changed during capture: ' + file);
                if (read.content.sha256 !== sha256) throw new Error('Loaded code differs from current executable bytes: ' + file);
                // Retained bytes had no post-read validation in this call; keep one fresh native identity check.
                if (!read.capturedNow) {
                    countNextStepWork('loaded_code_retained_content_identity_check');
                    if (identity(file) !== observedBefore) throw new Error('Loaded-code file identity changed during capture: ' + file);
                }
                identities.set(file, observedBefore);
            }
        });
        const assertGraphCurrent = () => measureNextStepPhase('code.final_graph', () => {
            if (hash(JSON.stringify(graph(false))) !== graphSha256) {
                countNextStepWork('loaded_code_graph_changed');
                throw new Error('Loaded-code dependency graph changed.');
            }
        });
        const binding: LoadedCodeClosureBinding = Object.freeze({ version: 1, domain,
            sha256: hash(JSON.stringify(['garda.loaded-code-closure.v1', domain, roots, process.versions,
                process.platform, process.arch, issuer.issuer, issuer.sha256, graphSha256])),
            assertCurrent() {
                assertGraphCurrent();
                for (const [file, sha256] of files) {
                    countNextStepWork('visit:loaded_code_final_file');
                    if (identity(file) !== identities.get(file)) throw new Error('Loaded-code file identity changed before publication: ' + file);
                    if (nativeHash(file) !== sha256) throw new Error('Loaded code differs from current executable bytes: ' + file);
                    if (identity(file) !== identities.get(file)) throw new Error('Loaded-code file identity changed before publication: ' + file);
                }
            }
        });
        // Active Q2 owners already registered the native final file checks above. No repeated raw
        // code-file traversal is added here; standalone producers call assertCurrent before signing.
        registerInvocationDependency(binding, assertGraphCurrent);
        return binding;
    });
}
