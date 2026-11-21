import { readReviewValidationBytes, readQualityArtifactStat, readReviewValidationNode } from './review-validation-invocation';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readInvocationPathObservation } from '../../core/invocation-file-observation';
import { createInvocationReadMemoKey } from '../../core/invocation-read-observation';
import { stringSha256 } from '../../gate-runtime/hash';
import { isPathRealpathInsideRoot } from '../shared/helpers';

export interface ReviewTaskCard {
    path: string;
    sha256: string;
    section: string;
    acceptance_criteria: string[];
}

const TASK_CARD = createInvocationReadMemoKey<ReviewTaskCard | null>('review-task-card');

/** Only explicit task-id links in TASK.md may supply a local task card. */
export function readReviewTaskCard(repoRoot: string, taskId: string | null): ReviewTaskCard | null {
    if (!taskId) return null;
    return readReviewValidationNode(TASK_CARD, () => [path.resolve(repoRoot), taskId],
        () => readReviewTaskCardUncached(repoRoot, taskId));
}

function readReviewTaskCardUncached(repoRoot: string, taskId: string): ReviewTaskCard | null {
    const queue = path.join(repoRoot, 'TASK.md');
    // Bind absence too, and reuse an observed regular file instead of probing it a second time.
    const observed = readInvocationPathObservation(queue);
    const observedRegular = observed && 'value' in observed.stat && observed.stat.value.isFile()
        && 'value' in observed.targetStat && observed.targetStat.value.isFile();
    if (!observedRegular && !fs.existsSync(queue)) return null;
    const links = [...readReviewValidationBytes(queue).toString('utf8').matchAll(/\[([^\]]+)\]\(([^)]+)\)/gu)]
        .filter(match => match[1] === taskId).map(match => match[2]);
    const targets = [...new Set(links)];
    if (!targets.length) return null;
    if (targets.length !== 1) throw new Error('Ambiguous linked task card for ' + taskId);
    const [linkedPath, anchor] = targets[0].split('#');
    const relative = linkedPath || 'TASK.md';
    if (!/\.md$/iu.test(relative) || relative.split(/[\\/]/u).some(part => part === '.git' || part === '.aws') || !anchor || !/^[a-z0-9-]+$/iu.test(anchor) || path.isAbsolute(relative)
        || path.win32.isAbsolute(relative) || relative.includes(':') || relative.split(/[\\/]/u).includes('..'))
        throw new Error('Unsafe linked task card for ' + taskId);
    const file = path.resolve(repoRoot, relative);
    if (!isPathRealpathInsideRoot(file, repoRoot) || readQualityArtifactStat(file).size > 256 * 1024)
        throw new Error('Missing, external or oversized linked task card for ' + taskId);
    const bytes = readReviewValidationBytes(file).toString('utf8');
    const lines = bytes.split(/\r\n?|\n/u);
    const starts = lines.flatMap((line, index) => {
        const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
        if (!heading) return [];
        const slug = heading[2].toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /gu, '-');
        const explicit = index > 0 && lines[index - 1].includes('id="' + anchor + '"');
        const idHeading = heading[2] === taskId || heading[2].startsWith(taskId + ' ') || heading[2].startsWith(taskId + ' —');
        return (slug === anchor || explicit || (anchor === taskId.toLowerCase() && idHeading))
            ? [{ index, depth: heading[1].length }] : [];
    });
    if (starts.length !== 1) throw new Error('Missing or ambiguous task-card section for ' + taskId);
    const start = starts[0]; let end = lines.length;
    for (let i = start.index + 1; i < lines.length; i++) {
        const heading = /^(#{1,6})\s/u.exec(lines[i]);
        if (heading && heading[1].length <= start.depth) { end = i; break; }
    }
    const section = lines.slice(start.index, end).join('\n');
    const acceptance: string[] = []; let inAcceptance = false;
    for (const line of lines.slice(start.index + 1, end)) {
        if (/^#{1,6}\s/u.test(line)) inAcceptance = /acceptance criteria/iu.test(line);
        else if (inAcceptance && /^\s*[-*]\s+/u.test(line)) acceptance.push(line.replace(/^\s*[-*]\s+/u, '').trim());
    }
    return { path: relative.replace(/\\/gu, '/'), sha256: stringSha256(section)!, section, acceptance_criteria: acceptance };
}
