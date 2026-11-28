import * as fs from 'node:fs';

/** Harness evidence outside measured product calls. A source reference alone is not execution. */
export function observeStandOracle(id: string): void {
    const file = process.env.GARDA_STAND_CHECK_EVIDENCE;
    if (file) fs.appendFileSync(file, JSON.stringify({ id, pid: process.pid }) + '\n');
}
