import test from 'node:test';
import assert from 'node:assert/strict';

import { comparePathObservation } from '../../../scripts/node-foundation/synthetic/path-layer';
import { compareMode, compareRerunLanes, observeMode } from '../../../scripts/node-foundation/synthetic/policy-layer';
import { PROTECTED_SIGNAL_OWNERS, type ProtectedSignal } from '../../../scripts/node-foundation/synthetic/oracle';
import { REVIEW_LANES } from '../../../scripts/node-foundation/synthetic/model';
import { STACK_ADAPTERS } from '../../../scripts/node-foundation/synthetic/stacks';
import { FILE_ROLES } from '../../../scripts/node-foundation/synthetic/model';
import { readCorpus, readKnownFindings, replayCorpus, runStand } from '../../../scripts/node-foundation/synthetic/stand';

test('sampled synthetic review stand reports no new or stale findings', { timeout: 300_000 }, () => {
    const report = runStand({ mode: 'sample' });
    assert.ok(report.layers.every((layer) => layer.cases > 0 || layer.layer === 'corpus'), JSON.stringify(report.layers));
    assert.deepEqual(report.new_findings.map((finding) => `${finding.kind} ${finding.id}: ${finding.summary}`), []);
    assert.deepEqual(report.stale_known, []);
});

test('every corpus entry stays green', () => {
    const corpus = readCorpus();
    assert.ok(corpus.length > 0);
    assert.deepEqual(new Set(corpus.map((entry) => entry.id)).size, corpus.length, 'corpus ids must be unique');
    assert.deepEqual(replayCorpus(corpus).findings, []);
});

test('every protected signal forces FULL on its owner and leaves other eligible reviews DELTA', () => {
    for (const [signal, owner] of Object.entries(PROTECTED_SIGNAL_OWNERS) as Array<[ProtectedSignal, string | null]>) {
        for (const lane of REVIEW_LANES) {
            const input = { lane, category: 'production' as const, changedFiles: 1, changedLines: 12, consecutiveDeltaReviews: 0,
                protectedSignal: signal, initialReview: false, taskCriteriaChanged: false, policyChanged: false,
                scopeMembershipChanged: false, uncertainCrossFileImpact: false };
            const expected = owner === null || owner === lane ? 'FULL' : 'DELTA';
            assert.equal(observeMode(input), expected, signal + ':' + lane);
            assert.equal(compareMode(input, expected), null, signal + ':' + lane);
            assert.equal(compareMode(input, expected === 'FULL' ? 'DELTA' : 'FULL')?.kind, expected === 'FULL' ? 'safety' : 'economy');
        }
    }
});

test('known findings are unique and annotated', () => {
    const known = readKnownFindings();
    assert.equal(new Set(known.map((entry) => entry.id)).size, known.length);
    assert.ok(known.every((entry) => entry.note.trim().length > 0));
});

test('stack adapters cover every role and declare unexpressible conventions explicitly', () => {
    assert.ok(STACK_ADAPTERS.length >= 13);
    for (const stack of STACK_ADAPTERS) {
        for (const role of FILE_ROLES) {
            assert.ok(stack.paths[role].length > 0, `${stack.id} lacks ${role}`);
        }
    }
    assert.ok(STACK_ADAPTERS.some((stack) => stack.unexpressible.length > 0));
});

test('the oracle detects deliberately wrong observations', () => {
    const context = { stack: 'node-ts', role: 'UNIT_TEST' as const, file: 'tests/invoice.test.ts', variant: { operation: 'modified' as const, changedLines: 10 } };
    const correct = { isTest: true, domainLanes: [], category: 'leaf_test' as const, effect: 'current_lane' as const };
    assert.deepEqual(comparePathObservation(context, correct), []);
    const kinds = (observation: Parameters<typeof comparePathObservation>[1]) => comparePathObservation(context, observation)
        .map((finding) => finding.kind);
    assert.deepEqual(kinds({ ...correct, isTest: false }), ['economy']);
    assert.deepEqual(kinds({ ...correct, domainLanes: ['security'] }), ['economy']);
    assert.deepEqual(kinds({ ...correct, category: 'ambiguous', effect: 'all_required' }), ['economy']);
    const helper = { ...context, role: 'TEST_HELPER' as const, file: 'tests/helpers/render.ts' };
    assert.deepEqual(comparePathObservation(helper, correct).map((finding) => finding.kind), ['safety']);
    const auth = { ...context, role: 'AUTH' as const, file: 'src/auth/session.ts' };
    assert.ok(comparePathObservation(auth, { isTest: false, domainLanes: [], category: 'production', effect: 'current_lane' })
        .some((finding) => finding.kind === 'safety' && finding.summary.includes('security')));

    const modeCase = {
        lane: 'code' as const, category: 'production' as const, changedFiles: 1, changedLines: 12, consecutiveDeltaReviews: 0,
        protectedSignal: null, initialReview: false, taskCriteriaChanged: false, policyChanged: false,
        scopeMembershipChanged: false, uncertainCrossFileImpact: false
    };
    assert.equal(compareMode(modeCase, 'DELTA'), null);
    assert.equal(compareMode(modeCase, 'FULL')?.kind, 'economy');
    assert.equal(compareMode({ ...modeCase, lane: 'security', protectedSignal: 'security' }, 'DELTA')?.kind, 'safety');

    const rerunCase = { failedLane: 'test' as const, category: 'structural_test' as const,
        requiredLanes: ['code', 'refactor', 'test'] as const, constituentCategories: ['structural_test'] as const };
    assert.equal(compareRerunLanes(rerunCase, ['refactor', 'test']), null);
    assert.equal(compareRerunLanes(rerunCase, ['code', 'refactor', 'test'])?.kind, 'economy');
    assert.equal(compareRerunLanes(rerunCase, ['test'])?.kind, 'safety');
});
