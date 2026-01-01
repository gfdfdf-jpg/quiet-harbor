import * as fs from 'node:fs';

// Opt-in diagnostics must be flushed even while a synchronous update stage is blocked.
export function traceUpdateProgress(stage: string): void {
    if (process.env.GARDA_UPDATE_PROGRESS !== '1') return;
    try {
        fs.writeSync(2, `GARDA_UPDATE_PROGRESS pid=${process.pid} stage=${stage}\n`);
    } catch {
        // Diagnostics must not change the outcome of an update.
    }
}
