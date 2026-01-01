import { readRecordedOutOfScopeFailures, type RecordedOutOfScopeFailure } from '../../../gates/full-suite/recorded-out-of-scope-failures';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseCommandChain } from '../../../core/command-line';
import { joinOrchestratorPath, normalizePath } from '../../../core/orchestrator-paths';
import { parseCanonicalActiveTaskQueue } from '../../../core/task-md-table';
import { isTaskQueueActiveStatus, resolveActiveTaskIds } from '../../../core/task-queue/active-task-state';
import { appendMandatoryTaskEvent, assertValidTaskId, inspectTaskEventFile, readTaskTimelineJsonlEntries, withTaskTimelineReadSnapshot } from '../../../gate-runtime/task-events';
import { stringSha256 } from '../../../gate-runtime/hash';
import { getTaskModeEvidence } from '../../../gates/task-mode/task-mode';
import { createInvocationReadMemoKey, memoizeInvocationRead, isInvocationReadObservationActive } from '../../../core/invocation-read-observation';
import { readInvocationPathObservation } from '../../../core/invocation-file-observation';
import { computeSnapshotFingerprint, createWorkspaceSnapshotRequest, readHeadSha } from '../../../gates/workspace/workspace-snapshot-cache';
import { findOtherActiveImplementationOwners, findUnapprovedActiveImplementationOwners } from '../../../gates/workspace/active-implementation-ownership';
import { inspectReviewerFocusedValidationCommand } from '../../../gates/review/review-findings-schema';
import { getClassificationConfig } from '../../../gates/preflight/classify-change-config';
import { isSafeOrdinaryDocumentationPath } from '../../../gates/preflight/classify-change-doc-safety';
import { buildScopeContentFingerprint } from '../../../gates/compile/compile-gate';
import { isTestScopePath } from '../../../core/file-role-bindings';
import { validateFullSuiteCommandContract } from '../gate-flows/full-suite/full-suite-command-contract';
import { readValidationFile } from '../../../core/project-validation-identity';
import { isPlainRecord } from '../../../core/records';
import { pathListSha256 } from '../../../gates/shared/canonical-path-list';
import { parseSplitCheckpointDetectionSource, resolveAuthenticatedSplitCheckpointPreflightScope } from '../../../gates/split-required/split-checkpoint-scope';
import { createTaskTestCommandContainerChecker } from '../../../gates/full-suite/task-test-command-inclusion';
import { getFullSuiteTestSelectionViolations } from '../../../gates/full-suite/full-suite-test-selection';
import type { ParsedOptionsRecord, WorkflowCommandRoots, WorkflowFileConfigData } from './workflow-command-types';

export interface TaskTestSelectionAuthority {
    schema_version: 1;
    origin: 'task_scoped_test_selection';
    decision_utc: string;
    task_id: string;
    workspace_root: string;
    workspace_fingerprint: string;
    head_sha: string;
    task_mode_entry_sha256: string;
    task_mode_artifact_sha256: string;
    preflight_sha256: string;
    preflight_scope: { scope_sha256: string; scope_content_sha256: string };
    changed_tests: string[];
    command: string;
    require_operator_confirmation: boolean;
    operator_confirmed_at_utc?: string;
    reason: string;
    targets: Array<{ path: string; sha256: string }>;
    recorded_out_of_scope_failures?: RecordedOutOfScopeFailure[];
}

function fail(reason: string): never {
    throw new Error(`Task-scoped test selection rejected: ${reason}`);
}

function canonicalTarget(value: string): string {
    const normalized = normalizePath(value);
    if (!normalized || path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)
        || normalized.split('/').some(part => part === '..' || part === '.')
        || /[\u0000-\u001f*?\[\]{}]/u.test(normalized)) {
        fail('test targets must be explicit repository-relative files without traversal or globs.');
    }
    return normalized;
}

function readTarget(root: string, target: string): { path: string; sha256: string } {
    // The contained-file reader already enforces links, identity and content, with
    // dependency revalidation at invocation exit. Reuse those observations.
    if (isInvocationReadObservationActive()) {
        try { return { path: target, sha256: readValidationFile(root, target).identity.sha256 }; }
        catch { return fail(`test target '${target}' must be an ordinary contained file without links.`); }
    }
    const absolute = path.join(root, target);
    let ordinary = false;
    try {
        const stat = fs.lstatSync(absolute);
        ordinary = stat.isFile() && stat.nlink === 1
            && path.relative(root, fs.realpathSync.native(absolute)) === path.normalize(target);
    } catch { /* Missing or inaccessible targets cannot authorize a selection. */ }
    if (!ordinary) {
        fail(`test target '${target}' must be an ordinary contained file without links.`);
    }
    const file = readValidationFile(root, target);
    return { path: target, sha256: file.identity.sha256 };
}

