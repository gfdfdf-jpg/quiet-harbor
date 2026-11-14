import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { compileReviewDependencyGraph } from '../../../../src/core/review-dependency-graph';
import {
    collectLostRecordedReviewEvidenceTypes,
    collectUnpassedRestartInvalidatedReviewTypes,
    describeReviewEvidenceOnlyRestartRepeats,
    resolveReviewEvidenceOnlyRestartScope
} from '../../../../src/gates/review-remediation/review-evidence-only-restart-scope';
import { finalizeReviewEvidenceOnlyRestartRoute } from '../../../../src/gates/next-step/next-step-review-evidence-only-restart';

const TASK_ID = 'T-960-scope';
const REQUIRED = ['code', 'refactor', 'security', 'test'];

function withTimeline(run: (context: { orchestratorRoot: string; reviewsRoot: string }) => void): void {
    const orchestratorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-evidence-scope-'));
    const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    try {
        run({ orchestratorRoot, reviewsRoot });
    } finally {
        fs.rmSync(orchestratorRoot, { recursive: true, force: true });
    }
}

function recordRestart(orchestratorRoot: string, invalidated: readonly string[], details: Record<string, unknown> = {}): void {
    appendTaskEvent(orchestratorRoot, TASK_ID, 'REVIEW_CYCLE_RESTARTED', 'PASS', 'Restart.', {
        task_id: TASK_ID, event_type: 'REVIEW_CYCLE_RESTARTED', status: 'PASSED', invalidated_review_types: invalidated, ...details
    }, { actor: 'orchestrator' });
}

/** REVIEW_RECORDED always carries outcome PASS, as the real emitter writes it; a failure lives in its details. */
function recordReview(orchestratorRoot: string, reviewType: string, verdict: 'PASS' | 'FAIL', details: Record<string, unknown> = {}): void {
    const verdictDetails = verdict === 'PASS'
        ? { verdict_token: `${reviewType.toUpperCase()} REVIEW PASSED`, cadence_failed: false }
        : { verdict_token: `${reviewType.toUpperCase()} REVIEW FAILED`, cadence_failed: true };
    appendTaskEvent(orchestratorRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', 'Review.',
        { task_id: TASK_ID, review_type: reviewType, ...verdictDetails, ...details }, { actor: 'gate' });
}

const collect = (reviewsRoot: string): string[] => collectUnpassedRestartInvalidatedReviewTypes({
    reviewsRoot, taskId: TASK_ID, requiredReviewTypes: REQUIRED
});

