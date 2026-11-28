import { createInvocationReadMemoKey, isInvocationReadObservationActive, memoizeInvocationRead } from './invocation-read-observation';
import { observedInvocationValue, readInvocationFileContent, readInvocationPathObservation } from './invocation-file-observation';
import { countNextStepWork } from './next-step-measurement';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { assertExistingPathIdentity, bindContainedDestination, type ContainedDestination } from './contained-filesystem';
import type { ApprovedValidationContract, ValidationFileIdentity, ValidationRecipe } from './project-validation-contract';
import { parseProjectValidationContract } from './project-validation-recipes';
import { validationRelativePath } from './validation-relative-path';
import { ProjectValidationAuthorityError } from './project-validation-errors';

const MAXIMUM_FILE_BYTES = 128 * 1024 * 1024;
// Audited executables are hashed as a stream and never retained, so their bound follows real
// toolchains (a Node 26 Linux binary is about 143 MiB) instead of the retained input bound.
export const MAXIMUM_TOOL_BYTES = 512 * 1024 * 1024;
const TOOL_HASH_CHUNK_BYTES = 64 * 1024;

export function validationDigest(value: unknown): string {
    return createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
}
export function readValidationFile(root: string, relative: string, maximumBytes = MAXIMUM_FILE_BYTES): { identity: ValidationFileIdentity; bytes: Buffer } {
    const { identity, bytes } = readObservedValidationFile(root, relative, maximumBytes);
    return { identity, bytes };
}

export interface ValidationFileObservation {
    identity: ValidationFileIdentity;
    modified_ns: string;
    changed_ns: string;
    created_ns: string;
}

const INVOCATION_VALIDATION_BINDINGS = createInvocationReadMemoKey<ContainedDestination>('validation-file-bindings');
const INVOCATION_VALIDATION_BOUND_CHECKS = createInvocationReadMemoKey<boolean>('validation-file-bound-checks');

function observedValidationBinding(root: string, target: string): ContainedDestination {
    const resolvedRoot = path.resolve(root), resolvedTarget = path.resolve(target);
    const memoId = JSON.stringify([resolvedRoot, resolvedTarget]);
    return memoizeInvocationRead(INVOCATION_VALIDATION_BINDINGS, memoId, () => {
        const relative = path.relative(resolvedRoot, resolvedTarget);
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
            throw new Error('Destination resolves outside permitted root: ' + resolvedTarget);
        }
        const components = relative ? relative.split(path.sep) : [];
        const existing: Array<ContainedDestination['existing'][number]> = [];
        let current = resolvedRoot, missingAt: string | null = null;
        for (let index = -1; index < components.length; index += 1) {
            if (index >= 0) current = path.join(current, components[index]);
            let stat: fs.BigIntStats;
            try { stat = observedInvocationValue(readInvocationPathObservation(current)!.identity); }
            catch (error: unknown) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') { missingAt = current; break; }
                throw error;
            }
            if (stat.isSymbolicLink()) throw new Error('Refusing to overwrite symlink or junction destination: ' + current);
            if ((index === -1 || index < components.length - 1) && !stat.isDirectory()) throw new Error('Destination parent is not a directory: ' + current);
            if (stat.isFile() && stat.nlink !== 1n) throw new Error('Destination crosses a hard-linked file: ' + current);
            if (!stat.isDirectory() && !stat.isFile()) throw new Error('Destination has an unsupported path type: ' + current);
            if (stat.birthtimeNs <= 0n) throw new Error('Destination creation identity is unavailable: ' + current);
            existing.push(Object.freeze({ path: current, dev: stat.dev, ino: stat.ino, mode: stat.mode, birthtimeNs: stat.birthtimeNs }));
        }
        if (existing.length === 0) throw new Error('Destination root does not exist: ' + resolvedRoot);
        const binding = Object.freeze({ root: resolvedRoot, path: resolvedTarget, existing: Object.freeze(existing), missingAt });
        // Each component already has an invocation dependency from readInvocationPathObservation.
        // Its final check includes the bound identity, link count, permissions and real path.
        // Re-registering the whole chain here would recheck shared ancestors for every file.
        return binding;
    }).value;
}