function readCurrentTask(roots: WorkflowCommandRoots, taskId: string, requireActive = true): {
    entryHash: string; artifactHash: string; plannedFiles: string[];
} {
    if (requireActive) {
    const queue = parseCanonicalActiveTaskQueue(fs.readFileSync(path.join(roots.targetRoot, 'TASK.md'), 'utf8'));
    const rows = queue.rows.filter(row => row.taskId === taskId);
    const activeIds = resolveActiveTaskIds(roots.targetRoot, roots.bundleRoot, [], {
        includeAmbiguousRuntimeTasks: false, includeStaleRuntimeActiveTasks: false
    });
    const owners = findOtherActiveImplementationOwners(roots.targetRoot, taskId);
    if (!queue.found || rows.length !== 1 || !isTaskQueueActiveStatus(rows[0].status)
        || !activeIds.has(taskId) || activeIds.size !== owners.length + 1
        || owners.some(owner => !activeIds.has(owner))) {
        fail('one current active task must match the canonical task queue and native runtime.');
    }
    if (findUnapprovedActiveImplementationOwners(roots.targetRoot, taskId).length) {
        fail('other active implementation owners require current task-specific approval and disjoint scopes.');
    }
    }
    const eventsRoot = path.join(roots.bundleRoot, 'runtime/task-events');
    const timeline = path.join(eventsRoot, `${taskId}.jsonl`);
    return withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
        if (inspectTaskEventFile(timeline, taskId).status !== 'PASS') fail('current native task timeline is missing or invalid.');
        const entries = readTaskTimelineJsonlEntries(timeline);
        const entry = [...entries].reverse().find(item => item.record?.event_type === 'TASK_MODE_ENTERED');
        const evidence = getTaskModeEvidence(roots.targetRoot, taskId);
        if (entry?.record?.outcome !== 'PASS' || evidence.evidence_status !== 'PASS'
            || evidence.identity_backfilled_from_legacy || !evidence.evidence_hash
            || !evidence.evidence_path) {
            fail('current resolved task-mode evidence is required.');
        }
        const artifactPath = path.join(roots.bundleRoot, 'runtime/reviews', `${taskId}-task-mode.json`);
        if (fs.realpathSync.native(evidence.evidence_path) !== fs.realpathSync.native(artifactPath)) {
            fail('task-mode evidence must belong to this worktree.');
        }
        const entryHash = stringSha256(entry.rawLine.trim());
        if (!entryHash) fail('current task entry hash is unavailable.');
        return { entryHash, artifactHash: evidence.evidence_hash,
            plannedFiles: evidence.planned_changed_files };
    });
}

