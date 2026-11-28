import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { type TimelineEventEntry } from '../../../../src/gates/completion/completion-evidence';
import { validateStageSequence } from '../../../../src/gates/completion/completion-verdict-stage-sequence';
import {
    describeReclassificationBoundStop,
    findReclassificationBoundStop,
    MAX_IDENTICAL_RECLASSIFICATIONS,
    normalizeCompletionViolation,
    readUnchangedReclassificationReadiness,
    withoutUnchangedReclassifications
} from '../../../../src/gates/scope/unchanged-reclassification';

const TASK_ID = 'T-437';
const SCOPE = 'a'.repeat(64);
const CONTENT = 'b'.repeat(64);
const REQUIRED_REVIEWS = { code: true, test: true, security: false };
const tempRoots: string[] = [];

afterEach(() => {
    for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function classification(outputSha256: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        mode: 'FULL_PATH',
        output_sha256: outputSha256,
        code_changed: true,
        changed_files_count: 1,
        changed_lines_total: 133,
        scope_sha256: SCOPE,
        scope_content_sha256: CONTENT,
        task_criteria_sha256: 'c'.repeat(64),
        required_reviews: REQUIRED_REVIEWS,
        ...overrides
    };
}

/** A signed gate event of the task, as the timeline reader returns it. */
function event(sequence: number, eventType: string, details: Record<string, unknown> = {}): TimelineEventEntry {
    return {
        event_type: eventType, sequence, timestamp_utc: '2026-11-24T23:00:00.000Z', details,
        task_id: TASK_ID, actor: 'gate', outcome: eventType === 'PREFLIGHT_CLASSIFIED' ? 'INFO' : 'PASS',
        integrity: { schema_version: 2, task_sequence: sequence, prev_event_sha256: null, event_sha256: sequence.toString(16).padStart(64, '0') }
    } as TimelineEventEntry;
}

function failure(sequence: number, violations: string[]): TimelineEventEntry {
    return event(sequence, 'COMPLETION_GATE_FAILED', { violations });
}

/** The T-437 shape: reviewed classification, compile, reviews, completion failure, then an identical reclassification. */
function seed(latestOverrides: Record<string, unknown> = {}, betweenEvents: TimelineEventEntry[] = [],
    reviewedEvents: TimelineEventEntry[] = [event(89, 'COMPILE_GATE_PASSED'), event(171, 'REVIEW_GATE_PASSED'), event(175, 'COMPLETION_GATE_FAILED')]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-unchanged-reclass-'));
    tempRoots.push(root);
    const preflightPath = path.join(root, 'T-437-preflight.json');
    fs.writeFileSync(preflightPath, JSON.stringify({ metrics: { scope_sha256: SCOPE, scope_content_sha256: CONTENT },
        budget_forecast: { timestamp_utc: 'refreshed' } }));
    const latest = event(177, 'PREFLIGHT_CLASSIFIED',
        classification(createHash('sha256').update(fs.readFileSync(preflightPath)).digest('hex'), latestOverrides));
    const events = [
        event(13, 'TASK_MODE_ENTERED'),
        event(81, 'HANDSHAKE_DIAGNOSTICS_RECORDED'),
        event(82, 'SHELL_SMOKE_PREFLIGHT_RECORDED'),
        event(84, 'PREFLIGHT_CLASSIFIED', classification('d'.repeat(64))),
        event(88, 'IMPLEMENTATION_STARTED'),
        ...reviewedEvents.slice(0, 1),
        event(159, 'REVIEW_PHASE_STARTED'),
        event(170, 'REVIEW_RECORDED'),
        ...reviewedEvents.slice(1),
        ...betweenEvents,
        latest
    ];
    return { preflightPath, events, latest };
}

describe('gates/scope/unchanged-reclassification', () => {
    it('accepts a reclassification that re-records the reviewed classification after a review boundary', () => {
        const { preflightPath, events, latest } = seed();

        const readiness = readUnchangedReclassificationReadiness(preflightPath, events, latest, TASK_ID);

        assert.ok(readiness);
        assert.equal(readiness.reviewedPreflightSequence, 84);
    });

    for (const [name, overrides] of [
        ['task criteria', { task_criteria_sha256: 'e'.repeat(64) }],
        ['required reviews', { required_reviews: { ...REQUIRED_REVIEWS, security: true } }],
        ['scope content', { scope_content_sha256: 'e'.repeat(64) }],
        ['changed line total', { changed_lines_total: 134 }],
        ['missing criteria', { task_criteria_sha256: undefined }]
    ] as const) {
        it(`rejects a reclassification with different ${name}`, () => {
            const { preflightPath, events, latest } = seed(overrides);

            assert.equal(readUnchangedReclassificationReadiness(preflightPath, events, latest, TASK_ID), null);
        });
    }

    it('rejects a reclassification after a task-mode re-entry', () => {
        const { preflightPath, events, latest } = seed({}, [event(176, 'TASK_MODE_ENTERED')]);

        assert.equal(readUnchangedReclassificationReadiness(preflightPath, events, latest, TASK_ID), null);
    });

    it('rejects a reclassification before the earlier classification was compiled and reviewed', () => {
        const uncompiled = seed({}, [], []);
        const unreviewed = seed({}, [], [event(89, 'COMPILE_GATE_PASSED')]);

        assert.equal(readUnchangedReclassificationReadiness(uncompiled.preflightPath, uncompiled.events, uncompiled.latest, TASK_ID), null);
        assert.equal(readUnchangedReclassificationReadiness(unreviewed.preflightPath, unreviewed.events, unreviewed.latest, TASK_ID), null);
    });

    it('rejects a preflight file that is not the one the latest event classified', () => {
        const { preflightPath, events, latest } = seed();
        fs.appendFileSync(preflightPath, ' ');

        assert.equal(readUnchangedReclassificationReadiness(preflightPath, events, latest, TASK_ID), null);
    });

    it('lets completion keep the reviewed cycle once identical reclassifications are set aside', () => {
        const { events } = seed();
        // Recovery after the reclassification: compile rerun, review reuse per lane, review gate.
        const recovered = [...events, event(180, 'COMPILE_GATE_PASSED'), event(181, 'REVIEW_PHASE_STARTED'),
            event(182, 'REVIEW_RECORDED'), event(183, 'REVIEW_GATE_PASSED')];
        const again = [...recovered, event(184, 'COMPLETION_GATE_FAILED'), event(186, 'PREFLIGHT_CLASSIFIED', classification('f'.repeat(64))),
            event(187, 'COMPILE_GATE_PASSED'), event(188, 'REVIEW_PHASE_STARTED'), event(189, 'REVIEW_RECORDED'), event(190, 'REVIEW_GATE_PASSED')];

        assert.ok(validateStageSequence(recovered, true, 'timeline.jsonl').violations.length > 0,
            'the raw sequence treats the reclassification as a new cycle');
        assert.deepEqual(validateStageSequence(withoutUnchangedReclassifications(recovered, TASK_ID), true, 'timeline.jsonl').violations, []);
        assert.deepEqual(validateStageSequence(withoutUnchangedReclassifications(again, TASK_ID), true, 'timeline.jsonl').violations, [],
            'a second identical reclassification is set aside as well');
    });

    it('keeps a real reclassification in the stage sequence', () => {
        const { events } = seed({ scope_content_sha256: 'e'.repeat(64) });
        const changed = [...events, event(180, 'COMPILE_GATE_PASSED'), event(181, 'REVIEW_PHASE_STARTED'),
            event(182, 'REVIEW_RECORDED'), event(183, 'REVIEW_GATE_PASSED')];

        assert.equal(withoutUnchangedReclassifications(changed, TASK_ID).length, changed.length);
        assert.ok(validateStageSequence(withoutUnchangedReclassifications(changed, TASK_ID), true, 'timeline.jsonl').violations.length > 0);
    });
    it('rejects classifications that are not signed gate events of this task', () => {
        const { preflightPath, events, latest } = seed();
        const unsigned = { ...latest, integrity: null } as TimelineEventEntry;
        const otherTask = { ...latest, task_id: 'T-999' } as TimelineEventEntry;
        const agentWritten = { ...latest, actor: 'agent' } as TimelineEventEntry;

        for (const forged of [unsigned, otherTask, agentWritten]) {
            assert.equal(readUnchangedReclassificationReadiness(preflightPath, [...events.slice(0, -1), forged], forged, TASK_ID), null);
        }
    });

    it('accepts the identical reclassification once per completion failure and names a repeated one', () => {
        const { events } = seed();
        assert.equal(findReclassificationBoundStop(events, TASK_ID), null, 'the first rerun is allowed');

        const repeated = [...events, ...rerun(180), failure(184, []), reclassification(186)];
        assert.deepEqual(findReclassificationBoundStop(repeated, TASK_ID),
            { kind: 'repeated-failure', failureSequence: 184, earlierFailureSequence: 175, earlierReclassificationSequence: 177 });
        assert.equal(withoutUnchangedReclassifications(repeated, TASK_ID).length, repeated.length - 2,
            'completion still sets both identical reclassifications aside');

        const different = [...events, ...rerun(180), failure(184, ['A different completion violation.']), reclassification(186)];
        assert.equal(findReclassificationBoundStop(different, TASK_ID), null, 'a new completion failure gets its own rerun');
    });

    it('treats a failure whose text only changes per round (sequence, hash, timestamp) as the same failure', () => {
        const round = (seq: number, sha: string, at: string) => [
            `Stage sequence: COMPILE_GATE_PASSED (seq ${seq}) is not preceded by PREFLIGHT_CLASSIFIED.`,
            `Full-suite evidence is not bound to preflight_sha256 ${sha} and compile_gate_timestamp ${at}.`
        ];
        const events = [
            ...seed({}, [], [event(89, 'COMPILE_GATE_PASSED'), event(171, 'REVIEW_GATE_PASSED'),
                failure(175, round(89, '1'.repeat(64), '2026-11-24T22:10:00.000Z'))]).events,
            ...rerun(180),
            failure(184, round(180, '2'.repeat(64), '2026-11-25T01:02:03.456Z')),
            reclassification(186)
        ];

        assert.deepEqual(findReclassificationBoundStop(events, TASK_ID),
            { kind: 'repeated-failure', failureSequence: 184, earlierFailureSequence: 175, earlierReclassificationSequence: 177 });
        assert.equal(normalizeCompletionViolation('seq 12 at 2026-11-25T01:02:03Z with ' + 'A'.repeat(64)),
            'seq <n> at <timestamp> with <sha256>');
    });

    it('stops at the cap of identical reclassifications whatever the failure texts say', () => {
        const { events } = seed();
        const second = [...events, ...rerun(180), failure(184, ['Second distinct violation.']), reclassification(186)];
        const third = [...second, ...rerun(190), failure(194, ['Third distinct violation.']), reclassification(196)];

        assert.equal(findReclassificationBoundStop(second, TASK_ID), null, `${MAX_IDENTICAL_RECLASSIFICATIONS} reruns are allowed`);
        assert.deepEqual(findReclassificationBoundStop(third, TASK_ID), { kind: 'cap', count: 3, reviewedPreflightSequence: 84 });
        assert.match(String(describeReclassificationBoundStop(third, [], TASK_ID)), /identical reclassification 3 .*at most 2 reruns/u);
    });

    it('refuses the rerun when the full history could not be read (fail closed)', () => {
        const { events } = seed();

        assert.equal(describeReclassificationBoundStop(events, [], TASK_ID), null);
        assert.match(String(describeReclassificationBoundStop(events, ['Task timeline contains invalid JSON line: t.jsonl'], TASK_ID)),
            /could not be read to check the rerun bound \(Task timeline contains invalid JSON line/u);
    });
});

function rerun(fromSequence: number): TimelineEventEntry[] {
    return [event(fromSequence, 'COMPILE_GATE_PASSED'), event(fromSequence + 2, 'REVIEW_RECORDED'),
        event(fromSequence + 3, 'REVIEW_GATE_PASSED')];
}

function reclassification(sequence: number): TimelineEventEntry {
    return event(sequence, 'PREFLIGHT_CLASSIFIED', classification('f'.repeat(64)));
}