function readInvocationValidationFile(root: string, relative: string, maximumBytes: number, retainBytes = true): ValidationFileObservation & { bytes: Buffer } {
    const target = path.resolve(root, relative), binding = observedValidationBinding(root, target);
    const before = observedInvocationValue(readInvocationPathObservation(target)!.targetIdentity);
    const bound = binding.existing.at(-1);
    if (binding.missingAt || !bound || before.dev !== bound.dev || before.ino !== bound.ino || before.birthtimeNs !== bound.birthtimeNs) {
        throw new Error('Validation descriptor does not match the bound file: ' + relative);
    }
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximumBytes)) throw new Error('Invalid validation input or byte bound: ' + relative);
    const content = readInvocationFileContent(target, maximumBytes)!;
    memoizeInvocationRead(INVOCATION_VALIDATION_BOUND_CHECKS, JSON.stringify([binding.root, target]), () => {
        assertExistingPathIdentity(binding);
        return true;
    });
    return { bytes: retainBytes ? content.copyBytes() : Buffer.alloc(0), modified_ns: before.mtimeNs.toString(), changed_ns: before.ctimeNs.toString(),
        created_ns: before.birthtimeNs.toString(), identity: { path: relative, sha256: content.sha256, size: content.size,
            identity: before.dev + ':' + before.ino + ':' + before.birthtimeNs } };
}

export function readObservedValidationFile(root: string, relative: string, maximumBytes = MAXIMUM_FILE_BYTES): ValidationFileObservation & { bytes: Buffer } {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > MAXIMUM_FILE_BYTES) throw new Error('Invalid validation file byte bound');
    return readBoundValidationFile(root, relative, maximumBytes, true);
}