/** Trust only the latest classified bytes in this task entry and an unchanged native scope. */
function readCurrentPreflight(roots: WorkflowCommandRoots, taskId: string, entryHash: string, allowDocsOnlyExtension = false): {
    hash: string; changedFiles: string[]; scope: TaskTestSelectionAuthority['preflight_scope'];
    classification?: ReturnType<typeof getClassificationConfig>;
} {
    const eventsRoot = path.join(roots.bundleRoot, 'runtime/task-events');
    const timeline = path.join(eventsRoot, `${taskId}.jsonl`);
    return withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
        if (inspectTaskEventFile(timeline, taskId).status !== 'PASS') fail('current native task timeline is missing or invalid.');
        const entries = readTaskTimelineJsonlEntries(timeline);
        let modeIndex = -1, classifiedIndex = -1;
        for (let index = entries.length - 1; index >= 0 && (modeIndex < 0 || classifiedIndex < 0); index -= 1) {
            if (modeIndex < 0 && entries[index].record?.event_type === 'TASK_MODE_ENTERED') modeIndex = index;
            if (classifiedIndex < 0 && entries[index].record?.event_type === 'PREFLIGHT_CLASSIFIED') classifiedIndex = index;
        }
        if (modeIndex < 0 || classifiedIndex <= modeIndex || stringSha256(entries[modeIndex].rawLine.trim()) !== entryHash) {
            fail('a current authenticated preflight for this task-mode cycle is required.');
        }
        const latestAttempt = [...entries.slice(classifiedIndex + 1)].reverse().find(item =>
            ['PREFLIGHT_STARTED', 'PREFLIGHT_FAILED', 'PREFLIGHT_EVIDENCE_RESTORED'].includes(String(item.record?.event_type)));
        if (latestAttempt && latestAttempt.record?.event_type !== 'PREFLIGHT_EVIDENCE_RESTORED') {
            fail('the latest preflight attempt is not classified; refresh preflight.');
        }
        const details = entries[classifiedIndex].record?.details;
        if (!isPlainRecord(details) || typeof details.output_path !== 'string'
            || typeof details.output_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(details.output_sha256)) {
            fail('the current preflight lacks an authenticated path and hash; refresh preflight.');
        }
        const relative = normalizePath(path.relative(roots.targetRoot, path.resolve(roots.targetRoot, details.output_path)));
        let file: ReturnType<typeof readValidationFile>;
        try { file = readValidationFile(roots.targetRoot, relative, 8 * 1024 * 1024); }
        catch { return fail('the current preflight is not a safe contained file.'); }
        if (file.identity.sha256 !== details.output_sha256
            || (latestAttempt && (!isPlainRecord(latestAttempt.record?.details)
                || latestAttempt.record.details.output_sha256 !== file.identity.sha256))) {
            fail('the current preflight hash does not match its authenticated timeline event.');
        }
        let preflight: unknown;
        try { preflight = JSON.parse(file.bytes.toString('utf8')); }
        catch { return fail('the current preflight is not valid JSON.'); }
        if (!isPlainRecord(preflight) || preflight.task_id !== taskId || !Array.isArray(preflight.changed_files)
            || !preflight.changed_files.every(filePath => typeof filePath === 'string') || !isPlainRecord(preflight.metrics)) {
            fail('the current preflight has invalid task or changed-file evidence.');
        }
        const changedFiles = preflight.changed_files as string[];
        const metrics = preflight.metrics;
        const source = typeof preflight.detection_source === 'string' ? preflight.detection_source : '';
        const split = parseSplitCheckpointDetectionSource(source);
        if (!['git_auto', 'explicit_changed_files', 'git_staged_only', 'git_staged_plus_untracked'].includes(source) && !split) {
            fail('the current preflight has an unsupported change detection source.');
        }
        if (split) resolveAuthenticatedSplitCheckpointPreflightScope(roots.targetRoot, taskId, source, changedFiles);
        const authorized = Array.isArray(preflight.authorized_files) && preflight.authorized_files.every(item => typeof item === 'string')
            ? preflight.authorized_files as string[] : changedFiles;
        const candidates = source === 'git_staged_only' || split ? [false]
            : typeof preflight.include_untracked === 'boolean' ? [preflight.include_untracked] : [true, false];
        const request = createWorkspaceSnapshotRequest(roots.targetRoot);
        let current: ReturnType<typeof request.read> | undefined;
        let classification: ReturnType<typeof getClassificationConfig> | undefined;
        for (const includeUntracked of candidates) {
            const snapshot = request.read(source, includeUntracked, authorized);
            if (snapshot.scope_sha256 === metrics.scope_sha256
                && snapshot.scope_content_sha256 === metrics.scope_content_sha256
                && snapshot.changed_files_sha256 === metrics.changed_files_sha256
                && snapshot.changed_lines_total === metrics.changed_lines_total
                && isDeepStrictEqual(snapshot.changed_files, changedFiles)) { current = snapshot; break; }
            // Existing decisions survive the same ordinary-docs extension that compile/review reuse
            // accepts. Reuse the snapshot's captured content observations; never admit executable,
            // test, config or removed scope, or use this exception to authorize a new selection.
            const added = allowDocsOnlyExtension && !split
                ? snapshot.changed_files.filter(file => !changedFiles.includes(file)) : [];
            if (added.length && changedFiles.every(file => snapshot.changed_files.includes(file))) {
                const docsClassification = classification ??= getClassificationConfig(roots.targetRoot);
                if (added.every(file => isSafeOrdinaryDocumentationPath(file, docsClassification))
                    && buildScopeContentFingerprint(roots.targetRoot, source, changedFiles) === metrics.scope_content_sha256) {
                    current = snapshot;
                    break;
                }
            }
        }
        if (!current || metrics.changed_files_sha256 !== pathListSha256(changedFiles)
            || details.scope_sha256 !== metrics.scope_sha256 || details.scope_content_sha256 !== metrics.scope_content_sha256) {
            fail('the authenticated preflight is stale for the current worktree; refresh preflight.');
        }
        if (!split && source.startsWith('git_staged_') && request.hasUnstagedChanges(changedFiles)) {
            fail('preflight files differ from the current worktree; refresh preflight.');
        }
        if (split && request.hasHeadChanges(changedFiles)) {
            fail('preflight files differ from the current worktree; refresh preflight.');
        }
        return { hash: file.identity.sha256, changedFiles, ...(classification ? { classification } : {}),
            scope: { scope_sha256: String(metrics.scope_sha256), scope_content_sha256: String(metrics.scope_content_sha256) } };
    });
}

