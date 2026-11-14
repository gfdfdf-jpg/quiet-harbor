import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../../src/core/next-step-measurement';
import { resolveNextStep } from '../../../../src/gates/next-step';

export interface P5Sample {
    route: string;
    variant: string;
    result: ReturnType<typeof resolveNextStep>;
    measurement: NextStepMeasurement;
}

const samples: P5Sample[] = [];

/** No byte normalization or history-counter exclusions: keep the measured boundary visible. */
export function measureP5(route: string, variant: string, action: () => ReturnType<typeof resolveNextStep>): P5Sample {
    let measurement: NextStepMeasurement | undefined;
    const result = withNextStepMeasurement(action, value => { measurement = value; });
    assert.ok(measurement);
    const sample = { route, variant, result, measurement };
    samples.push(sample);
    const requestedReport = process.env.GARDA_P5_REPORT_PATH;
    if (requestedReport) {
        // Node runs each test file in its own process: never overwrite another route file's samples.
        const group = path.basename(process.argv[1] || 'p5').replace(/\.test\.js$/u, '');
        const report = requestedReport.replace(/\.json$/u, '') + '.' + group + '.json';
        fs.mkdirSync(path.dirname(report), { recursive: true });
        const temporary = report + '.' + process.pid + '.tmp';
        fs.writeFileSync(temporary, JSON.stringify({ schema_version: 1, samples }, null, 2) + '\n');
        fs.renameSync(temporary, report);
    }
    return sample;
}

export function p5Counters(sample: P5Sample): Record<string, number> {
    const counters: Record<string, number> = {};
    for (const [key, value] of Object.entries(sample.measurement.work)) {
        // Process identities contain invocation-specific environment digests. Keep every call by native API/executable.
        const stable = key.startsWith('process:') ? key.split(':').slice(0, 3).join(':')
            : key.replace(/(\.lock\.(?:release-intent\.clearing|releasing))-\d+-\d+-[a-f0-9-]{36}/gu, '$1-<pid>-<time>-<id>');
        counters[stable] = (counters[stable] || 0) + value;
    }
    for (const [key, value] of Object.entries(sample.measurement.io || {})) counters['io:' + key] = value.count;
    return counters;
}

export function p5Differences(before: P5Sample, after: P5Sample): { counter: string; before: number; after: number }[] {
    const a = p5Counters(before), b = p5Counters(after);
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap(counter =>
        (a[counter] || 0) === (b[counter] || 0) ? [] : [{ counter, before: a[counter] || 0, after: b[counter] || 0 }]);
}

export interface P5HistoryInput { events: number; bytes: number; previousBytes: number; objects: number; fields: number }

