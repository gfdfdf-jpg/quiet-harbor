import test from 'node:test';
import assert from 'node:assert/strict';
import { runReferenceStand, type ReferenceOptions } from './engine/reference-stand';

test('reference stand entry', { skip: !process.env.GARDA_REFERENCE_STAND, timeout: Infinity }, async () => {
    const options = JSON.parse(process.env.GARDA_REFERENCE_STAND!) as ReferenceOptions;
    assert.equal(await runReferenceStand(options), true, 'Reference checks failed; inspect summary.json and summary.md in the printed report directory');
});