function validateTargets(command: string, targets: string[], root: string, inspectConfiguration = true): void {
    const direct = validateFullSuiteCommandContract(command);
    if (!direct.supported) fail(direct.violation || 'unsupported direct argv command.');
    const tokens = parseCommandChain(command)[0];
    const containerIncludes = createTaskTestCommandContainerChecker(command, root, inspectConfiguration);
    for (const target of targets) {
        // The existing focused validator admits exactly one target. Validate each
        // member against the same argv, removing only the other declared targets.
        const singleTargetCommand = tokens.filter(token => {
            const normalized = normalizePath(token);
            return normalized === target || !targets.includes(normalized);
        }).map(token => JSON.stringify(token)).join(' ');
        const inspected = inspectReviewerFocusedValidationCommand(singleTargetCommand, root);
        if ((!inspected.syntax_supported || inspected.target !== target)
            && !containerIncludes(target)) {
            fail(`command must execute the declared test target '${target}' through a supported native validation runner. ${inspected.violations.join(' ')}`);
        }
    }
}

function validateRelevance(taskId: string, reason: string, targets: string[], taskFiles: string[]): void {
    if (reason.length < 20 || !reason.includes(taskId) || /<[^>]+>/u.test(reason)
        || !/\b(?:asserts|covers|exercises|guards|validates|verifies)\b/iu.test(reason)) {
        fail('--reason must explain which current task behavior the selected tests cover.');
    }
    for (const target of targets) {
        if (taskFiles.includes(target)) continue;
        const justified = reason.split(/[;\n]/u).some(clause => clause.includes(target)
            && taskFiles.some(file => clause.includes(file))
            && /\b(?:asserts|covers|exercises|guards|validates|verifies)\b/iu.test(clause));
        if (!justified) fail(`unchanged regression target '${target}' needs an explicit relationship to a declared or current changed task file in --reason.`);
    }
}

/** A failure stays unresolved until its original command passes or its authenticated outside finding is recorded. */
function unresolvedOutOfScopeCommand(roots: WorkflowCommandRoots, taskId: string): string | null {
    const timeline = path.join(roots.bundleRoot, 'runtime/task-events', `${taskId}.jsonl`);
    let blocked: string | null = null;
    let blockedEvent = '';
    for (const entry of readTaskTimelineJsonlEntries(timeline)) {
        const details = entry.record?.details;
        if (!isPlainRecord(details) || typeof details.command !== 'string') continue;
        if (entry.record?.event_type === 'FULL_SUITE_VALIDATION_FAILED' && details.out_of_scope_audit_verdict === 'BLOCKED') {
            blocked = details.command;
            blockedEvent = stringSha256(entry.rawLine.trim()) || '';
        } else if (['FULL_SUITE_VALIDATION_PASSED', 'FULL_SUITE_VALIDATION_WARNED'].includes(String(entry.record?.event_type))
            && details.command === blocked) blocked = null;
    }
    const recorded = readRecordedOutOfScopeFailures(roots.targetRoot, taskId);
    return blocked && recorded.some(record => record.failure_event_sha256 === blockedEvent) ? null : blocked;
}

