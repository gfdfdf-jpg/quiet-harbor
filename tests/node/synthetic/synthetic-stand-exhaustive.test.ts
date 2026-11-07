import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { renderStandMarkdown, runStand } from '../../../scripts/node-foundation/synthetic/stand';

// Pre-release run (see README.md beside this file): every policy combination, every stack path role and the corpus.
test('exhaustive synthetic review stand reports no new or stale findings', { timeout: 900_000 }, () => {
    const report = runStand({ mode: 'exhaustive' });
    const reportPath = process.env.GARDA_SYNTHETIC_STAND_REPORT
        || path.join(os.tmpdir(), 'garda-synthetic-stand', `exhaustive-${Date.now()}.json`);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(reportPath.replace(/\.json$/u, '') + '.md', renderStandMarkdown(report));
    console.log(`SYNTHETIC_STAND_REPORT ${reportPath} ${JSON.stringify(report.layers)} wall_time_ms=${report.wall_time_ms}`);
    assert.deepEqual(report.new_findings.map((finding) => `${finding.kind} ${finding.id}: ${finding.summary}`), []);
    assert.deepEqual(report.stale_known, []);
});
