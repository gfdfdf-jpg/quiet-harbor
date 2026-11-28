import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { resolveBundleName } from './constants';
import { isCanonicalTaskId } from './task-ids';

export const VALIDATION_TASK_ID_ENV = 'GARDA_VALIDATION_TASK_ID';
export const VALIDATION_REPO_ROOT_ENV = 'GARDA_VALIDATION_REPO_ROOT';
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A cleaned run keeps its manifest and reports this long after finalization, then the whole run is removed. */
export const CLEANED_RUN_RETENTION_MS = 7 * DAY_MS;
/** A failed run outside task mode keeps its diagnostic scratch this long before cleanup is authorized. */
export const UNBOUND_FAILED_RUN_RETENTION_MS = 7 * DAY_MS;
/** A running run whose producer and children all died this long ago is finalized as abandoned. */
export const ABANDONED_RUNNING_RUN_AGE_MS = DAY_MS;

type ValidationOutputKind = 'coverage' | 'node-tests';
interface ValidationOutputManifest {
    schema_version: 1;
    run_id: string;
    repo_root: string;
    host: string;
    task_id: string | null;
    kind: ValidationOutputKind;
    owner_pid: number;
    child_pids: number[];
    state: 'RUNNING' | 'FINISHED' | 'CLEANED';
    exit_code: number | null;
    reports_sha256: string | null;
    cleanup_authorized?: boolean;
    /** Finalization time; absent in manifests written before it was recorded. */
    finished_at_utc?: string;
    /** Finalized by housekeeping after its producer and children died while it was RUNNING. */
    abandoned?: boolean;
}

export interface ValidationOutputRun {
    readonly runId: string;
    readonly scratchDir: string;
    readonly reportsDir: string;
    trackChild(pid: number | undefined): void;
    finish(exitCode: number): void;
}

export function validationOutputRoot(repoRoot: string): string {
    return path.join(path.resolve(repoRoot), resolveBundleName(), 'runtime', 'validation-output');
}

function canonicalRepoRoot(repoRoot: string): string {
    const root = fs.realpathSync.native(path.resolve(repoRoot));
    return process.platform === 'win32' ? root.toLowerCase() : root;
}