export function resolveTaskTestSelectionAuthority(
    options: ParsedOptionsRecord, roots: WorkflowCommandRoots,
    current: WorkflowFileConfigData, next: WorkflowFileConfigData, requestedFields: readonly string[]
): TaskTestSelectionAuthority | null {
    const selectionRequested = ['taskId', 'taskTestSelectionReason', 'focusedRequiredTestPath']
        .some(key => options[key] !== undefined);
    if (!selectionRequested) return null;
    if (typeof options.taskId !== 'string' || typeof options.taskTestSelectionReason !== 'string'
        || (options.focusedRequiredTestPath !== undefined && !Array.isArray(options.focusedRequiredTestPath))) {
        fail('--task-id and --reason are required; a task-scoped override also requires --focused-required-test-path.');
    }
    if (requestedFields.length !== 1 || requestedFields[0] !== 'full_suite_validation.command'
        || options.mutationSource && options.mutationSource !== 'cli') {
        fail('only full_suite_validation.command may be requested through the CLI selector, including no-op setting requests.');
    }
    const root = fs.realpathSync.native(roots.targetRoot);
    if (root !== fs.realpathSync.native(process.cwd())
        || fs.realpathSync.native(roots.bundleRoot) !== fs.realpathSync.native(joinOrchestratorPath(root, ''))) {
        fail('target and bundle roots must be the current canonical worktree.');
    }
    if (current.full_suite_validation.enabled !== true || next.full_suite_validation.enabled !== true) {
        fail('the enabled test gate must be preserved.');
    }
    const taskId = assertValidTaskId(options.taskId);
    const targets = (options.focusedRequiredTestPath ?? []).map(canonicalTarget);
    if (new Set(targets).size !== targets.length) fail('duplicate test targets are not allowed.');
    const bound = readCurrentTask(roots, taskId);
    for (const target of targets) readTarget(root, target);
    const preflight = readCurrentPreflight(roots, taskId, bound.entryHash);
    const classification = getClassificationConfig(root);
    if (targets.some(target => !isTestScopePath(target, classification.test_trigger_regexes, classification.file_roles))) {
        fail('every selected target must be classified as a repository test.');
    }
    const reason = options.taskTestSelectionReason.trim();
    validateRelevance(taskId, reason, targets, [...new Set([...bound.plannedFiles, ...preflight.changedFiles])]);
    const changedTests = preflight.changedFiles.map(canonicalTarget)
        .filter(target => isTestScopePath(target, classification.test_trigger_regexes, classification.file_roles)
            && fs.existsSync(path.join(root, target))).sort();
    // A repeated selection cannot erase regression coverage while a run is failing.
    // Carry every target from failed selections until that command actually passes.
    const entries = readTaskTimelineJsonlEntries(path.join(roots.bundleRoot, 'runtime/task-events', `${taskId}.jsonl`));
    const requiredByCommand = new Map<string, string[]>();
    let selected: TaskTestSelectionAuthority | null = null;
    for (const entry of entries) {
        const details = entry.record?.details;
        if (!isPlainRecord(details)) continue;
        if (entry.record?.event_type === 'TASK_TEST_SELECTION_RECORDED' && isPlainRecord(details.task_test_selection_authority)) {
            selected = details.task_test_selection_authority as unknown as TaskTestSelectionAuthority;
        } else if (entry.record?.event_type === 'FULL_SUITE_VALIDATION_FAILED' && typeof details.command === 'string') {
            requiredByCommand.set(details.command, [...new Set([...(requiredByCommand.get(details.command) ?? []),
                ...(selected?.targets?.map(target => target.path) ?? [])])]);
        } else if (['FULL_SUITE_VALIDATION_PASSED', 'FULL_SUITE_VALIDATION_WARNED'].includes(String(entry.record?.event_type))
            && typeof details.command === 'string') requiredByCommand.delete(details.command);
    }
    const requiredTargets = [...new Set([...requiredByCommand.values()].flat())];
    const allTargets = [...new Set([...targets, ...changedTests, ...requiredTargets])];
    for (const target of allTargets) readTarget(root, target);
    const command = next.full_suite_validation.command;
    const retargetedRequirements = [...new Set([...requiredByCommand]
        .filter(([failedCommand]) => failedCommand !== command).flatMap(([, required]) => required))];
    try { validateTargets(command, retargetedRequirements, root); }
    catch { fail('an unresolved in-scope failing test cannot be dropped by narrowing.'); }
    const blockedCommand = unresolvedOutOfScopeCommand(roots, taskId);
    let recordedFailures = readRecordedOutOfScopeFailures(root, taskId);
    if (blockedCommand && command !== blockedCommand) {
        const entries = readTaskTimelineJsonlEntries(path.join(roots.bundleRoot, 'runtime/task-events', `${taskId}.jsonl`));
        const failure = [...entries].reverse().find(entry => entry.record?.event_type === 'FULL_SUITE_VALIDATION_FAILED'
            && isPlainRecord(entry.record.details) && entry.record.details.command === blockedCommand);
        const details = failure?.record?.details;
        if (failure?.record?.actor !== 'gate' || failure.record.outcome !== 'FAIL'
            || !isPlainRecord(details) || !Array.isArray(details.out_of_scope_failure_refs)
            || !details.out_of_scope_failure_refs.length || typeof details.artifact_path !== 'string') {
            fail(`the unresolved failure of '${blockedCommand}' has no authenticated out-of-scope failure references `
                + '(for example it was recorded by an older Garda), so narrowing cannot prove that only unrelated tests are dropped. '
                + `Select '${blockedCommand}' again for this task and rerun full-suite-validation through next-step: the current run `
                + 'records which failures are outside the task, after which a narrowed selection is accepted and those failures '
                + 'go to the grouped follow-up task. Use repair or approved scope widening only for failures inside the task.');
        }
        const failureIndex = entries.indexOf(failure!);
        const cycle = [...entries.slice(0, failureIndex)].reverse().find(entry => entry.record?.event_type === 'TASK_MODE_ENTERED');
        if (!cycle || stringSha256(cycle.rawLine.trim()) !== bound.entryHash) fail('AUDIT_AND_BLOCK unresolved failure belongs to another task cycle.');
        const previous = [...entries.slice(0, failureIndex)].reverse().find(entry => entry.record?.event_type === 'TASK_TEST_SELECTION_RECORDED');
        const previousDetails = previous?.record?.details;
        const previousAuthority = isPlainRecord(previousDetails) ? previousDetails.task_test_selection_authority : null;
        const previousTargets = isPlainRecord(previousAuthority) && Array.isArray(previousAuthority.targets)
            ? previousAuthority.targets.flatMap(target => isPlainRecord(target) && typeof target.path === 'string' ? [target.path] : []) : [];
        const scopeKey = (file: string) => process.platform === 'win32' ? normalizePath(file).toLowerCase() : normalizePath(file);
        const protectedTests = new Set([...bound.plannedFiles, ...preflight.changedFiles, ...previousTargets].map(scopeKey));
        const refs = details.out_of_scope_failure_refs.map(String);
        if (refs.some(ref => protectedTests.has(scopeKey(ref)))) fail('an in-scope failing test cannot be dropped by narrowing.');
        // Explicit regression relationships survive narrowing as well as current changed tests.
        validateTargets(command, [...new Set([...allTargets, ...previousTargets])], root);
        const artifactFile = readValidationFile(root, normalizePath(path.relative(root, details.artifact_path)), 8 * 1024 * 1024);
        if (artifactFile.identity.sha256 !== details.artifact_sha256) fail('the failed full-suite artifact differs from its authenticated event.');
        const artifact: unknown = JSON.parse(artifactFile.bytes.toString('utf8'));
        if (!isPlainRecord(artifact) || artifact.status !== 'FAILED' || !isPlainRecord(artifact.cycle_binding) || artifact.cycle_binding.task_id !== taskId || artifact.command !== blockedCommand
            || artifact.out_of_scope_audit_verdict !== 'BLOCKED'
            || !isDeepStrictEqual(artifact.out_of_scope_failure_refs, refs)) fail('invalid failed full-suite artifact binding.');
        recordedFailures = [...recordedFailures, { task_id: taskId, task_mode_entry_sha256: bound.entryHash,
            failure_event_sha256: stringSha256(failure!.rawLine.trim())!, command: blockedCommand,
            failing_tests: refs, artifact_path: details.artifact_path, artifact_sha256: artifactFile.identity.sha256, artifact }];
    }
    if (!blockedCommand) {
        const entries = readTaskTimelineJsonlEntries(path.join(roots.bundleRoot, 'runtime/task-events', `${taskId}.jsonl`));
        const latest = [...entries].reverse().find(entry => ['FULL_SUITE_VALIDATION_FAILED', 'FULL_SUITE_VALIDATION_PASSED',
            'FULL_SUITE_VALIDATION_WARNED'].includes(String(entry.record?.event_type)));
        if (latest?.record?.event_type === 'FULL_SUITE_VALIDATION_FAILED') {
            const previous = [...entries.slice(0, entries.indexOf(latest))].reverse()
                .find(entry => entry.record?.event_type === 'TASK_TEST_SELECTION_RECORDED');
            const previousDetails = previous?.record?.details;
            const previousAuthority = isPlainRecord(previousDetails) ? previousDetails.task_test_selection_authority : null;
            if (isPlainRecord(previousAuthority) && previousAuthority.command !== command && Array.isArray(previousAuthority.targets)) {
                const protectedTargets = previousAuthority.targets.flatMap(target => isPlainRecord(target) && typeof target.path === 'string' ? [target.path] : []);
                try { validateTargets(command, protectedTargets, root); }
                catch { fail('an unresolved in-scope failing test cannot be dropped by narrowing.'); }
            }
        }
    }
    const direct = validateFullSuiteCommandContract(command);
    if (!direct.supported) fail(direct.violation || 'unsupported direct argv command.');
    const violations = getFullSuiteTestSelectionViolations(root, command, preflight.changedFiles);
    if (violations.length) fail(violations.join(' '));
    if (command !== current.full_suite_validation.command) {
        if (!targets.length) fail('a task-scoped override requires at least one --focused-required-test-path.');
        validateTargets(command, allTargets, root);
    }
    const workspace = computeSnapshotFingerprint(root, 'explicit_changed_files', true, allTargets);
    if (!workspace.headSha) fail('a real Git worktree is required.');
    return { schema_version: 1, origin: 'task_scoped_test_selection', decision_utc: new Date().toISOString(),
        task_id: taskId, workspace_root: root, workspace_fingerprint: workspace.fingerprint, head_sha: workspace.headSha,
        task_mode_entry_sha256: bound.entryHash, task_mode_artifact_sha256: bound.artifactHash,
        preflight_sha256: preflight.hash, preflight_scope: preflight.scope, changed_tests: changedTests, command,
        require_operator_confirmation: current.task_test_selection?.require_operator_confirmation === true,
        reason, targets: allTargets.map(target => readTarget(root, target)),
        ...(recordedFailures.length ? { recorded_out_of_scope_failures: recordedFailures } : {}) };
}

