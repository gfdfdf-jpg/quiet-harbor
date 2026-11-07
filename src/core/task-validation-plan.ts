import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { inspectValidationCommand, literalValidationValues, type ValidationCommandDescriptor, type ValidationCommandPurpose } from './validation-command-contract';
import { isIntermediateSelection, intermediateSourcePathKey } from './intermediate-selected-cases';
import { validationRelativePath } from './validation-relative-path';
import { validationDigest } from './project-validation-identity';
import { isPlainRecord } from './records';
import { matchAnyRegex } from '../gate-runtime/text-utils';
export { literalValidationValues } from './validation-command-contract';

/** Task-local declarations. A relation proves identity, never assertion semantics. */
export interface TaskValidationTarget {
    path: string;
    sha256: string;
    invocation: number;
    association: 'literal' | 'symbolic';
    selector: string;
    reason?: string;
}
export interface TaskValidationSupport {
    path: string;
    sha256: string;
    role: 'helper' | 'fixture' | 'runner' | 'config';
    targets: string[];
}
export interface TaskValidationPlan {
    schema_version: 1;
    descriptor: ValidationCommandDescriptor;
    targets: TaskValidationTarget[];
    support: TaskValidationSupport[];
    inputs: Array<{ path: string; sha256: string }>;
    requires_semantic_review: boolean;
    binding?: { task_id: string; workspace_root: string; task_mode_entry_sha256: string;
        preflight_sha256: string; scope_sha256: string; scope_content_sha256: string; selected_at: string };
}
export interface TaskValidationDeclaration {
    targets?: Array<{ path: string; invocation?: number; selector?: string; entrypoint?: string; reason?: string }>;
    support?: Array<{ path: string; role: TaskValidationSupport['role']; targets: string[] }>;
}
export interface TaskValidationProcess {
    execution_id: string;
    invocation: number;
    executable: string;
    argv: string[];
    cwd: string;
    started_at: string;
    completed_at: string;
    exit_code: number;
    timed_out: boolean;
    cancelled: boolean;
    output_sha256: string;
    scope_before: string;
    scope_after: string;
}
export interface TaskValidationProcessEvidence {
    schema_version: 1;
    selection_sha256: string;
    invocations: TaskValidationProcess[];
}

/** Symbolic associations and changed test-like support need an independent test review. */
export function taskValidationRequiresSemanticReview(plan: TaskValidationPlan | undefined,
    changedFiles: readonly string[], testRegexes: readonly string[]): boolean {
    if (!plan) return false;
    if (plan.requires_semantic_review) return true;
    const key = (file: string) => process.platform === 'win32' ? file.replace(/\\/gu, '/').toLowerCase() : file.replace(/\\/gu, '/');
    const changed = new Set(changedFiles.map(key));
    return plan.support.some(item => changed.has(key(item.path)) && matchAnyRegex(item.path, [...testRegexes], {
        skipInvalidRegex: true, caseInsensitive: true
    }));
}

/** Both review admission and completion enforce the same mandatory lane. */
export function taskValidationSemanticReviewViolations(plan: TaskValidationPlan | undefined,
    changedFiles: readonly string[], testRegexes: readonly string[], requiredReviews: Record<string, unknown>,
    skippedReviews: readonly string[] = []): string[] {
    return taskValidationRequiresSemanticReview(plan, changedFiles, testRegexes)
        && (requiredReviews.test !== true || skippedReviews.includes('test'))
        ? ['Task validation semantic mapping requires mandatory test review. Run garda gate restart-coherent-cycle, then complete the test review lane.'] : [];
}

const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
    && value.length <= 4096 && !/[\0\r\n]/u.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

