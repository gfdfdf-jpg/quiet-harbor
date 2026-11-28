/**
 * A history kept from before task-event integrity (PASS_WITH_LEGACY_PREFIX) is authenticated from its first signed
 * event on: the chain binds the prefix length, not its content. Any other non-PASS status is refused.
 */
export function isAuthenticatedTaskHistoryStatus(status: string): boolean {
    return status === 'PASS' || status === 'PASS_WITH_LEGACY_PREFIX';
}

/** Only an event that carries an integrity record belongs to the signed chain. */
export function isSignedTaskEvent(event: unknown): boolean {
    if (!event || typeof event !== 'object') return false;
    const integrity = (event as { integrity?: unknown }).integrity;
    return !!integrity && typeof integrity === 'object';
}

/**
 * Evidence comes only from signed events: an unsigned legacy prefix never counts. Call it after the history status is
 * authenticated; a PASS history has no unsigned events, so the filter only drops a legacy prefix.
 */
export function signedTaskHistoryEntries<T extends { readonly record: unknown }>(entries: readonly T[]): T[] {
    return entries.filter(entry => isSignedTaskEvent(entry.record));
}

export function signedTaskHistoryEvents<T>(events: readonly T[]): T[] {
    return events.filter(event => isSignedTaskEvent(event));
}
