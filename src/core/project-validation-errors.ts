/**
 * Typed project-validation failures Garda raises itself. The navigator routes on these types, never on rejection text:
 * the text also carries user-supplied case ids and paths. The messages are unchanged, and the classes keep the plain
 * `Error` name, so every printed diagnostic stays exactly as before.
 */

/**
 * The approved project validation contract or its audited authority is missing, invalid or changed. `readmitted`: the
 * current authority is an audited admission newer than the one the preflight froze, so a preflight refresh binds it;
 * `audit-repair`: the operator must repair malformed audit history before re-approval.
 */
export type ProjectValidationAuthorityIssue = 'readmitted' | 'approval' | 'audit-repair';

export class ProjectValidationAuthorityError extends Error {
    constructor(message: string, readonly issue: ProjectValidationAuthorityIssue = 'approval') {
        super(message);
    }
}

/**
 * Inputs one batch inspection read twice differed (a concurrent write): the timeline or scope, the frozen recipe or
 * source identities, or the preflight the recipes froze against the one the caller read.
 */
export type ValidationInspectionRace = 'timeline' | 'identities' | 'preflight';

export class ValidationInspectionRaceError extends Error {
    /**
     * `recordedPreflightSha256` (`preflight` only): the preflight sha256 the recipes froze, so the caller can tell a race
     * from a stable mismatch. `recipeIds`: the recipes the inspection froze, whose identities the retry witness covers.
     */
    constructor(message: string, readonly race: ValidationInspectionRace, readonly recordedPreflightSha256: string | null = null,
        readonly recipeIds: readonly string[] = []) {
        super(message);
    }
}