export function parseTaskValidationDeclaration(value: unknown): TaskValidationDeclaration {
    if (!isPlainRecord(value) || Object.keys(value).some(key => !['targets', 'support'].includes(key))
        || value.targets !== undefined && !Array.isArray(value.targets)
        || value.support !== undefined && !Array.isArray(value.support)) throw new Error('Invalid task test plan declaration.');
    for (const claim of value.targets ?? []) {
        if (!isPlainRecord(claim) || !text(claim.path)
            || Object.keys(claim).some(key => !['path', 'invocation', 'selector', 'entrypoint', 'reason'].includes(key))
            || claim.invocation !== undefined && (!Number.isSafeInteger(claim.invocation) || Number(claim.invocation) < 0)
            || claim.selector !== undefined && !text(claim.selector)
            || claim.entrypoint !== undefined && !text(claim.entrypoint)
            || claim.reason !== undefined && !text(claim.reason)
            || claim.entrypoint !== undefined && claim.selector !== undefined)
            throw new Error('Invalid task test target mapping.');
    }
    for (const claim of value.support ?? []) {
        if (!isPlainRecord(claim) || !text(claim.path) || !['helper', 'fixture', 'runner', 'config'].includes(String(claim.role))
            || Object.keys(claim).some(key => !['path', 'role', 'targets'].includes(key))
            || !Array.isArray(claim.targets) || !claim.targets.length || !claim.targets.every(text))
            throw new Error('Invalid task test support mapping.');
    }
    return value as TaskValidationDeclaration;
}

export function taskValidationTargetTokens(target: string): string[] {
    const normalized = target.replace(/\\/gu, '/');
    const name = path.posix.basename(normalized), stem = name.slice(0, name.length - path.posix.extname(name).length);
    const parts = normalized.slice(0, normalized.length - path.posix.extname(name).length).split('/');
    return [...new Set([normalized, name, stem, ...parts.map((_, index) => parts.slice(index).join('.'))])];
}

export function taskValidationLiteralAssociation(tokens: readonly string[], target: string): string | null {
    return indexedAssociation(indexInvocationValues(tokens).associations, target);
}

/** An unexecuted literal declaration proves target identity only, never process success. */
export function declaredValidationCommandTargets(command: string, candidates: readonly string[]): string[] {
    const descriptor = inspectValidationCommand(command, 'validation').descriptor;
    if (!descriptor) return [];
    const values = indexInvocationValues(descriptor.invocations.flatMap(run => [run.executable, ...run.argv]));
    return candidates.filter(target => indexedAssociation(values.associations, target) !== null);
}

/** Claim A from captured intermediate inputs. Process authenticity is checked by its caller. */
export function genericBoundCommandTargets(command: string, binding: unknown, candidates: readonly string[]): string[] {
    if (!isPlainRecord(binding) || !isIntermediateSelection(binding.before) || !Array.isArray(binding.after)) return [];
    const selection = binding.before;
    if (binding.after.length !== selection.sources.length || selection.sources.some((source, index) =>
        validationDigest(source) !== validationDigest((binding.after as unknown[])[index]))) return [];
    const descriptor = inspectValidationCommand(command, 'validation', { allowConjunction: true }).descriptor;
    if (!descriptor) return [];
    const tokens = descriptor.invocations.flatMap(invocation => [invocation.executable, ...invocation.argv]);
    const values = indexInvocationValues(tokens);
    const candidateKeys = new Set(candidates.map(intermediateSourcePathKey));
    const sources = new Set(selection.sources.map(source => intermediateSourcePathKey(source.path)));
    const targets = selection.cases.length ? selection.cases.map(claim => claim.source)
        : selection.sources.filter(source => candidateKeys.has(intermediateSourcePathKey(source.path))).map(source => source.path);
    if (selection.cases.some(claim => !values.literals.has(claim.selector))) return [];
    for (const target of targets) {
        try { if (validationRelativePath(target) !== target) return []; } catch { return []; }
        if (!sources.has(intermediateSourcePathKey(target))) return [];
        if (!selection.cases.length && !indexedAssociation(values.associations, target)) return [];
    }
    return [...new Set(targets)];
}

