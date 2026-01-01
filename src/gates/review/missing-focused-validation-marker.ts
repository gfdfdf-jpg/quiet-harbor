/** One grammar for findings, artifact verdicts and evidence-only navigation. */
export const MISSING_FOCUSED_VALIDATION_PATTERN =
    /^\[garda:evidence-only:missing-focused-validation\]\s+(?:test=([^;\r\n]+);\s*action=run-and-record-focused-test|target=([^;\r\n]+);\s*action=run-and-record-focused-validation)$/u;

export function isContainedFocusedTarget(target: string): boolean {
    const normalized = target.replace(/\\/gu, '/');
    return !!normalized && normalized === normalized.trim() && !/[\u0000-\u001f]/u.test(normalized)
        && !normalized.startsWith('/') && !/^[a-z]:/iu.test(normalized)
        && normalized.split('/').every(segment => !!segment && segment !== '.' && segment !== '..');
}

/** Preserve every syntactic target so schema validation can diagnose unsafe paths too. */
export function parseMissingFocusedValidationMarkerTargets(value: string): string[] {
    const matches = value.split(/\r?\n/u).map(line => MISSING_FOCUSED_VALIDATION_PATTERN.exec(line));
    if (matches.some(match => !match)) return [];
    return [...new Set(matches.map(match => match![1] || match![2]))];
}

export function missingFocusedValidationTargets(value: string): string[] {
    const targets = parseMissingFocusedValidationMarkerTargets(value);
    return targets.every(isContainedFocusedTarget) ? targets.map(target => target.replace(/\\/gu, '/')) : [];
}

export function missingFocusedValidationTarget(value: string): string | null {
    return missingFocusedValidationTargets(value)[0] ?? null;
}