/** A context inherited by another checkout must never acquire ownership there. */
export function readValidationTaskId(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string | null {
    const taskId = env[VALIDATION_TASK_ID_ENV];
    const contextRoot = env[VALIDATION_REPO_ROOT_ENV];
    if (!taskId || !isCanonicalTaskId(taskId) || !contextRoot) return null;
    try { return canonicalRepoRoot(contextRoot) === canonicalRepoRoot(repoRoot) ? taskId : null; }
    catch { return null; }
}

function assertSafePath(repoRoot: string, target: string): void {
    const root = path.resolve(repoRoot);
    const relative = path.relative(root, path.resolve(target));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('Validation output must stay inside its checkout.');
    }
    let current = root;
    for (const segment of ['', ...relative.split(path.sep)]) {
        current = path.join(current, segment);
        try {
            if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Validation output contains a symbolic link.');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }
}

function assertRegularFile(file: string): void {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new Error('Validation output metadata must be a regular, unshared file.');
    }
}

function writeManifest(repoRoot: string, runDir: string, manifest: ValidationOutputManifest): void {
    const target = path.join(runDir, 'manifest.json');
    assertSafePath(repoRoot, target);
    if (fs.existsSync(target)) assertRegularFile(target);
    const temp = path.join(runDir, `manifest-${randomUUID()}.tmp`);
    try {
        fs.writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
        fs.renameSync(temp, target);
    } finally {
        fs.rmSync(temp, { force: true });
    }
}

function reportHashes(repoRoot: string, reportsDir: string): Record<string, string> {
    const hashes: Record<string, string> = Object.create(null) as Record<string, string>;
    function visit(dir: string): void {
        assertSafePath(repoRoot, dir);
        for (const name of fs.readdirSync(dir).sort()) {
            const file = path.join(dir, name);
            assertSafePath(repoRoot, file);
            const stat = fs.lstatSync(file);
            if (stat.isDirectory()) visit(file);
            else {
                assertRegularFile(file);
                hashes[path.relative(reportsDir, file).split(path.sep).join('/')] =
                    createHash('sha256').update(fs.readFileSync(file)).digest('hex');
            }
        }
    }
    visit(reportsDir);
    return hashes;
}

function reportsDigest(repoRoot: string, reportsDir: string): string {
    return createHash('sha256').update(JSON.stringify(reportHashes(repoRoot, reportsDir))).digest('hex');
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return true;
    }
    // POSIX producers own a detached process group; descendants can outlive its leader.
    if (process.platform === 'win32') return false;
    try { process.kill(-pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function assertScratchHasNoLinks(repoRoot: string, dir: string): void {
    assertSafePath(repoRoot, dir);
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const target = path.join(dir, item.name);
        assertSafePath(repoRoot, target);
        if (item.isDirectory()) assertScratchHasNoLinks(repoRoot, target);
    }
}

function removeScratchTree(repoRoot: string, dir: string): void {
    assertSafePath(repoRoot, dir);
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const target = path.join(dir, item.name);
        assertSafePath(repoRoot, target);
        if (item.isDirectory()) removeScratchTree(repoRoot, target);
        else fs.unlinkSync(target);
    }
    fs.rmdirSync(dir);
}

function cleanupRun(repoRoot: string, runDir: string, manifest: ValidationOutputManifest): boolean {
    if (manifest.state !== 'FINISHED' || manifest.host !== os.hostname()
        || manifest.child_pids.some(isProcessAlive)) return false;
    // Preserve both report bytes and their recorded digest; tampering is not grounds for deletion.
    const reportsDir = path.join(runDir, 'reports');
    if (reportsDigest(repoRoot, reportsDir) !== manifest.reports_sha256) {
        throw new Error('Validation reports changed after finalization.');
    }
    const scratch = path.join(runDir, 'scratch');
    assertSafePath(repoRoot, scratch);
    if (fs.existsSync(scratch)) {
        assertScratchHasNoLinks(repoRoot, scratch);
        removeScratchTree(repoRoot, scratch);
        if (fs.existsSync(scratch)) throw new Error('Validation scratch was not removed.');
    }
    writeManifest(repoRoot, runDir, { ...manifest, state: 'CLEANED' });
    return true;
}

export function beginValidationOutputRun(repoRoot: string, kind: ValidationOutputKind): ValidationOutputRun {
    const runId = randomUUID();
    const runDir = path.join(validationOutputRoot(repoRoot), runId);
    const scratchDir = path.join(runDir, 'scratch');
    const reportsDir = path.join(runDir, 'reports');
    assertSafePath(repoRoot, scratchDir);
    fs.mkdirSync(scratchDir, { recursive: true });
    fs.mkdirSync(reportsDir);
    const manifest: ValidationOutputManifest = {
        schema_version: 1, run_id: runId, repo_root: canonicalRepoRoot(repoRoot), host: os.hostname(),
        task_id: readValidationTaskId(repoRoot), kind, owner_pid: process.pid, child_pids: [],
        state: 'RUNNING', exit_code: null, reports_sha256: null, cleanup_authorized: false
    };
    writeManifest(repoRoot, runDir, manifest);
    return {
        runId, scratchDir, reportsDir,
        trackChild(pid): void {
            if (manifest.state !== 'RUNNING') throw new Error('Validation output run is already finished.');
            if (pid !== undefined && Number.isSafeInteger(pid) && pid > 0 && !manifest.child_pids.includes(pid)) {
                manifest.child_pids.push(pid);
                writeManifest(repoRoot, runDir, manifest);
            }
        },
        finish(exitCode): void {
            if (manifest.state !== 'RUNNING') return;
            if (!Number.isSafeInteger(exitCode)) throw new Error('Validation output needs an integer exit code.');
            assertSafePath(repoRoot, path.join(reportsDir, 'result.json'));
            fs.writeFileSync(path.join(reportsDir, 'result.json'), `${JSON.stringify({
                schema_version: 1, kind, task_id: manifest.task_id, exit_code: exitCode
            }, null, 2)}\n`, { flag: 'wx' });
            manifest.reports_sha256 = reportsDigest(repoRoot, reportsDir);
            manifest.exit_code = exitCode;
            manifest.state = 'FINISHED';
            manifest.finished_at_utc = new Date().toISOString();
            writeManifest(repoRoot, runDir, manifest);
            // Failed attempts retain diagnostic scratch until their task closes. Unbound failures stay inspectable.
            if (exitCode === 0) cleanupRun(repoRoot, runDir, manifest);
        }
    };
}

/** Keep the existing coverage/lcov.info publication surface without sharing raw V8 output. */
export function publishValidationCoverageReports(repoRoot: string, reportsDir: string): void {
    const hashes = reportHashes(repoRoot, reportsDir);
    const targetRoot = path.join(path.resolve(repoRoot), 'coverage');
    for (const relative of Object.keys(hashes)) {
        const target = path.join(targetRoot, relative);
        assertSafePath(repoRoot, target);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (fs.existsSync(target)) assertRegularFile(target);
        const temp = `${target}.${randomUUID()}.tmp`;
        try {
            fs.copyFileSync(path.join(reportsDir, relative), temp, fs.constants.COPYFILE_EXCL);
            fs.renameSync(temp, target);
        } finally {
            fs.rmSync(temp, { force: true });
        }
    }
}

/** Null for a manifest that names another path of the repository (another mount or checkout path): not ours. */
function readManifest(repoRoot: string, runDir: string, runId: string): ValidationOutputManifest | null {
    const file = path.join(runDir, 'manifest.json');
    assertSafePath(repoRoot, file);
    assertRegularFile(file);
    if (fs.statSync(file).size > 64 * 1024) throw new Error('Validation output manifest is too large.');
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as ValidationOutputManifest;
    if (value !== null && typeof value === 'object' && typeof value.repo_root === 'string' && value.repo_root
        && value.repo_root !== canonicalRepoRoot(repoRoot)) {
        return null;
    }
    if (value.schema_version !== 1 || value.run_id !== runId || value.repo_root !== canonicalRepoRoot(repoRoot)
        || !['coverage', 'node-tests'].includes(value.kind) || typeof value.host !== 'string'
        || (value.task_id !== null && !isCanonicalTaskId(value.task_id))
        || !['RUNNING', 'FINISHED', 'CLEANED'].includes(value.state)
        || !Number.isSafeInteger(value.owner_pid) || value.owner_pid <= 0
        || !Array.isArray(value.child_pids)
        || value.child_pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0)
        || (value.cleanup_authorized !== undefined && typeof value.cleanup_authorized !== 'boolean')
        || (value.abandoned !== undefined && typeof value.abandoned !== 'boolean')
        || (value.finished_at_utc !== undefined && (typeof value.finished_at_utc !== 'string'
            || !Number.isFinite(Date.parse(value.finished_at_utc))))
        || (value.state === 'RUNNING' ? value.exit_code !== null || value.reports_sha256 !== null
            : !Number.isSafeInteger(value.exit_code) || typeof value.reports_sha256 !== 'string'
                || !/^[a-f0-9]{64}$/u.test(value.reports_sha256))) {
        throw new Error('Invalid validation output ownership manifest.');
    }
    return value;
}

