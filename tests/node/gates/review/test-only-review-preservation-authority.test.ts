import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { withInvocationReadObservation } from '../../../../src/core/invocation-read-observation';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../../src/core/next-step-measurement';
import { sha256RedactedJsonPayload } from '../../../../src/core/redaction';
import { appendFixtureEvent, createPreservationFixture, HELPER, SOURCE, writeJson } from './test-only-review-preservation-fixtures';

describe('authenticated test-only review preservation', () => {
    it('projects original case claims after an existing private test is corrected', (t) => {
        const fixture = createPreservationFixture(t, { addedCase: true });
        const authority = fixture.read();
        assert.ok(authority, 'current native test-only restart must preserve historical non-test claims');
        assert.equal(authority.review_type, 'code');
        assert.deepEqual(authority.original_validation_obligations.map(item => item.id), ['original-case']);
        assert.ok(authority.restart_sequence > authority.entry_sequence);
    });

    it('accepts a private helper under explicit frozen preservation policy', (t) => {
        const fixture = createPreservationFixture(t, { helper: true, preserveHelper: true });
        assert.ok(fixture.read());
    });

    it('preserves leaf-test claims under a nondefault frozen changed-line threshold', (t) => {
        const fixture = createPreservationFixture(t, { changedLinesThreshold: 37 });
        assert.ok(fixture.read(), 'fresh classification must use the frozen threshold, including its diagnostic reason');
    });

    it('preserves a pre-upgrade leaf-test DELTA with an unchanged multiline Authorization file and rejects drift', (t) => {
        const fixture = createPreservationFixture(t, { legacyLineEvidence: true });
        assert.equal(fixture.baseline.delta_base?.line_evidence_version, undefined);
        const source = fixture.baseline.delta_base?.entries.find(entry => entry.path === SOURCE);
        assert.deepEqual(source?.redacted_lines, ['Authorization: Bearer <redacted>\n', '\n']);
        const decision = fixture.restartDetails.authoritative_review_decision;
        assert.equal(decision.category, 'leaf_test');
        const testLane = decision.lane_decisions.find(lane => lane.review_type === 'test');
        assert.equal(testLane?.mode, 'DELTA', testLane?.reason);
        assert.ok(fixture.read(), 'the authenticated restart still preserves the non-test claims');
        fs.appendFileSync(path.join(fixture.root, SOURCE), 'export const drift = true;\n');
        assert.equal(fixture.read(), null);
    });

    it('keeps unrelated code claims while the old shared-helper default repeats required refactor', (t) => {
        const fixture = createPreservationFixture(t, { helper: true, refactorRequired: true });
        const decision = fixture.restartDetails.authoritative_review_decision;
        // A helper changes refactor/test scope, not the already accepted code scope.
        assert.deepEqual(decision.invalidated_review_types, ['refactor', 'test']);
        assert.ok(decision.preserved_review_types.includes('code'));
        assert.ok(fixture.read());
    });

    it('rejects a test-like helper explicitly assigned a source role', (t) => {
        assert.equal(createPreservationFixture(t, { helper: true, preserveHelper: true, sourceRole: true }).read(), null);
    });

    it('rejects production drift after the recorded restart', (t) => {
        const fixture = createPreservationFixture(t);
        fs.appendFileSync(path.join(fixture.root, SOURCE), 'export const changed = true;\n');
        assert.equal(fixture.read(), null);
    });

    it('rejects further helper drift after classification', (t) => {
        const fixture = createPreservationFixture(t);
        fs.appendFileSync(path.join(fixture.root, HELPER), 'export const changed = true;\n');
        assert.equal(fixture.read(), null);
    });

    it('rejects missing and tampered immutable baseline evidence', (t) => {
        const fixture = createPreservationFixture(t);
        fs.appendFileSync(fixture.baseline.bindings.receipt.snapshot_path, 'tampered');
        assert.equal(fixture.read(), null);
        fs.rmSync(fixture.baselinePath);
        assert.equal(fixture.read(), null);
    });

    it('rejects altered classification bytes and never falls back to a prior restart', (t) => {
        const fixture = createPreservationFixture(t);
        fs.appendFileSync(fixture.classificationReference.artifact_path, 'tampered');
        assert.equal(fixture.read(), null);
    });

    it('rejects altered current preflight scope', (t) => {
        const fixture = createPreservationFixture(t);
        const preflight = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8'));
        preflight.changed_files.push('src/foreign.ts');
        writeJson(fixture.preflightPath, preflight);
        assert.equal(fixture.read(), null);
    });

    it('rejects changed frozen policy bytes', (t) => {
        const fixture = createPreservationFixture(t);
        const preflight = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8'));
        preflight.profile_policy_snapshot.review_remediation_rerun_policy.rules.leaf_test = {
            strategy: 'affected_dependent_reviews', ordered_rerun_lanes: 'all_required'
        };
        writeJson(fixture.preflightPath, preflight);
        assert.equal(fixture.read(), null);
    });

    it('rejects a self-consistent decision hash that contradicts frozen invalidation', (t) => {
        const fixture = createPreservationFixture(t);
        const decision = { ...fixture.restartDetails.authoritative_review_decision, invalidated_review_types: [] };
        decision.decision_sha256 = sha256RedactedJsonPayload(Object.fromEntries(
            Object.entries(decision).filter(([key]) => key !== 'decision_sha256')));
        appendFixtureEvent(fixture.root, 'REVIEW_CYCLE_RESTARTED', {
            ...fixture.restartDetails, authoritative_review_decision: decision
        });
        assert.equal(fixture.read(), null);
    });

    it('does not fall back when a newer restart is unusable', (t) => {
        const fixture = createPreservationFixture(t);
        appendFixtureEvent(fixture.root, 'REVIEW_CYCLE_RESTARTED', { ...fixture.restartDetails, status: 'BLOCKED' });
        assert.equal(fixture.read(), null);
    });

    it('keeps separate callers from mutating retained historical claims', (t) => {
        const fixture = createPreservationFixture(t);
        withInvocationReadObservation(() => {
            const first = fixture.read();
            assert.ok(first);
            first.original_validation_obligations[0].id = 'caller-mutated';
            const second = fixture.read();
            assert.ok(second);
            assert.equal(second.original_validation_obligations[0].id, 'original-case');
        });
    });

    it('shares private preservation facts without cloning their full policy on each lane read', (t) => {
        const fixture = createPreservationFixture(t);
        withInvocationReadObservation(() => {
            const first = fixture.read();
            assert.ok(first);
            let measurement!: NextStepMeasurement;
            const second = withNextStepMeasurement(() => fixture.read(), value => { measurement = value; });
            assert.deepEqual(second, first);
            assert.notEqual(second, first, 'public bindings remain independently mutable copies');
            assert.equal(measurement.work['derive:test-only-review-preservation'] || 0, 0);
            assert.equal(measurement.work['visit:derivation_json_cloned_object'] || 0, 0,
                'an already authenticated private preservation domain must not be copied for each consumer');
        });
    });

    it('rejects source mutation before the shared read observation closes', (t) => {
        const fixture = createPreservationFixture(t);
        assert.throws(() => withInvocationReadObservation(() => {
            assert.ok(fixture.read());
            fs.appendFileSync(path.join(fixture.root, SOURCE), 'export const raced = true;\n');
        }));
    });

    it('rejects a restart replayed after a newer task entry', (t) => {
        const fixture = createPreservationFixture(t);
        appendFixtureEvent(fixture.root, 'TASK_MODE_ENTERED', {});
        assert.equal(fixture.read(), null);
    });

    it('rejects foreign task, current test lane and noncanonical preflight requests', (t) => {
        const fixture = createPreservationFixture(t);
        for (const change of [{ taskId: 'T-foreign' }, { reviewType: 'test' },
            { preflightPath: path.join(fixture.reviewsRoot, 'foreign.json') }]) {
            const original = { ...fixture.args };
            Object.assign(fixture.args, change);
            assert.equal(fixture.read(), null);
            Object.assign(fixture.args, original);
        }
    });
});