function readBoundValidationFile(root: string, relative: string, maximumBytes: number, retainBytes: boolean): ValidationFileObservation & { bytes: Buffer } {
    relative = validationRelativePath(relative);
    if (isInvocationReadObservationActive()) return readInvocationValidationFile(root, relative, maximumBytes, retainBytes);
    const target = path.resolve(root, relative);
    const binding = bindContainedDestination(root, target);
    const descriptor = fs.openSync(target, 'r');
    try {
        const before = fs.fstatSync(descriptor, { bigint: true });
        const bound = binding.existing.at(-1);
        if (binding.missingAt || !bound || before.dev !== bound.dev || before.ino !== bound.ino || before.birthtimeNs !== bound.birthtimeNs) throw new Error(`Validation descriptor does not match the bound file: ${relative}`);
        if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximumBytes)) throw new Error(`Invalid validation input or byte bound: ${relative}`);
        // A retained read allocates one extra byte to detect growth; a streamed read hashes fixed chunks.
        const retained = retainBytes ? Buffer.alloc(Number(before.size) + 1) : null;
        const chunk = retained ?? Buffer.alloc(TOOL_HASH_CHUNK_BYTES);
        const digest = createHash('sha256');
        let offset = 0;
        while (offset <= Number(before.size)) {
            const count = retained
                ? fs.readSync(descriptor, retained, offset, retained.length - offset, offset)
                : fs.readSync(descriptor, chunk, 0, chunk.length, offset);
            if (count === 0) break;
            if (!retained) digest.update(chunk.subarray(0, count));
            offset += count;
        }
        const after = fs.fstatSync(descriptor, { bigint: true });
        assertExistingPathIdentity(binding);
        if (before.dev !== after.dev || before.ino !== after.ino || before.birthtimeNs !== after.birthtimeNs || after.nlink !== 1n
            || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || offset !== Number(before.size)) throw new Error(`Validation input changed during read: ${relative}`);
        const bytes = retained ? retained.subarray(0, offset) : Buffer.alloc(0);
        countNextStepWork('file_hash:' + target);
        return { bytes, modified_ns: before.mtimeNs.toString(), changed_ns: before.ctimeNs.toString(),
            created_ns: before.birthtimeNs.toString(), identity: { path: relative, sha256: retained ? validationDigest(bytes) : digest.digest('hex'), size: offset,
            identity: `${before.dev}:${before.ino}:${before.birthtimeNs}` } };
    } finally { fs.closeSync(descriptor); }
}
export function readValidationInputs(root: string, recipe: ValidationRecipe): ValidationFileIdentity[] {
    let remaining = recipe.max_input_bytes;
    return recipe.inputs.map((input) => {
        const { identity } = readValidationFile(root, input.path, remaining);
        remaining -= identity.size;
        return identity;
    });
}
export function readValidationTool(executable: string): ValidationFileIdentity {
    if (!path.isAbsolute(executable)) throw new Error('Audited executable must be an absolute path (resolve it before admission)');
    bindContainedDestination(path.parse(executable).root, executable);
    return { ...readBoundValidationFile(path.dirname(executable), path.basename(executable), MAXIMUM_TOOL_BYTES, false).identity, path: executable };
}
export function approveProjectValidationContract(repoRoot: string, value: unknown): ApprovedValidationContract {
    const contract = parseProjectValidationContract(value);
    const tools: ApprovedValidationContract['tools'] = Object.create(null) as ApprovedValidationContract['tools'];
    const dependencies: ApprovedValidationContract['dependencies'] = Object.create(null) as ApprovedValidationContract['dependencies'];
    for (const recipe of contract.recipes) {
        tools[recipe.id] = readValidationTool(recipe.executable);
        for (const [index, identity] of readValidationInputs(repoRoot, recipe).entries()) {
            const input = recipe.inputs[index];
            if (input.role === 'helper' || input.role === 'config') dependencies[input.path] = identity;
        }
    }
    return parseApprovedValidationContract({ schema_version: 1, contract, tools, dependencies });
}
export function parseApprovedValidationContract(value: unknown): ApprovedValidationContract {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProjectValidationAuthorityError('Invalid approved validation contract');
    const raw = value as ApprovedValidationContract;
    if (raw.schema_version !== 1 || Object.keys(raw).some((key) => !['schema_version', 'contract', 'tools', 'dependencies'].includes(key))) throw new ProjectValidationAuthorityError('Invalid approved validation contract version or properties');
    const contract = parseProjectValidationContract(raw.contract);
    for (const field of ['tools', 'dependencies'] as const) {
        const entries = raw[field];
        if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new ProjectValidationAuthorityError(`Missing approved ${field}`);
    }
    const toolIds = contract.recipes.map((recipe) => recipe.id).sort();
    const deps = [...new Set(contract.recipes.flatMap((recipe) => recipe.inputs.filter((input) => input.role === 'helper' || input.role === 'config').map((input) => input.path)))].sort();
    if (JSON.stringify(Object.keys(raw.tools).sort()) !== JSON.stringify(toolIds) || JSON.stringify(Object.keys(raw.dependencies).sort()) !== JSON.stringify(deps)) throw new ProjectValidationAuthorityError('Approved identities do not cover the exact contract');
    const tools: ApprovedValidationContract['tools'] = Object.create(null) as ApprovedValidationContract['tools'];
    const dependencies: ApprovedValidationContract['dependencies'] = Object.create(null) as ApprovedValidationContract['dependencies'];
    for (const recipe of contract.recipes) tools[recipe.id] = parseFileIdentity(raw.tools[recipe.id], recipe.executable, MAXIMUM_TOOL_BYTES);
    for (const dependency of deps) dependencies[dependency] = parseFileIdentity(raw.dependencies[dependency], dependency);
    return { schema_version: 1, contract, tools, dependencies };
}
export function parseFileIdentity(value: ValidationFileIdentity, expectedPath: string, maximumBytes = MAXIMUM_FILE_BYTES): ValidationFileIdentity {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.path !== expectedPath || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)
        || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > maximumBytes || typeof value.identity !== 'string'
        || !/^\d+:\d+:\d+$/u.test(value.identity) || Object.keys(value).some((key) => !['path', 'sha256', 'size', 'identity'].includes(key))) throw new ProjectValidationAuthorityError('Invalid approved file identity');
    return { path: value.path, sha256: value.sha256, size: value.size, identity: value.identity };
}
