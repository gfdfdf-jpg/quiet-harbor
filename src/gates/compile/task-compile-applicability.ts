import type { GitChangeClassificationEvidence } from '../../core/git-change-classification';
import { isSafeOrdinaryDocumentationPath } from '../preflight/classify-change-doc-safety';
import { resolveReviewReuseClassificationConfig } from '../review-reuse/review-reuse';

export interface TaskCompileApplicability {
    kind: 'applicable' | 'not_applicable';
    reason: string;
}

/** Producer-time decision over the existing scope snapshot; never trust the profile name.
 * The caller must still enforce preflight freshness, scope drift and prior compile failures. */
export function taskCompileApplicability(options: {
    repoRoot: string;
    preflight: Record<string, unknown>;
    changedFiles: readonly string[];
    gitChangeClassification: GitChangeClassificationEvidence | null;
}): TaskCompileApplicability {
    const config = resolveReviewReuseClassificationConfig(options.preflight, options.repoRoot);
    // A source/config renamed to a document still changes executable/configuration scope.
    const files = [...options.changedFiles, ...options.gitChangeClassification?.file_classifications
        .flatMap(change => change.previous_path ? [change.path, change.previous_path] : [change.path]) ?? []];
    const docsOnly = files.length > 0 && files.every(file => isSafeOrdinaryDocumentationPath(file, config));
    return docsOnly
        ? { kind: 'not_applicable', reason: 'Only safe ordinary documentation changed; this task has no compilation inputs.' }
        : { kind: 'applicable', reason: 'The task scope is empty or includes files other than safe ordinary documentation.' };
}