/** Failed output gets retryable cleanup permission only after mandatory finalization succeeds. */
export function cleanupTaskValidationOutput(repoRoot: string, completedTaskIds: ReadonlySet<string>): string[] {
    return cleanupValidationOutput(repoRoot, completedTaskIds);
}

/** A mutable DONE queue entry alone is never permission to discard failed diagnostic output. */
export function cleanupAuthorizedValidationOutput(repoRoot: string): string[] {
    return cleanupValidationOutput(repoRoot);
}

/** Age from the recorded finalization time, else from the run directory's last change. */
function runAgeMs(runDir: string, manifest: ValidationOutputManifest, now: number): number {
    const finishedAt = manifest.finished_at_utc === undefined ? Number.NaN : Date.parse(manifest.finished_at_utc);
    return now - (Number.isFinite(finishedAt) ? finishedAt : fs.statSync(runDir).mtimeMs);
}

function authorizeCleanup(repoRoot: string, runDir: string, manifest: ValidationOutputManifest): void {
    if (manifest.cleanup_authorized === true) return;
    if (reportsDigest(repoRoot, path.join(runDir, 'reports')) !== manifest.reports_sha256) {
        throw new Error('Validation reports changed after finalization.');
    }
    manifest.cleanup_authorized = true;
    writeManifest(repoRoot, runDir, manifest);
}

