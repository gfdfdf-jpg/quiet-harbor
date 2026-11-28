import * as fs from 'node:fs';
import * as path from 'node:path';
import { readGroupedCompletionForCloseout } from '../../../../gates/review/review-follow-up-lineage';
import * as gateHelpers from '../../../../gates/shared/helpers';
import {
    buildCompactLatestCycleTaskEventsSummary,
    buildTaskEventsSummary,
    formatTaskEventsSummaryText
} from '../../../../gates/task-events-summary/task-events-summary';
import {
    buildTaskAuditSummary,
    formatTaskAuditSummaryText,
    synchronizeFinalCloseoutArtifacts
} from '../../../../gates/task-audit/task-audit-summary';
import { EXIT_GATE_FAILURE } from '../../../exit-codes';
import {
    normalizePathValue,
    ensureDirectoryExists,
    parseRequiredText
} from '../../cli-helpers';
import { requireResolvedPath } from '../../shared-command-utils';

export interface TaskEventsSummaryCommandOptions {
    taskId?: unknown;
    repoRoot?: unknown;
    eventsRoot?: unknown;
    reviewsRoot?: unknown;
    outputPath?: unknown;
    asJson?: unknown;
    includeDetails?: unknown;
    compactLatestCycle?: unknown;
}

export interface TaskEventsSummaryCommandResult {
    rendered: string;
}

export interface TaskAuditSummaryCommandOptions {
    taskId?: unknown;
    preflightPath?: unknown;
    repoRoot?: unknown;
    eventsRoot?: unknown;
    reviewsRoot?: unknown;
    outputPath?: unknown;
    asJson?: unknown;
}

export interface TaskAuditSummaryCommandResult {
    rendered: string;
    exitCode: number;
}

export function runTaskEventsSummaryCommand(
    options: TaskEventsSummaryCommandOptions
): TaskEventsSummaryCommandResult {
    const repoRoot = normalizePathValue(options.repoRoot || '.');
    ensureDirectoryExists(repoRoot, 'Repo root');
    const eventsRoot = options.eventsRoot
        ? requireResolvedPath(
            gateHelpers.resolvePathInsideRepo(String(options.eventsRoot), repoRoot, { allowMissing: true }),
            'EventsRoot'
        )
        : gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events'));
    const reviewsRoot = options.reviewsRoot
        ? requireResolvedPath(
            gateHelpers.resolvePathInsideRepo(String(options.reviewsRoot), repoRoot, { allowMissing: true }),
            'ReviewsRoot'
        )
        : gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
    const summary = buildTaskEventsSummary({
        taskId: parseRequiredText(options.taskId, 'TaskId'),
        eventsRoot,
        repoRoot,
        reviewsRoot
    });
    const outputSummary = options.compactLatestCycle === true
        ? buildCompactLatestCycleTaskEventsSummary(summary)
        : summary;
    const rendered = options.asJson === true || options.compactLatestCycle === true
        ? `${JSON.stringify(outputSummary, null, 2)}\n`
        : `${formatTaskEventsSummaryText(summary, options.includeDetails === true)}\n`;
    if (options.outputPath) {
        const outputPath = requireResolvedPath(
            gateHelpers.resolvePathInsideRepo(String(options.outputPath), repoRoot, { allowMissing: true }),
            'OutputPath'
        );
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, rendered, 'utf8');
    }
    return { rendered };
}

export function usesCanonicalTaskAuditEvidence(
    repoRoot: string, taskId: string, options: TaskAuditSummaryCommandOptions
): boolean {
    const matches = (value: unknown, expected: string) =>
        !value || path.resolve(repoRoot, String(value)) === path.resolve(expected);
    const eventsRoot = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events'));
    const reviewsRoot = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
    return matches(options.eventsRoot, eventsRoot)
        && matches(options.reviewsRoot, reviewsRoot)
        && matches(options.preflightPath, path.join(reviewsRoot, `${taskId}-preflight.json`));
}

export function runTaskAuditSummaryCommand(
    options: TaskAuditSummaryCommandOptions, closeoutAlreadyPublished = false
): TaskAuditSummaryCommandResult {
    const repoRoot = normalizePathValue(options.repoRoot || '.');
    ensureDirectoryExists(repoRoot, 'Repo root');
    const taskId = parseRequiredText(options.taskId, 'TaskId');
    const canonical = usesCanonicalTaskAuditEvidence(repoRoot, taskId, options);
    if (!canonical && options.outputPath) {
        throw new Error('An audit using alternate evidence is read-only. Omit --output-path to inspect it.');
    }
    const auditSummary = buildTaskAuditSummary({
        taskId,
        repoRoot,
        eventsRoot: options.eventsRoot ? String(options.eventsRoot) : null,
        reviewsRoot: options.reviewsRoot ? String(options.reviewsRoot) : null
    });
    const canonicalEventsRoot = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events'));
    const groupedCloseout = canonical && readGroupedCompletionForCloseout(canonicalEventsRoot, taskId);
    if (canonical && !closeoutAlreadyPublished && !groupedCloseout) synchronizeFinalCloseoutArtifacts(auditSummary);
    const rendered = options.asJson === true
        ? `${JSON.stringify(auditSummary, null, 2)}\n`
        : `${formatTaskAuditSummaryText(auditSummary)}\n`;
    if (options.outputPath) {
        const outputPath = requireResolvedPath(
            gateHelpers.resolvePathInsideRepo(String(options.outputPath), repoRoot, { allowMissing: true }),
            'OutputPath'
        );
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, rendered, 'utf8');
    }
    return {
        rendered,
        exitCode: auditSummary.status !== 'PASS' ? EXIT_GATE_FAILURE : 0
    };
}