export function assertTaskTestSelectionCurrent(roots: WorkflowCommandRoots, authority: TaskTestSelectionAuthority): void {
    const current = readCurrentTask(roots, authority.task_id);
    const preflight = readCurrentPreflight(roots, authority.task_id, current.entryHash);
    const workspace = computeSnapshotFingerprint(roots.targetRoot, 'explicit_changed_files', true, authority.targets.map(target => target.path));
    if (current.entryHash !== authority.task_mode_entry_sha256 || current.artifactHash !== authority.task_mode_artifact_sha256
        || preflight.hash !== authority.preflight_sha256
        || workspace.fingerprint !== authority.workspace_fingerprint || workspace.headSha !== authority.head_sha
        || !isDeepStrictEqual(authority.targets.map(target => readTarget(roots.targetRoot, target.path)), authority.targets)) {
        fail('task cycle, worktree or test target content changed before publication.');
    }
}

/** The integrity-protected task event is both the audit record and the stored decision. */
export function publishTaskTestSelection(roots: WorkflowCommandRoots, authority: TaskTestSelectionAuthority): string {
    assertTaskTestSelectionCurrent(roots, authority);
    appendMandatoryTaskEvent(roots.bundleRoot, authority.task_id, 'TASK_TEST_SELECTION_RECORDED', 'PASS',
        'Task-scoped full-suite test command selected.', { task_test_selection_authority: authority },
        { actor: 'task-selection-command', validateBeforeCanonicalAppend: () => assertTaskTestSelectionCurrent(roots, authority) });
    return path.join(roots.bundleRoot, 'runtime/task-events', `${authority.task_id}.jsonl`);
}

