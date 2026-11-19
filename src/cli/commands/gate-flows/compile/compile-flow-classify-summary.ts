import * as fs from 'node:fs';
import { createHash } from 'node:crypto';

/** Maximum number of warning lines the console summary repeats; the artifact keeps every warning. */
const MAX_SUMMARY_WARNINGS = 5;
/** Maximum characters of one warning line in the console summary. */
const MAX_SUMMARY_WARNING_CHARS = 320;

function readRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readText(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readTextList(value: unknown): string[] {
    return Array.isArray(value) ? value.map(readText).filter((entry): entry is string => entry !== null) : [];
}

function clip(text: string): string {
    const singleLine = text.replace(/\s+/gu, ' ').trim();
    return singleLine.length > MAX_SUMMARY_WARNING_CHARS
        ? `${singleLine.slice(0, MAX_SUMMARY_WARNING_CHARS - 3)}...`
        : singleLine;
}

function collectWarnings(preflight: Record<string, unknown>): string[] {
    const triggers = readRecord(preflight.triggers);
    const optionalSkills = readRecord(preflight.optional_skill_selection);
    const warnings = [
        readText(preflight.isolation_mode_violation),
        readText(triggers?.isolation_mode_pre_task_warning),
        ...readTextList(preflight.workspace_hygiene_warnings),
        readText(optionalSkills?.warning)
    ].filter((entry): entry is string => entry !== null);
    return [...new Set(warnings)];
}

function formatRequiredReviews(preflight: Record<string, unknown>): string {
    const snapshot = readRecord(preflight.effective_review_snapshot);
    const snapshotIds = readTextList(snapshot?.required_review_ids);
    if (snapshotIds.length) return snapshotIds.join(', ');
    const required = readRecord(preflight.required_reviews);
    const ids = required ? Object.keys(required).filter((key) => required[key] === true) : [];
    return ids.length ? ids.join(', ') : 'none';
}

function formatDepth(preflight: Record<string, unknown>): string | null {
    const depth = readRecord(preflight.depth_escalation);
    if (!depth || depth.requested_depth === undefined || depth.effective_depth === undefined) return null;
    const reason = depth.escalated === true ? readText(depth.escalation_reason) : null;
    return `requested ${String(depth.requested_depth)}, effective ${String(depth.effective_depth)}`
        + (depth.escalated === true ? ` (escalated${reason ? `: ${clip(reason)}` : ''})` : '');
}

function readArtifactSha256(preflightPath: string): string | null {
    try {
        return createHash('sha256').update(fs.readFileSync(preflightPath)).digest('hex');
    } catch {
        return null;
    }
}

/**
 * Console summary of a successful classify-change run. The preflight artifact stays the
 * authoritative record; this text names it with its hash and repeats only what the agent acts on.
 * Without a written artifact the full JSON is the only copy of the result, so it is printed as is.
 */
export function formatClassifyChangeConsoleOutput(outputText: string, preflightPath: string | null): string {
    const artifactSha256 = preflightPath ? readArtifactSha256(preflightPath) : null;
    if (!preflightPath || !artifactSha256) return outputText;
    let preflight: Record<string, unknown> | null;
    try {
        preflight = readRecord(JSON.parse(outputText));
    } catch {
        preflight = null;
    }
    if (!preflight) return outputText;
    const lines = ['CLASSIFY_CHANGE_PASSED'];
    const taskId = readText(preflight.task_id);
    if (taskId) lines.push(`Task: ${taskId}`);
    lines.push(`Mode: ${readText(preflight.mode) ?? 'unknown'}`);
    const reasons = readTextList(preflight.scope_category_reasons);
    lines.push(`ScopeCategory: ${readText(preflight.scope_category) ?? 'unknown'}${reasons.length ? ` (${reasons.join(', ')})` : ''}`);
    const changedFiles = Array.isArray(preflight.changed_files) ? preflight.changed_files.length : 0;
    lines.push(`ChangedFiles: ${changedFiles}`);
    lines.push(`RequiredReviews: ${formatRequiredReviews(preflight)}`);
    const reviewPolicy = readText(readRecord(preflight.review_execution_policy)?.mode);
    if (reviewPolicy) lines.push(`ReviewExecutionPolicy: ${reviewPolicy}`);
    const optionalSkills = readText(readRecord(preflight.optional_skill_selection)?.visible_summary_line);
    if (optionalSkills) lines.push(`OptionalSkillSelection: ${clip(optionalSkills)}`);
    const depth = formatDepth(preflight);
    if (depth) lines.push(`Depth: ${depth}`);
    const zeroDiff = readRecord(preflight.zero_diff_guard);
    if (zeroDiff) {
        lines.push(`ZeroDiff: ${readText(zeroDiff.status) ?? 'unknown'}`
            + (zeroDiff.completion_requires_audited_no_op === true ? ' (completion requires an audited no-op)' : ''));
    }
    const warnings = collectWarnings(preflight);
    for (const warning of warnings.slice(0, MAX_SUMMARY_WARNINGS)) lines.push(`Warning: ${clip(warning)}`);
    if (warnings.length > MAX_SUMMARY_WARNINGS) {
        lines.push(`Warning: ${warnings.length - MAX_SUMMARY_WARNINGS} more warning(s) are recorded in the preflight artifact.`);
    }
    lines.push(`PreflightPath: ${preflightPath.replace(/\\/gu, '/')}`);
    lines.push(`PreflightSha256: ${artifactSha256}`);
    lines.push('FullPreflight: read PreflightPath (classify-change --as-json prints the full JSON instead of this summary).');
    return `${lines.join('\n')}\n`;
}