/** Inspect only fixture additions, outside the measured call, retaining their actual input size. */
export function readP5AddedHistory(file: string, previousBytes: number): P5HistoryInput {
    const bytes = fs.readFileSync(file).subarray(previousBytes);
    const records = bytes.toString('utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as unknown);
    let objects = 0, fields = 0;
    const pending = [...records];
    while (pending.length) {
        const value = pending.pop();
        if (value === null || typeof value !== 'object') continue;
        objects++;
        const children = Object.values(value);
        fields += children.length;
        pending.push(...children);
    }
    return { events: records.length, bytes: bytes.length, previousBytes, objects, fields };
}

/** Operator policy: one canonical parse/verification/index pass, linear in the added INFO records.
 * Memo validation retains the parsed JSONL entries and the verifier's references: two visits per
 * input object/field, plus two entry wrappers and seven wrapper/array edges per record. Public
 * metadata is included in the actual input graph. No history counters or bytes are normalized.
 * The content observation's streaming read is attributed by file: only the added 64 KiB history
 * chunks may add readSync calls. All non-history counters retain zero positive growth.
 */
export function assertP5HistoryGrowth(before: P5Sample, after: P5Sample, input: P5HistoryInput): void {
    const addedEvents = input.events, addedBytes = input.bytes;
    const limits: Record<string, number> = {
        timeline_events: addedEvents,
        json_parse_verified_timeline_event: addedEvents,
        'visit:verified_timeline_index_event': addedEvents,
        json_parse_total: addedEvents,
        'io:JSON.parse': addedEvents,
        timeline_bytes: addedBytes,
        'visit:timeline_memoized_object': 2 * input.objects + 2 * addedEvents,
        'visit:timeline_memoized_child': 2 * input.fields + 7 * addedEvents
    };
    let historyPath = '';
    for (const sample of [before, after]) {
        assert.equal(sample.measurement.work.timeline_verify, 1, sample.route + ': exactly one verification');
        const canonicalReads = Object.entries(sample.measurement.work).filter(([key]) => key.startsWith('timeline_payload_read:') && key.endsWith('.jsonl'));
        assert.equal(canonicalReads.length, 1, sample.route + ': one canonical history input');
        assert.equal(canonicalReads[0][1], 1, sample.route + ': canonical history read once');
        historyPath = canonicalReads[0][0].slice('timeline_payload_read:'.length);
        assert.equal(sample.measurement.work.json_parse_verified_timeline_event, sample.measurement.work.timeline_events,
            sample.route + ': every event parsed exactly once');
    }
    const chunkCounter = 'visit:invocation_file_read_chunk:' + historyPath;
    const beforeChunks = before.measurement.work[chunkCounter] || 0;
    const afterChunks = after.measurement.work[chunkCounter] || 0;
    if (beforeChunks || afterChunks) {
        // captureContent owns one forward stream plus its EOF read; never a second stream/hash.
        assert.equal(beforeChunks, Math.ceil(input.previousBytes / (64 * 1024)) + 1);
        assert.equal(afterChunks, Math.ceil((input.previousBytes + input.bytes) / (64 * 1024)) + 1);
        limits[chunkCounter] = afterChunks - beforeChunks;
        limits['io:readSync'] = afterChunks - beforeChunks;
    }
    for (const counter of ['timeline_events', 'json_parse_verified_timeline_event', 'visit:verified_timeline_index_event', 'timeline_bytes']) {
        assert.equal((after.measurement.work[counter] || 0) - (before.measurement.work[counter] || 0), limits[counter],
            before.route + ':' + counter + ': account for every added input');
    }
    const excessive = p5Differences(before, after).filter(row => row.after - row.before > (limits[row.counter] || 0));
    assert.deepEqual(excessive, [], before.route + ': history may grow only by its single canonical pass');
}

export function assertP5ActiveBudget(sample: P5Sample): void {
    const work = sample.measurement.work;
    for (const projection of ['closeout', 'review-attempts', 'review-findings', 'review-timing', 'change-metrics'])
        assert.equal(work['report_projection:' + projection] || 0, 0, sample.route + ':' + projection);
    for (const key of ['visit:timeline_cloned_event', 'visit:audit_ordered_event_copy', 'visit:validation_timeline_parse_event'])
        assert.equal(work[key] || 0, 0, sample.route + ':' + key);
    for (const [key, count] of Object.entries(work)) {
        if (/^(?:file_hash|artifact_bytes|artifact_json_parse):/u.test(key)) assert.equal(count, 1, sample.route + ':' + key);
    }
    for (const key of ['process_measurement_unavailable', 'payload_measurement_unavailable', 'io_measurement_unavailable'])
        assert.equal(work[key] || 0, 0, key);
}

export function assertP5NoIndex(sample: P5Sample): void {
    // Exact named current-artifact membership retains its native authority/permission checks.
    // Forbid catalog acquisition/enumeration and mutable copies, rather than those required inputs.
    for (const [key, count] of Object.entries(sample.measurement.work)
        .filter(([key]) => /^visit:review_index_(?:clone_entry|task_entry|name_entry|candidate|entry)$/u.test(key)))
        assert.equal(count, 0, sample.route + ':' + key);
}

/** aafb5119 Windows ceilings: required initial observations and live final checks, no extra processes. */
export function assertP5ProcessBudget(sample: P5Sample, gitMaximum: number, aclMaximum: number): void {
    const sum = (pattern: RegExp) => Object.entries(sample.measurement.work)
        .filter(([key]) => pattern.test(key)).reduce((total, [, count]) => total + count, 0);
    assert.ok(sum(/^process:[^:]+:git(?:\.exe)?:/u) <= gitMaximum, sample.route + ': Git subprocess budget');
    assert.ok(sum(/^process:[^:]+:icacls(?:\.exe)?:/u) <= aclMaximum, sample.route + ': ACL subprocess budget');
    const failures = Object.keys(sample.measurement.work).filter(key => /^(?:subprocess_timeout:|process_metadata_opaque|process_measurement_unavailable)/u.test(key));
    assert.deepEqual(failures, [], 'Incomplete process observations cannot qualify a budget');
}