test('only the latest passed gate record can have lost review evidence', () => {
    withTimeline(({ orchestratorRoot, reviewsRoot }) => {
        const receipt = path.join(reviewsRoot, 'code-receipt.json');
        const report = path.join(reviewsRoot, 'code.md');
        const collectLost = () => collectLostRecordedReviewEvidenceTypes({ repoRoot: orchestratorRoot, reviewsRoot, taskId: TASK_ID });
        const writeEvidence = (value: string) => {
            fs.writeFileSync(receipt, `${value} receipt`);
            fs.writeFileSync(report, `${value} report`);
            const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
            return { receipt_path: receipt, receipt_sha256: hash(receipt), review_artifact_path: report, review_artifact_sha256: hash(report) };
        };

        let evidence = writeEvidence('unrecorded');
        assert.deepEqual(collectLost(), [], 'files without authenticated review events are not evidence');
        for (const [name, failure] of [
            ['failed verdict', { verdict_token: 'CODE REVIEW FAILED' }],
            ['failed cadence', { cadence_failed: true }],
            ['rejected findings', { review_findings_validation: { accepted: false } }],
            ['incomplete coverage', { review_coverage: { status: 'FAIL' } }],
            ['blocking findings', { review_findings_disposition: { blocking_count: 1 } }]
        ] as const) {
            recordReview(orchestratorRoot, 'code', 'PASS', evidence);
            evidence = writeEvidence(name);
            recordReview(orchestratorRoot, 'code', 'PASS', { ...evidence, ...failure });
            assert.deepEqual(collectLost(), [], `${name} supersedes the old pass`);
        }

        recordReview(orchestratorRoot, 'code', 'PASS', evidence);
        evidence = writeEvidence('failed gate event');
        appendTaskEvent(orchestratorRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', 'Review failed.',
            { task_id: TASK_ID, review_type: 'code', ...evidence }, { actor: 'gate' });
        assert.deepEqual(collectLost(), [], 'a non-PASS gate event also supersedes the old pass');

        recordReview(orchestratorRoot, 'code', 'PASS', evidence);
        assert.deepEqual(collectLost(), []);
        fs.unlinkSync(receipt);
        assert.deepEqual(collectLost(), ['code'], 'a deleted receipt of the latest pass is lost');
        evidence = writeEvidence('another pass');
        recordReview(orchestratorRoot, 'code', 'PASS', evidence);
        fs.writeFileSync(report, 'damaged report');
        assert.deepEqual(collectLost(), ['code'], 'a damaged report of the latest pass is lost');
        fs.unlinkSync(report);
        assert.deepEqual(collectLost(), ['code'], 'a deleted report of the latest pass is lost');
        fs.writeFileSync(report, 'another pass report');
        fs.writeFileSync(receipt, 'damaged receipt');
        assert.deepEqual(collectLost(), ['code'], 'a damaged receipt of the latest pass is lost');

        evidence = writeEvidence('validation pass');
        const validation = path.join(reviewsRoot, 'code-findings-validation.json');
        fs.writeFileSync(validation, 'valid validation');
        const validationHash = crypto.createHash('sha256').update(fs.readFileSync(validation)).digest('hex');
        recordReview(orchestratorRoot, 'code', 'PASS', { ...evidence,
            review_findings_validation: { accepted: true, artifact_path: validation, artifact_sha256: validationHash } });
        assert.deepEqual(collectLost(), []);
        fs.writeFileSync(validation, 'damaged validation');
        assert.deepEqual(collectLost(), ['code'], 'a damaged validation of the latest pass is lost');
        const external = path.join(orchestratorRoot, 'external-validation.json');
        fs.writeFileSync(external, 'valid validation');
        recordReview(orchestratorRoot, 'code', 'PASS', { ...evidence,
            review_findings_validation: { accepted: true, artifact_path: external, artifact_sha256: validationHash } });
        assert.deepEqual(collectLost(), ['code'], 'matching bytes outside the review directory cannot supply evidence');

        appendTaskEvent(orchestratorRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', 'Non-gate review.',
            { task_id: TASK_ID, review_type: 'code', verdict_token: 'CODE REVIEW FAILED' }, { actor: 'orchestrator' });
        assert.deepEqual(collectLost(), ['code'], 'a non-gate event cannot supersede the gate record');
        appendTaskEvent(orchestratorRoot, TASK_ID, 'TASK_MODE_ENTERED', 'INFO', 'Entered.', { task_id: TASK_ID });
        assert.deepEqual(collectLost(), [], 'a new task entry has no recorded review yet');
    });
});

test('lost review evidence is not inferred from an unauthenticated timeline', () => {
    withTimeline(({ orchestratorRoot, reviewsRoot }) => {
        recordReview(orchestratorRoot, 'code', 'PASS', { receipt_path: 'missing.json', receipt_sha256: 'a'.repeat(64) });
        const timelinePath = path.join(orchestratorRoot, 'runtime', 'task-events', `${TASK_ID}.jsonl`);
        fs.writeFileSync(timelinePath, fs.readFileSync(timelinePath, 'utf8').replace('"Review."', '"Tampered."'));
        assert.deepEqual(collectLostRecordedReviewEvidenceTypes({ repoRoot: orchestratorRoot, reviewsRoot, taskId: TASK_ID }), []);
    });
});

test('a reopened review stays unpassed until a fresh PASS, across every later restart', () => {
    withTimeline(({ orchestratorRoot, reviewsRoot }) => {
        recordRestart(orchestratorRoot, ['security', 'refactor', 'test']);
        recordReview(orchestratorRoot, 'security', 'FAIL');
        recordRestart(orchestratorRoot, ['security']);
        assert.deepEqual(collect(reviewsRoot), ['refactor', 'security', 'test']);
        recordReview(orchestratorRoot, 'security', 'PASS');
        recordReview(orchestratorRoot, 'refactor', 'PASS');
        assert.deepEqual(collect(reviewsRoot), ['test']);
    });
});