export interface CurrentTaskTestSelection {
    status: 'missing' | 'current' | 'stale';
    command: string | null;
    targets: string[];
    /** Authenticated decision for recording an already-finished review of this exact preflight. */
    reviewedPreflight?: { sha256: string; command: string; targets: string[] };
}

const TASK_TEST_SELECTION_READ = createInvocationReadMemoKey<CurrentTaskTestSelection>('task-test-selection');

export function readTaskTestSelection(roots: WorkflowCommandRoots, taskId: string): CurrentTaskTestSelection {
    const current = memoizeInvocationRead(TASK_TEST_SELECTION_READ, JSON.stringify([roots, taskId]),
        () => readTaskTestSelectionUncached(roots, taskId)).value;
    return { ...current, targets: [...current.targets], ...(current.reviewedPreflight ? {
        reviewedPreflight: { ...current.reviewedPreflight, targets: [...current.reviewedPreflight.targets] }
    } : {}) };
}

function readTaskTestSelectionUncached(roots: WorkflowCommandRoots, taskId: string): CurrentTaskTestSelection {
    const missing: CurrentTaskTestSelection = { status: 'missing', command: null, targets: [] };
    let staleTargets: string[] = [];
    let reviewedPreflight: CurrentTaskTestSelection['reviewedPreflight'];
    if (!taskId) return missing;
    try {
        assertValidTaskId(taskId);
        const eventsRoot = path.join(roots.bundleRoot, 'runtime/task-events');
        const timeline = path.join(eventsRoot, `${taskId}.jsonl`);
        return withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
            const entries = readTaskTimelineJsonlEntries(timeline);
            const entry = [...entries].reverse().find(item => item.record?.event_type === 'TASK_TEST_SELECTION_RECORDED');
            if (!entry) return missing;
            const details = entry.record?.details;
            const candidate = isPlainRecord(details) ? details.task_test_selection_authority : null;
            const stale: CurrentTaskTestSelection = { status: 'stale', command: null, targets: [] };
            if (inspectTaskEventFile(timeline, taskId).status !== 'PASS' || entry.record?.outcome !== 'PASS'
                || entry.record.actor !== 'task-selection-command'
                || !isPlainRecord(candidate) || candidate.schema_version !== 1
                || candidate.origin !== 'task_scoped_test_selection' || candidate.task_id !== taskId
                || typeof candidate.command !== 'string' || !candidate.command.trim()
                || typeof candidate.preflight_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(candidate.preflight_sha256)
                || typeof candidate.require_operator_confirmation !== 'boolean'
                || !Array.isArray(candidate.changed_tests) || !candidate.changed_tests.every(item => typeof item === 'string')
                || !Array.isArray(candidate.targets) || !candidate.targets.every(item => isPlainRecord(item)
                    && typeof item.path === 'string' && typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(item.sha256))) return stale;
            const authority = candidate as unknown as TaskTestSelectionAuthority;
            stale.targets = authority.targets.map(target => target.path);
            staleTargets = stale.targets;
            if (authority.workspace_root !== fs.realpathSync.native(roots.targetRoot)
                || (authority.require_operator_confirmation === true && !authority.operator_confirmed_at_utc)) return stale;
            const current = readCurrentTask(roots, taskId, false);
            if (current.entryHash !== authority.task_mode_entry_sha256 || current.artifactHash !== authority.task_mode_artifact_sha256
                || readHeadSha(roots.targetRoot) !== authority.head_sha) return stale;
            // A later edit expires execution authority, but does not erase the decision on the tree a
            // completed reviewer saw. Keep its signed preflight pin without additional filesystem reads.
            reviewedPreflight = { sha256: authority.preflight_sha256, command: authority.command, targets: [...stale.targets] };
            stale.reviewedPreflight = reviewedPreflight;
            if (!isDeepStrictEqual(authority.targets.map(target => readTarget(roots.targetRoot, target.path)), authority.targets)) return stale;
            const preflight = readCurrentPreflight(roots, taskId, current.entryHash, true);
            if (preflight.hash !== authority.preflight_sha256
                && !isDeepStrictEqual(preflight.scope, authority.preflight_scope)) return stale;
            const classification = preflight.classification ?? getClassificationConfig(roots.targetRoot);
            const changedTests = preflight.changedFiles.map(canonicalTarget)
                .filter(target => isTestScopePath(target, classification.test_trigger_regexes, classification.file_roles)
                    && (() => {
                        const absolute = path.join(roots.targetRoot, target);
                        const observed = readInvocationPathObservation(absolute);
                        return observed ? 'value' in observed.targetStat : fs.existsSync(absolute);
                    })()).sort();
            const workspace = computeSnapshotFingerprint(roots.targetRoot, 'explicit_changed_files', true, stale.targets);
            if (current.entryHash !== authority.task_mode_entry_sha256 || current.artifactHash !== authority.task_mode_artifact_sha256
                || readHeadSha(roots.targetRoot) !== authority.head_sha
                || !isDeepStrictEqual(changedTests, authority.changed_tests)
                || workspace.fingerprint !== authority.workspace_fingerprint || workspace.headSha !== authority.head_sha
                || !isDeepStrictEqual(authority.targets.map(target => readTarget(roots.targetRoot, target.path)), authority.targets)) return stale;
            const config = JSON.parse(readValidationFile(roots.targetRoot,
                normalizePath(path.relative(roots.targetRoot, roots.configPath))).bytes.toString('utf8')) as WorkflowFileConfigData;
            const blockedCommand = unresolvedOutOfScopeCommand(roots, taskId);
            if (blockedCommand && authority.command !== blockedCommand) return stale;
            if (getFullSuiteTestSelectionViolations(roots.targetRoot, authority.command, preflight.changedFiles).length) return stale;
            if (authority.command !== config.full_suite_validation.command) {
                validateTargets(authority.command, [...new Set([...stale.targets, ...changedTests])], roots.targetRoot, false);
            }
            return { status: 'current', command: authority.command, targets: stale.targets };
        });
    } catch { return { status: 'stale', command: null, targets: staleTargets, ...(reviewedPreflight ? { reviewedPreflight } : {}) }; }
}
