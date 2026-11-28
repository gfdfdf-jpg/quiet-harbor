import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { WalkResult, WalkStep } from './navigator-walk';

/** A baseline decision enables this model; normal runs never create that decision. */
export interface RecordedWorkPolicy { version: 1; loadedCode: boolean; retireStates: string[] }
export function validateRecordedWorkPolicy(value: unknown): asserts value is RecordedWorkPolicy {
    const candidate = value as RecordedWorkPolicy | null;
    if (!candidate || candidate.version !== 1 || typeof candidate.loadedCode !== 'boolean'
        || !Array.isArray(candidate.retireStates) || candidate.retireStates.some(id => typeof id !== 'string' || !id)
        || new Set(candidate.retireStates).size !== candidate.retireStates.length
        || Object.keys(candidate).some(key => !['version', 'loadedCode', 'retireStates'].includes(key)))
        throw new Error('Invalid recorded-work policy; source-derived units cannot carry arbitrary coefficients or subprocess credit');
}
export interface RecordedWorkInput {
    reviews: string[]; contexts: string[]; cycles: string[]; lanes: string[];
    laneScopes?: string[];
    artifacts: string[]; directories: string[];
    loadedFiles: string[]; loadedDirectories: string[];
    loadedDomainFiles?: string[]; loadedRetainedFiles?: string[]; loadedFallbackFiles?: string[]; loadedLoaderFiles?: string[];
    loadedInputError?: string;
    sourceFiles?: string[];
    skillManifests?: Array<{ file: string; sha256: string; inputs: string[] }>;
    errors?: Array<{ taskId: string; message: string }>;
    taskFiles?: string[];
}

// captureContent: one hash/read, two descriptor stats, one final path stat.
// capturePath: two lstats and one canonical realpath, at initial capture, after
// content capture and at invocation exit. Ancestors have initial/final capture.
// Windows regular files with complete bigint identities take this path; unusual
// identities/symlinks get no guessed extra allowance (see the model document).
export const RECORDED_FILE_COST: Readonly<Record<string, number>> = Object.freeze({
    'file_hash:file': 1, payload_reads: 1, 'file_probes:fstatSync': 2,
    'file_probes:lstatSync': 6, 'file_probes:statSync': 1,
    [process.platform === 'win32' ? 'file_probes:realpathSync.native' : 'file_probes:realpathSync']: 3
});
export const RECORDED_DIRECTORY_COST: Readonly<Record<string, number>> = Object.freeze({
    'file_probes:lstatSync': 4, 'file_probes:realpathSync': 2
});
// One isSafeCanonicalArtifactPath admission (file/root exists, two native
// realpaths) plus one fileExists kind predicate (exists/stat). A cold canonical
// review snapshot also has before/after/exit lstats and six realpaths: candidate,
// matching root, registered parent, bounded-read containment and two exit checks
// (review-artifacts.ts). The review index independently lstats and realpaths an
// entry once (reviews-index.ts:resolveContainedRegularReviewArtifact). These are
// mandatory metadata witnesses, not payload reads.
export const RECORDED_ARTIFACT_ADMISSION_COST: Readonly<Record<string, number>> = Object.freeze({
    'file_probes:existsSync': 3, 'file_probes:statSync': 1, 'file_probes:lstatSync': 4,
    'file_probes:realpathSync.native': 8, 'file_probes:realpathSync': 1
});
export const RECORDED_COUNTERS = new Set([...Object.keys(RECORDED_FILE_COST), ...Object.keys(RECORDED_DIRECTORY_COST),
    ...Object.keys(RECORDED_ARTIFACT_ADMISSION_COST)]);

