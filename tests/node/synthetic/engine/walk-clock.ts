/** Test-only clock brand: a wall-clock adjustment must never become an extra synthetic offset in a child. */
export const WALK_CLOCK_OFFSET = Symbol.for('garda.synthetic.walk-clock-offset');

type WalkDateConstructor = { now(): number; readonly [WALK_CLOCK_OFFSET]?: number };

export function nativeOwnerClockOffset(clock: WalkDateConstructor = Date): number {
    const offset = clock[WALK_CLOCK_OFFSET];
    if (offset === undefined) return 0;
    if (!Number.isFinite(offset)) throw new Error('Invalid synthetic walk clock offset.');
    return offset;
}