test('a failed review recorded with the real event shape stays unpassed', () => {
    withTimeline(({ orchestratorRoot, reviewsRoot }) => {
        recordRestart(orchestratorRoot, ['security', 'refactor', 'test']);
        recordReview(orchestratorRoot, 'security', 'PASS');
        recordReview(orchestratorRoot, 'refactor', 'FAIL');
        assert.deepEqual(collect(reviewsRoot), ['refactor', 'test']);
        // A verdict alone (an older record without the sealed cadence flag) or blocking findings also count as a failure.
        recordReview(orchestratorRoot, 'refactor', 'PASS', { verdict_token: 'REFACTOR REVIEW FAILED', cadence_failed: undefined });
        recordReview(orchestratorRoot, 'test', 'PASS', { review_findings_disposition: { blocking_count: 1 } });
        assert.deepEqual(collect(reviewsRoot), ['refactor', 'test']);
    });
});

test('a materialized reuse is not a pass and a later invalidation reopens a passed review', () => {
    withTimeline(({ orchestratorRoot, reviewsRoot }) => {
        recordRestart(orchestratorRoot, ['refactor']);
        recordReview(orchestratorRoot, 'refactor', 'PASS', { reused_existing_review: true });
        assert.deepEqual(collect(reviewsRoot), ['refactor']);
        recordReview(orchestratorRoot, 'refactor', 'PASS');
        assert.deepEqual(collect(reviewsRoot), []);
        recordRestart(orchestratorRoot, ['refactor']);
        assert.deepEqual(collect(reviewsRoot), ['refactor']);
    });
});

test('task re-entry starts a new cycle and a review outside the required set is ignored', () => {
    withTimeline(({ orchestratorRoot, reviewsRoot }) => {
        recordRestart(orchestratorRoot, ['refactor', 'db']);
        assert.deepEqual(collect(reviewsRoot), ['refactor']);
        appendTaskEvent(orchestratorRoot, TASK_ID, 'TASK_MODE_ENTERED', 'INFO', 'Entered.', { task_id: TASK_ID });
        assert.deepEqual(collect(reviewsRoot), []);
    });
});

test('a satisfied lane is not owed and an unreadable classification repeats every lane of its decision', () => {
    withTimeline(({ orchestratorRoot, reviewsRoot }) => {
        const lane = (reviewType: string, invalidated: boolean, satisfied: boolean) => ({
            review_type: reviewType, invalidated, satisfied, mode: 'FULL'
        });
        recordRestart(orchestratorRoot, ['code', 'test'], {
            authoritative_review_decision: { lane_decisions: [lane('code', true, true), lane('test', true, false), lane('security', false, false)] }
        });
        assert.deepEqual(collect(reviewsRoot), ['test']);
        recordRestart(orchestratorRoot, [], {
            authoritative_review_decision: { lane_decisions: [lane('security', false, false)] },
            authoritative_review_classification_reference: { schema_version: 1, artifact_path: 'missing.json', artifact_sha256: 'a'.repeat(64) }
        });
        assert.deepEqual(collect(reviewsRoot), ['security', 'test']);
    });
});

test('a timeline that cannot be authenticated repeats every required review', () => {
    withTimeline(({ orchestratorRoot, reviewsRoot }) => {
        recordRestart(orchestratorRoot, ['test']);
        const timelinePath = path.join(orchestratorRoot, 'runtime', 'task-events', `${TASK_ID}.jsonl`);
        fs.writeFileSync(timelinePath, fs.readFileSync(timelinePath, 'utf8').replace('"Restart."', '"Tampered."'));
        assert.deepEqual(collect(reviewsRoot), REQUIRED);
    });
});