/** A RUNNING run on this host whose producer and children are all gone is finalized as failed; reports stay. */
function finalizeAbandonedRun(repoRoot: string, runDir: string, manifest: ValidationOutputManifest, now: number): boolean {
    const lastActivity = fs.statSync(runDir).mtimeMs;
    if (now - lastActivity < ABANDONED_RUNNING_RUN_AGE_MS
        || [manifest.owner_pid, ...manifest.child_pids].some(isProcessAlive)) return false;
    manifest.reports_sha256 = reportsDigest(repoRoot, path.join(runDir, 'reports'));
    manifest.exit_code = 1;
    manifest.state = 'FINISHED';
    manifest.abandoned = true;
    manifest.finished_at_utc = new Date(lastActivity).toISOString();
    writeManifest(repoRoot, runDir, manifest);
    return true;
}

/** Remove a whole CLEANED run after its retention, never one whose reports no longer match their digest. */
function removeExpiredCleanedRun(repoRoot: string, runDir: string, manifest: ValidationOutputManifest, now: number): void {
    if (manifest.state !== 'CLEANED' || runAgeMs(runDir, manifest, now) < CLEANED_RUN_RETENTION_MS) return;
    if (reportsDigest(repoRoot, path.join(runDir, 'reports')) !== manifest.reports_sha256) {
        throw new Error('Validation reports changed after finalization.');
    }
    assertScratchHasNoLinks(repoRoot, runDir);
    removeScratchTree(repoRoot, runDir);
    if (fs.existsSync(runDir)) throw new Error('Validation output run was not removed.');
}

function cleanupValidationOutput(repoRoot: string, completedTaskIds?: ReadonlySet<string>): string[] {
    const notes: string[] = [];
    const root = validationOutputRoot(repoRoot);
    if (!fs.existsSync(root) || completedTaskIds?.size === 0) return notes;
    const now = Date.now();
    // Age-based retention runs in housekeeping; completion cleans only the attempts of its own tasks.
    const housekeeping = completedTaskIds === undefined;
    try {
        assertSafePath(repoRoot, root);
        for (const runId of fs.readdirSync(root).sort()) {
            if (!RUN_ID_PATTERN.test(runId)) continue;
            try {
                const runDir = path.join(root, runId);
                const manifest = readManifest(repoRoot, runDir, runId);
                if (!manifest || manifest.host !== os.hostname()) continue;
                if (housekeeping && manifest.state === 'RUNNING' && !finalizeAbandonedRun(repoRoot, runDir, manifest, now)) continue;
                if (housekeeping && manifest.state === 'CLEANED') {
                    removeExpiredCleanedRun(repoRoot, runDir, manifest, now);
                    continue;
                }
                if (manifest.state !== 'FINISHED') continue;
                if (!housekeeping) {
                    if (manifest.task_id === null || !completedTaskIds.has(manifest.task_id)) continue;
                    authorizeCleanup(repoRoot, runDir, manifest);
                } else if (manifest.task_id === null && manifest.exit_code !== 0
                    && runAgeMs(runDir, manifest, now) >= UNBOUND_FAILED_RUN_RETENTION_MS) {
                    // A failed run outside task mode has no task whose completion would release it.
                    authorizeCleanup(repoRoot, runDir, manifest);
                }
                if ((manifest.exit_code === 0 || manifest.cleanup_authorized === true)
                    && cleanupRun(repoRoot, runDir, manifest) && housekeeping) {
                    removeExpiredCleanedRun(repoRoot, runDir, { ...manifest, state: 'CLEANED' }, now);
                }
            } catch (error) {
                notes.push(`Validation output cleanup pending for ${runId}: ${error instanceof Error ? error.message.slice(0, 200) : 'invalid ownership'}`);
            }
        }
    } catch (error) {
        notes.push(`Validation output cleanup pending: ${error instanceof Error ? error.message.slice(0, 200) : 'storage unavailable'}`);
    }
    return notes;
}
