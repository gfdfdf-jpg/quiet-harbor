import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeOwnerClockOffset, WALK_CLOCK_OFFSET } from './engine/walk-clock';

test('native owners copy only the walk offset, independent of wall/monotonic clock skew', () => {
    class AdjustedClock extends Date {
        static override now(): number { return Date.now() + 5000; }
        static get [WALK_CLOCK_OFFSET](): number { return 23; }
    }
    assert.equal(nativeOwnerClockOffset(AdjustedClock), 23);
    class AdjustedNativeClock extends Date {
        static override now(): number { return Date.now() - 5000; }
    }
    assert.equal(nativeOwnerClockOffset(AdjustedNativeClock), 0);
    assert.equal(nativeOwnerClockOffset(Date), 0);
});

test('an invalid branded clock is refused instead of publishing mismatched native timestamps', () => {
    class InvalidClock extends Date { static get [WALK_CLOCK_OFFSET](): number { return NaN; } }
    assert.throws(() => nativeOwnerClockOffset(InvalidClock), /Invalid synthetic walk clock offset/u);
});
