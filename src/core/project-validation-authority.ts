import { readInvocationPathObservation } from './invocation-file-observation';
import * as path from 'node:path';
import { resolveBundleNameForTarget } from './constants';
import { bindContainedDestination } from './contained-filesystem';
import { parseApprovedValidationContract, readValidationFile, validationDigest } from './project-validation-identity';
import type { ApprovedValidationContract } from './project-validation-contract';
import { mergeFileRoleBindings, type FileRoleBindings } from './file-role-bindings';
import { isAuthenticatedWorkflowMigration } from './auth/local-commit-availability';
import { ProjectValidationAuthorityError } from './project-validation-errors';

const MAXIMUM_CONTROL_BYTES = 8 * 1024 * 1024;

/** The authority reader and workflow set agree on the audit format before either trusts it. */
export function readWorkflowConfigAudit(repoRoot: string, auditPath: string, allowMissing = false):
    { bytes: Buffer; records: Record<string, unknown>[] } {
    const absolutePath = path.resolve(repoRoot, auditPath);
    let bytes: Buffer;
    try {
        readInvocationPathObservation(absolutePath);
        if (bindContainedDestination(repoRoot, absolutePath).missingAt) {
            if (allowMissing) return { bytes: Buffer.alloc(0), records: [] };
            throw new ProjectValidationAuthorityError(`Project validation authority audit '${absolutePath}' is missing.`);
        }
        bytes = readValidationFile(repoRoot, path.relative(repoRoot, absolutePath).replace(/\\/gu, '/'),
            MAXIMUM_CONTROL_BYTES).bytes;
    }
    catch (error: unknown) {
        if (error instanceof ProjectValidationAuthorityError) throw error;
        throw new ProjectValidationAuthorityError(`Project validation authority audit '${absolutePath}' is unreadable. `
            + `${error instanceof Error ? error.message : String(error)}. `
            + 'Restore access to the authentic audit before rerunning workflow set.', 'audit-repair');
    }
    const records: Record<string, unknown>[] = [];
    bytes.toString('utf8').split(/\r?\n/u).forEach((line, index) => {
        if (!line) return;
        const malformed = (problem: string): ProjectValidationAuthorityError => new ProjectValidationAuthorityError(
            `Project validation authority audit '${absolutePath}', line ${index + 1}: ${problem}. `
            + 'Restore the authentic JSON object on that line from a trusted copy before rerunning workflow set.', 'audit-repair');
        let entry: unknown;
        try { entry = JSON.parse(line); } catch { throw malformed('invalid JSON'); }
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw malformed('expected a JSON object');
        records.push(entry as Record<string, unknown>);
    });
    return { bytes, records };
}

export function readProjectValidationAuthority(repoRoot: string): { approved: ApprovedValidationContract; sha256: string } | null {
    const bundle = resolveBundleNameForTarget(repoRoot);
    const configPath = `${bundle}/live/config/workflow-config.json`;
    readInvocationPathObservation(path.join(repoRoot, configPath));
    if (bindContainedDestination(repoRoot, path.join(repoRoot, configPath)).missingAt) return null;
    const file = readValidationFile(repoRoot, configPath, MAXIMUM_CONTROL_BYTES);
    let config: Record<string, unknown>;
    try {
        config = JSON.parse(file.bytes.toString('utf8')) as Record<string, unknown>;
    } catch (error: unknown) {
        throw new Error(`Workflow config at '${configPath}' is not valid JSON.`, { cause: error });
    }
    if (config.project_validation === undefined) return null;
    const approved = parseApprovedValidationContract(config.project_validation);
    const records = readWorkflowConfigAudit(repoRoot, `${bundle}/runtime/workflow-config-audit.jsonl`).records
        .filter((entry) => entry.event_source === 'workflow-config-set' && path.resolve(repoRoot, String(entry.config_path)) === path.join(repoRoot, configPath));
    let admissionIndex = -1;
    records.forEach((entry, index) => { if (Array.isArray(entry.changed_fields) && entry.changed_fields.includes('project_validation')) admissionIndex = index; });
    if (records.at(-1)?.after_sha256 !== file.identity.sha256 || admissionIndex < 0
        || records[admissionIndex].project_validation_admission_sha256 !== validationDigest(approved)) throw new ProjectValidationAuthorityError('Project validation authority lacks an explicit recipe admission and current audited workflow configuration mutation');
    if (records.slice(admissionIndex).some((entry) => entry.mutation_source !== 'cli' && entry.mutation_source !== 'local-ui'
        && !(isAuthenticatedWorkflowMigration(repoRoot, entry)
            && entry.project_validation_preserved_sha256 === validationDigest(approved)))) throw new ProjectValidationAuthorityError('Unsupported audited workflow configuration mutation origin');
    for (let index = admissionIndex + 1; index < records.length; index++) {
        const before = records[index].before_sha256;
        if (typeof before !== 'string' || !/^[a-f0-9]{64}$/u.test(before) || before !== records[index - 1].after_sha256) throw new ProjectValidationAuthorityError('Project validation audited mutation chain is discontinuous');
    }
    return { approved, sha256: file.identity.sha256 };
}

export function readProjectValidationFileRoles(repoRoot: string): FileRoleBindings {
    const authority = readProjectValidationAuthority(repoRoot);
    return mergeFileRoleBindings(...(authority?.approved.contract.recipes.flatMap(recipe =>
        recipe.inputs.filter(input => input.role === 'source' || input.role === 'test')
            .map(input => ({ [input.path]: input.role as 'source' | 'test' }))) ?? []));
}