function spelling(file: string): string { return file.replace(/\\/gu, '/'); }
function relative(file: string): string {
    const normalized = path.posix.normalize(spelling(file).replace(/^.*?garda-walk-[^/]+\//u, ''));
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
function parents(files: readonly string[]): string[] {
    const result = new Set<string>();
    for (const file of files) for (let directory = path.posix.dirname(file); directory !== '.'; directory = path.posix.dirname(directory)) {
        if (path.posix.dirname(directory) === directory || /^[a-z]:$/iu.test(directory)) break;
        // The common bundle root belongs to the route constant. Top-level
        // project/module directories are distinct recorded scope inputs too.
        if (directory !== 'garda-agent-orchestrator') result.add(directory);
    }
    return [...result].sort();
}

function loadedUnits(work: Record<string, number>, prefix: string): string[] {
    return [...new Set(Object.keys(work).filter(key => key.startsWith(prefix)).map(key => {
        const value = key.slice(prefix.length), separator = value.indexOf(':');
        return value.slice(0, separator) + ':' + relative(value.slice(separator + 1));
    }))].sort();
}

/** Timeline facts, never review counts/modes reported by the navigator. Repeats
 * have different event positions, even when their lane and content are equal. */
export function recordedWorkInput(events: WalkResult['events'], work: Record<string, number>,
    skillManifests: NonNullable<RecordedWorkInput['skillManifests']> = [], sourceFiles: string[] = []): RecordedWorkInput {
    const reviews: string[] = [], contexts: string[] = [], cycles: string[] = [], lanes = new Set<string>(), laneScopes = new Set<string>(), artifacts = new Set<string>();
    const collect = (value: unknown): void => {
        if (typeof value === 'string') {
            const file = relative(value);
            if (/^garda-agent-orchestrator\/(?:runtime\/(?:reviews|tmp\/reviews)|live\/skills)\//u.test(file)
                && !file.includes('/../') && /\.(?:json|md)$/u.test(file)) artifacts.add(file);
        } else if (Array.isArray(value)) value.forEach(collect);
        else if (value && typeof value === 'object') Object.values(value).forEach(collect);
    };
    events.forEach((event, index) => {
        if (event.type === 'REVIEW_RECORDED') reviews.push(String(index));
        if (event.type === 'REVIEW_PHASE_STARTED') contexts.push(String(index));
        if (event.type === 'TASK_MODE_ENTERED' || event.type === 'REVIEW_CYCLE_RESTARTED') cycles.push(String(index));
        if (event.type === 'PREFLIGHT_CLASSIFIED') {
            const required = event.details.required_reviews;
            const policyHash = createHash('sha256').update(JSON.stringify(event.details.profile_policy_snapshot ?? null)).digest('hex');
            const binding = JSON.stringify([event.details.scope_sha256, event.details.scope_content_sha256, event.details.task_criteria_sha256, policyHash]);
            if (required && typeof required === 'object') for (const [lane, needed] of Object.entries(required)) if (needed === true) {
                lanes.add(lane); laneScopes.add(lane + ':' + binding);
            }
        }
        if (/^(?:REVIEW_|REVIEWER_|SKILL_|PREFLIGHT_CLASSIFIED$)/u.test(event.type)) collect(event.details);
    });
    skillManifests.forEach(manifest => manifest.inputs.forEach(file => {
        const normalized = relative(file);
        if (normalized.startsWith('garda-agent-orchestrator/live/skills/')) artifacts.add(normalized);
    }));
    // Distinct loaded file identities, not a sum of hash/read/visit counters.
    // A second hash of the same module cannot mint another unit. Keep the issuer.
    let loadedDomainFiles = loadedUnits(work, 'stand_loaded_file:');
    const loadedRetainedFiles = loadedUnits(work, 'stand_loaded_retained:'), loadedFallbackFiles = loadedUnits(work, 'stand_loaded_fallback:');
    const loadedLoaderFiles = [...new Set(loadedUnits(work, 'stand_loaded_loader:').map(unit => unit.slice(unit.indexOf(':') + 1)))].sort();
    let loadedFiles = [...new Set(loadedDomainFiles.map(unit => unit.slice(unit.indexOf(':') + 1)))].sort();
    let loadedInputError: string | undefined;
    // Legacy cold native traces did not record domain/file manifests. The one
    // capture's complete hash set and initial-file count must agree exactly;
    // otherwise no inferred allowance can certify the missing input evidence.
    const legacyFiles = work['code.capture'] && work['visit:loaded_code_initial_file'] ? [...new Set(Object.keys(work).filter(key => key.startsWith('file_hash:'))
        .map(key => relative(key.slice('file_hash:'.length)))
        .filter(file => /^garda-agent-orchestrator\/(?:dist\/.*\.(?:js|json)|bin\/garda\/derivation-source-receipts\.js)$/u.test(file)))].sort() : [];
    if (!loadedDomainFiles.length && work['visit:loaded_code_initial_file']) {
        if (work['code.capture'] === 1 && !work.loaded_code_retained_content_identity_check
            && legacyFiles.length === work['visit:loaded_code_initial_file']
            && !Object.entries(work).some(([key, count]) => key.startsWith('payload_read:') && count > 1
                && legacyFiles.includes(relative(key.slice('payload_read:'.length))))) {
            loadedFiles = legacyFiles; loadedDomainFiles = legacyFiles.map(file => 'legacy-cold:' + file);
        } else loadedInputError = 'Missing independently attributed loaded domain/file inputs; replay with the loaded-file observer';
    }
    const declaredSources = events.some(event => event.type === 'TASK_MODE_ENTERED') ? [...new Set(sourceFiles.map(relative)
        .filter(file => !file.startsWith('../') && !path.posix.isAbsolute(file) && !file.includes(':')))].sort() : [];
    return { reviews, contexts, cycles, lanes: [...lanes].sort(), laneScopes: [...laneScopes].sort(), artifacts: [...artifacts].sort(), directories: parents([...artifacts, ...declaredSources]),
        loadedFiles, loadedDirectories: parents(loadedFiles), loadedDomainFiles, loadedRetainedFiles, loadedFallbackFiles, loadedLoaderFiles,
        ...(loadedInputError ? { loadedInputError } : {}), skillManifests, sourceFiles: declaredSources };
}

/** Read selected skill metadata independently, outside navigator measurement.
 * A reference list is an input fact, never inferred from the product's read set. */
export function inspectRecordedSkillInputs(repoRoot: string, events: WalkResult['events'], sourceRoot?: string): NonNullable<RecordedWorkInput['skillManifests']> {
    const ids = new Set(events.filter(event => /^SKILL_/u.test(event.type)).map(event => event.details.skill_id)
        .filter((id): id is string => typeof id === 'string' && !!id && id.trim() === id
            && id !== '.' && id !== '..' && !/[\\/:\u0000]/u.test(id)));
    const manifests: NonNullable<RecordedWorkInput['skillManifests']> = [];
    if (!ids.size) return manifests;
    let canonicalRoot: string;
    try {
        canonicalRoot = fs.realpathSync(sourceRoot ?? path.join(repoRoot, 'garda-agent-orchestrator/live/skills'));
        if (!sourceRoot) {
            const contained = path.relative(fs.realpathSync(repoRoot), canonicalRoot);
            if (contained === '..' || contained.startsWith('..' + path.sep) || path.isAbsolute(contained)) return manifests;
        }
    }
    catch { return manifests; }
    for (const id of [...ids].sort()) {
        const directory = 'garda-agent-orchestrator/live/skills/' + id, relativeFile = directory + '/skill.json';
        const file = sourceRoot ? path.join(sourceRoot, id, 'skill.json') : path.join(repoRoot, relativeFile);
        try {
            const contained = path.relative(canonicalRoot, fs.realpathSync(file));
            if (contained === '..' || contained.startsWith('..' + path.sep) || path.isAbsolute(contained)) continue;
            const bytes = fs.readFileSync(file), metadata = JSON.parse(bytes.toString('utf8')) as { references?: unknown };
            const references = Array.isArray(metadata.references) ? metadata.references.filter((entry): entry is string => typeof entry === 'string'
                && !path.posix.isAbsolute(entry) && !entry.includes('\\') && !entry.includes(':')
                && entry.split('/').every(component => !!component && component !== '.' && component !== '..')) : [];
            manifests.push({ file: relativeFile, sha256: createHash('sha256').update(bytes).digest('hex'),
                inputs: [relativeFile, ...references.map(name => directory + '/references/' + name)] });
        } catch { /* A missing/malformed input earns no reference allowance; native refusal stays authoritative. */ }
    }
    return manifests;
}

/** Parent acceptance can consume several task histories. Lane names are local
 * to a task; physical files/directories are shared across the whole invocation. */
export function recordedTaskWorkInput(tasks: Array<{ taskId: string; input: RecordedWorkInput; error?: string }>, work: Record<string, number>): RecordedWorkInput {
    const unique = (values: string[]) => [...new Set(values)].sort();
    const units = (key: 'reviews' | 'contexts' | 'cycles' | 'lanes' | 'laneScopes') => unique(tasks.flatMap(({ taskId, input }) => (input[key] ?? []).map(id => relative(taskId) + ':' + id)));
    const loaded = recordedWorkInput([], work);
    return { ...loaded, reviews: units('reviews'), contexts: units('contexts'), cycles: units('cycles'), lanes: units('lanes'), laneScopes: units('laneScopes'),
        taskFiles: unique(tasks.map(task => relative(task.taskId))),
        artifacts: unique(tasks.flatMap(task => task.input.artifacts)), directories: unique(tasks.flatMap(task => task.input.directories)),
        sourceFiles: unique(tasks.flatMap(task => task.input.sourceFiles ?? [])),
        errors: tasks.flatMap(task => task.error ? [{ taskId: task.taskId, message: task.error }] : []),
        skillManifests: [...new Map(tasks.flatMap(task => task.input.skillManifests ?? []).map(manifest => [manifest.file, manifest])).values()] };
}

const inputSnapshots = new WeakMap<WalkStep, RecordedWorkInput>();
export function stepRecordedWork(result: WalkResult, step: WalkStep): RecordedWorkInput {
    const retained = inputSnapshots.get(step); if (retained) return retained;
    const captured = step.recordedWorkInput ?? recordedWorkInput((result.events ?? []).slice(0, step.taskEvents), step.measurement?.work ?? {});
    const canonical = (files: string[]) => [...new Set(files.map(relative))].sort();
    const input = { ...captured, artifacts: canonical(captured.artifacts), directories: canonical(captured.directories),
        loadedFiles: canonical(captured.loadedFiles), loadedDirectories: canonical(captured.loadedDirectories) };
    inputSnapshots.set(step, input); return input;
}

/** Constant route allowance plus the cost of one observation per recorded input.
 * Loaded-code cost requires a separate reviewed baseline decision. */
export function recordedAllowance(input: RecordedWorkInput, key: string, policy: RecordedWorkPolicy): number {
    const files = new Set([...input.artifacts, ...policy.loadedCode ? input.loadedFiles : []]).size;
    // Reusing already observed bytes retains the native identity check. The
    // fallback branch compares identity before/after content, on POSIX too.
    const identityChecks = policy.loadedCode ? (input.loadedRetainedFiles?.length ?? 0) + 2 * (input.loadedFallbackFiles?.length ?? 0) : 0;
    return (RECORDED_FILE_COST[key] ?? 0) * files
        + (policy.loadedCode && key === 'payload_reads' ? input.loadedLoaderFiles?.length ?? 0 : 0)
        + (RECORDED_ARTIFACT_ADMISSION_COST[key] ?? 0) * input.artifacts.length
        + (key === 'file_probes:lstatSync' || key === 'file_probes:realpathSync.native' ? identityChecks : 0)
        + (RECORDED_DIRECTORY_COST[key] ?? 0) * new Set([...input.directories, ...policy.loadedCode ? input.loadedDirectories : []]).size;
}

export interface RepeatedWork { metric: string; observed: number; limit: number }
const DERIVATIONS = ['derive:getReviewContextContractViolations', 'derive:resolvePersistedRemediationReviewExecutionAuthority',
    'derive:authoritative_coverage_scope'];
/** Separate per-input ceilings prevent unused aggregate allowance hiding repeats.
 * Live transaction-owner/index/timeline rereads are outside this artifact set. */
export function repeatedRecordedWork(input: RecordedWorkInput, work: Record<string, number>): RepeatedWork[] {
    const failures: RepeatedWork[] = [], files = new Set([...input.artifacts, ...input.loadedFiles]);
    const loadedVisits = work['visit:loaded_code_initial_file'] ?? 0;
    if (!input.loadedInputError && loadedVisits !== (input.loadedDomainFiles?.length ?? input.loadedFiles.length)) failures.push({ metric: 'loaded-code-file-identities',
        observed: Math.abs(loadedVisits - (input.loadedDomainFiles?.length ?? input.loadedFiles.length)), limit: 0 });
    const reads = new Map<string, number>();
    for (const [key, count] of Object.entries(work)) {
        if (key.startsWith('stand_unit:') && count > 1) failures.push({ metric: key, observed: count, limit: 1 });
        if (key.startsWith('stand_loaded_') && count > 1) failures.push({ metric: key, observed: count, limit: 1 });
        if (key.startsWith('stand_unit_missing:') && count > 0) failures.push({ metric: key, observed: count, limit: 0 });
        // Git observations retain one acquisition and one exit freshness query.
        // Route process ceilings still apply independently, without any credit.
        if (/^process:[^:]+:git:/u.test(key) && count > 2)
            failures.push({ metric: key + ':repeated', observed: count, limit: 2 });
        if (!/^(?:file_hash|payload_read):/u.test(key)) continue;
        const separator = key.indexOf(':'), file = relative(key.slice(separator + 1));
        if (!files.has(file)) continue;
        // The snapshot envelope and review-index's observeReads=false preflight
        // witnesses are mandatory live inputs, not closed review payloads.
        if (/-task-mode\.json$/u.test(file)) continue;
        const identity = key.slice(0, separator) + ':repeated:' + file;
        reads.set(identity, (reads.get(identity) ?? 0) + count);
    }
    for (const [metric, observed] of reads) {
        const limit = metric.startsWith('payload_read:') && /-preflight\.json$/u.test(metric) ? 3
            : metric.startsWith('payload_read:') && input.loadedLoaderFiles?.includes(metric.slice('payload_read:repeated:'.length)) ? 2 : 1;
        if (observed > limit) failures.push({ metric, observed, limit });
    }
    for (const key of DERIVATIONS) {
        const attributed = Object.entries(work).filter(([name]) => name.startsWith('stand_unit:' + key + ':'))
            .reduce((sum, [, count]) => sum + count, 0);
        if ((work[key] ?? 0) !== attributed) failures.push({ metric: 'stand_unit_unattributed:' + key,
            observed: Math.abs((work[key] ?? 0) - attributed), limit: 0 });
    }
    // Both derivations memoize by semantic review input. Their per-unit work is
    // one derivation; a pending lane may have a context before REVIEW_RECORDED.
    for (const key of ['derive:getReviewContextContractViolations', 'derive:resolvePersistedRemediationReviewExecutionAuthority']) {
        const limit = Math.max(input.reviews.length, input.contexts.length);
        if ((work[key] ?? 0) > limit) failures.push({ metric: key, observed: work[key], limit });
    }
    const laneKey = 'derive:authoritative_coverage_scope';
    const scopeUnits = input.laneScopes?.length ?? input.lanes.length;
    if ((work[laneKey] ?? 0) > scopeUnits) failures.push({ metric: laneKey, observed: work[laneKey], limit: scopeUnits });
    return failures;
}