function indexInvocationValues(tokens: readonly string[]): { literals: Set<string>; associations: Map<string, string> } {
    const values = literalValidationValues(tokens), associations = new Map<string, string>();
    for (const value of values) {
        const normalized = value.replace(/\\/gu, '/').replace(/^\.\//u, '');
        for (const key of [normalized, normalized.split(/#|::/u)[0]]) if (!associations.has(key)) associations.set(key, value);
    }
    return { literals: new Set(values), associations };
}

function indexedAssociation(values: ReadonlyMap<string, string>, target: string): string | null {
    for (const name of taskValidationTargetTokens(target)) {
        const value = values.get(name);
        if (value !== undefined) return value;
    }
    return null;
}

/** All inputs have been captured through the caller's contained-file reader at admission. */
export function buildTaskValidationPlan(command: string, sources: readonly { path: string; sha256: string }[],
    declaration: TaskValidationDeclaration = {}, inputs: readonly { path: string; sha256: string }[] = [],
    purpose: ValidationCommandPurpose = 'test'): TaskValidationPlan {
    const admission = inspectValidationCommand(command, purpose, { allowConjunction: true });
    if (!admission.supported || !admission.descriptor?.invocations.length)
        throw new Error(admission.violation ?? 'Declare at least one literal task test command.');
    const descriptor = admission.descriptor;
    declaration = parseTaskValidationDeclaration(declaration);
    const claims = declaration.targets ?? [], supportClaims = declaration.support ?? [];
    if (claims.some(claim => !isPlainRecord(claim) || !text(claim.path)
        || Object.keys(claim).some(key => !['path', 'invocation', 'selector', 'entrypoint', 'reason'].includes(key)))
        || new Set(claims.map(claim => JSON.stringify([claim.path, claim.invocation]))).size !== claims.length)
        throw new Error('Task test target mappings must name distinct declared path/invocation pairs.');
    const supports = new Set(supportClaims.map(claim => claim.path));
    if (supports.size !== supportClaims.length) throw new Error('Duplicate task support paths.');
    const sourceMap = new Map<string, { path: string; sha256: string }>();
    for (const source of sources) {
        if (sourceMap.has(source.path) && sourceMap.get(source.path)!.sha256 !== source.sha256)
            throw new Error(`Conflicting source hashes for ${source.path}.`);
        sourceMap.set(source.path, source);
    }
    const runnable = [...sourceMap.values()].filter(source => !supports.has(source.path));
    if (!runnable.length) throw new Error('Declare at least one runnable task test target.');
    const runnablePaths = new Set(runnable.map(source => source.path)), claimsByPath = new Map<string, typeof claims>();
    for (const claim of claims) {
        if (!runnablePaths.has(claim.path)) throw new Error('Mapping names an undeclared task test target.');
        const prior = claimsByPath.get(claim.path);
        if (prior) prior.push(claim); else claimsByPath.set(claim.path, [claim]);
    }
    const invocations = descriptor.invocations.map((invocation, index) => {
        const tokens = [invocation.executable, ...invocation.argv];
        return { index, tokens, ...indexInvocationValues(tokens) };
    });
    const targets = runnable.flatMap(source => {
        const declared = claimsByPath.get(source.path) ?? [];
        return (declared.length ? declared : [undefined]).flatMap(claim => {
            const candidates = invocations.filter(item => claim?.invocation === undefined || item.index === claim.invocation);
            const matches = candidates.flatMap<TaskValidationTarget>(({ index, tokens, literals, associations }) => {
                const selector = claim?.selector ? literals.has(claim.selector) ? claim.selector : null
                    : indexedAssociation(associations, source.path);
                if (selector && !claim?.entrypoint) return [{ ...source, invocation: index, association: 'literal' as const, selector,
                    ...(claim?.reason ? { reason: claim.reason } : {}) }];
                if (claim?.entrypoint && tokens.includes(claim.entrypoint) && text(claim.reason))
                    return [{ ...source, invocation: index, association: 'symbolic' as const, selector: claim.entrypoint, reason: claim.reason }];
                return [];
            });
            if (matches.length) return matches;
            throw new Error(`Target '${source.path}' has no exact argv association. Include its path/stem/selector as a whole argument or list item, or declare its entrypoint and reason with --task-test-plan.`);
        });
    });
    const boundInvocations = new Set(targets.map(target => target.invocation));
    if (descriptor.invocations.some((_, index) => !boundInvocations.has(index)))
        throw new Error('Every declared command needs its own task test targets.');
    const support = supportClaims.map(claim => {
        const source = sourceMap.get(claim.path);
        if (!source || !['helper', 'fixture', 'runner', 'config'].includes(claim.role)
            || !Array.isArray(claim.targets) || !claim.targets.length
            || claim.targets.some((target: unknown) => typeof target !== 'string' || !runnablePaths.has(target)))
            throw new Error(`Support '${claim.path}' needs a role and a mapping to declared runnable targets.`);
        return { ...source, role: claim.role, targets: [...claim.targets] };
    });
    return { schema_version: 1, descriptor, targets, support, inputs: inputs.map(input => ({ ...input })),
        requires_semantic_review: targets.some(target => target.association === 'symbolic') };
}

/** Pure projection of authenticated retained facts; consumers never rediscover the stack. */
export function taskValidationProcessViolations(plan: TaskValidationPlan, value: unknown, expected: 'pass' | 'failure' = 'pass'): string[] {
    const refuse = (reason: string) => [`Task test process integrity: ${reason} Select current own tests and rerun full-suite-validation.`];
    if (plan.binding && (!text(plan.binding.workspace_root) || !Number.isFinite(Date.parse(plan.binding.selected_at))))
        return refuse('invalid selected worktree or selection chronology.');
    if (!isPlainRecord(value) || value.schema_version !== 1 || value.selection_sha256 !== validationDigest(plan)
        || !Array.isArray(value.invocations) || value.invocations.length !== plan.descriptor.invocations.length)
        return refuse('missing or mismatched selection/execution binding.');
    const ids = new Set<string>();
    let previousEnd = -Infinity;
    let failed = false;
    for (const [index, raw] of value.invocations.entries()) {
        const invocation = plan.descriptor.invocations[index];
        if (!isPlainRecord(raw) || raw.invocation !== index || !text(raw.execution_id) || ids.has(raw.execution_id)
            || raw.executable !== invocation.executable || !Array.isArray(raw.argv) || !raw.argv.every(item => typeof item === 'string')
            || validationDigest(raw.argv) !== validationDigest(invocation.argv)
            || !text(raw.cwd) || plan.binding && raw.cwd !== plan.binding.workspace_root
            || !hash(raw.output_sha256) || !hash(raw.scope_before) || raw.scope_before !== raw.scope_after)
            return refuse('damaged invocation, output or source scope binding.');
        const start = typeof raw.started_at === 'string' ? Date.parse(raw.started_at) : NaN;
        const end = typeof raw.completed_at === 'string' ? Date.parse(raw.completed_at) : NaN;
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < previousEnd || end < start
            || plan.binding && start < Date.parse(plan.binding.selected_at))
            return refuse('invalid execution chronology.');
        if (!Number.isInteger(raw.exit_code) || raw.timed_out !== false || raw.cancelled !== false)
            return refuse('a declared task command did not complete.');
        failed ||= raw.exit_code !== 0;
        if (expected === 'pass' && raw.exit_code !== 0) return refuse('a declared task command did not pass.');
        previousEnd = end; ids.add(raw.execution_id);
    }
    if (expected === 'failure' && !failed) return refuse('expected RED requires a genuine nonzero selected process exit.');
    return [];
}

/** A new selection may reuse an authenticated execution only while every input and task scope is identical. */
export function reusableTaskValidationPlan(current: TaskValidationPlan, retained: unknown,
    authenticatedTaskCycleRebind = false): TaskValidationPlan | undefined {
    if (!current.binding || !isPlainRecord(retained) || !isPlainRecord(retained.binding)
        || !hash(retained.binding.preflight_sha256)) return undefined;
    const identity = (plan: Record<string, unknown>, binding: Record<string, unknown>) => ({
        ...plan, binding: { ...binding, selected_at: undefined, preflight_sha256: undefined,
            ...(authenticatedTaskCycleRebind ? { task_mode_entry_sha256: undefined } : {}) }
    });
    return isDeepStrictEqual(identity(current as unknown as Record<string, unknown>, current.binding),
        identity(retained, retained.binding)) ? retained as unknown as TaskValidationPlan : undefined;
}
