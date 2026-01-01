import type { WalkEdit } from './navigator-walk';

/** Each failed review chooses its own repair, instead of repeating one repair kind for the whole task. */
export interface WalkRemediationStep {
    reviewType: string;
    attempt: number;
    edits: readonly WalkEdit[];
}

interface RemediationScript {
    fix?: readonly WalkEdit[];
    remediationSequence?: readonly WalkRemediationStep[];
}

export function resolveWalkReviewFix(script: RemediationScript, reviewType: string, attempt: number): readonly WalkEdit[] | undefined {
    if (!script.remediationSequence) return script.fix;
    const seen = new Set<string>();
    for (const repair of script.remediationSequence) {
        const key = JSON.stringify([repair.reviewType, repair.attempt]);
        if (!repair.reviewType || !Number.isSafeInteger(repair.attempt) || repair.attempt < 1 || !Array.isArray(repair.edits))
            throw new Error('Invalid scripted review remediation.');
        if (seen.has(key)) throw new Error('Duplicate scripted review remediation: ' + key);
        seen.add(key);
    }
    const repair = script.remediationSequence.find(entry => entry.reviewType === reviewType && entry.attempt === attempt);
    if (!repair) throw new Error(`Missing scripted remediation for failed ${reviewType} review attempt ${attempt}.`);
    return repair.edits;
}

export function walkRemediationEdits(script: RemediationScript): readonly WalkEdit[] {
    return script.remediationSequence ? script.remediationSequence.flatMap(repair => repair.edits) : script.fix ?? [];
}