test('only a declared graph brings dependents and the description names exactly what repeats', () => {
    const required = ['code', 'security', 'refactor', 'test'];
    const declaration = { preparation_order: required, dependencies: { security: ['code'], refactor: ['security'], test: ['refactor'] } };
    const declared = compileReviewDependencyGraph({
        catalogLaneIds: required, activeLaneIds: required, requiredReviewIds: required, mode: 'strict_sequential', declaration
    });
    const implied = compileReviewDependencyGraph({
        catalogLaneIds: required, activeLaneIds: required, requiredReviewIds: required, mode: 'strict_sequential'
    });
    const onlyAffected = resolveReviewEvidenceOnlyRestartScope({ reviewType: 'security', requiredReviewTypes: required, dependencyGraph: implied });
    assert.deepEqual(onlyAffected, { reviewTypes: ['security'], carriedReviewTypes: [], dependentReviewTypes: [] });
    assert.equal(describeReviewEvidenceOnlyRestartRepeats('security', onlyAffected), "only 'security'");
    for (const mode of ['parallel_all', 'test_after_code', 'code_first_optional'] as const) {
        const modeImplied = compileReviewDependencyGraph({
            catalogLaneIds: required, activeLaneIds: required, requiredReviewIds: required, mode
        });
        const modeDeclared = compileReviewDependencyGraph({
            catalogLaneIds: required, activeLaneIds: required, requiredReviewIds: required, mode, declaration
        });
        assert.deepEqual(resolveReviewEvidenceOnlyRestartScope({ reviewType: 'security', requiredReviewTypes: required,
            dependencyGraph: modeImplied }).reviewTypes, ['security'], mode + ': launch order alone does not invalidate dependents');
        assert.deepEqual(resolveReviewEvidenceOnlyRestartScope({ reviewType: 'security', requiredReviewTypes: required,
            dependencyGraph: modeDeclared }).reviewTypes, ['security', 'refactor', 'test'], mode + ': the declared graph still applies');
    }

    const dependents = resolveReviewEvidenceOnlyRestartScope({ reviewType: 'security', requiredReviewTypes: required, dependencyGraph: declared });
    assert.deepEqual(dependents.dependentReviewTypes, ['refactor', 'test']);
    assert.equal(describeReviewEvidenceOnlyRestartRepeats('security', dependents),
        "'security' and the reviews that depend on it in the declared review graph ('refactor', 'test')");

    const carried = resolveReviewEvidenceOnlyRestartScope({
        reviewType: 'code', requiredReviewTypes: required, carriedReviewTypes: ['refactor', 'code'], dependencyGraph: implied
    });
    assert.deepEqual(carried, { reviewTypes: ['code', 'refactor'], carriedReviewTypes: ['refactor'], dependentReviewTypes: [] });
    assert.equal(describeReviewEvidenceOnlyRestartRepeats('code', carried),
        "'code' and the reviews an earlier restart invalidated that have not passed since ('refactor', in the mode that restart chose)");

    const both = resolveReviewEvidenceOnlyRestartScope({
        reviewType: 'code', requiredReviewTypes: required, carriedReviewTypes: ['security'], dependencyGraph: declared
    });
    assert.deepEqual(both.reviewTypes, required);
    assert.match(describeReviewEvidenceOnlyRestartRepeats('code', both), /and the reviews that depend on them in the declared review graph/u);
});

test('a restart that would be refused is replaced instead of offered again', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-only-offer-'));
    try {
        const reviewsRoot = path.join(root, 'runtime', 'reviews');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const ordinaryRestart = { label: 'Restart review cycle', command: 'gate restart-review-cycle --review-type "code"' };
        let ordinaryRestartBuilds = 0;
        const options = () => {
            ordinaryRestartBuilds += 1;
            return {
                repoRoot: root, reviewsRoot, eventsRoot: path.join(root, 'runtime', 'task-events'), taskId: 'T-1', reviewType: 'code',
                preflight: {}, preflightPath: path.join(reviewsRoot, 'T-1-preflight.json'), taskMode: null,
                requiredReviewTypes: ['code'], ordinaryRestart
            };
        };
        const offered = { reason: 'Recover the review.', commands: [{ label: 'Restart', command: `${ordinaryRestart.command} --review-evidence-only` }] };

        const route = finalizeReviewEvidenceOnlyRestartRoute(offered, options);

        assert.deepEqual(route?.commands, [ordinaryRestart]);
        assert.equal(ordinaryRestartBuilds, 1);
        assert.match(route?.reason ?? '', /An evidence-only restart cannot be used here: current compile-gate evidence is missing/u);
        assert.match(route?.reason ?? '', /every required review repeats in FULL/u);
        const unrelated = { reason: 'Recover the review.', commands: [ordinaryRestart] };
        assert.equal(finalizeReviewEvidenceOnlyRestartRoute(unrelated, options), unrelated);
        assert.equal(finalizeReviewEvidenceOnlyRestartRoute(null, options), null);
        assert.equal(ordinaryRestartBuilds, 1, 'Unrelated and absent routes must not build a restart command');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
