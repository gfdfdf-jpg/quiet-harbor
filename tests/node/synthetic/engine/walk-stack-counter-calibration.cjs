'use strict';
// Independent, opt-in experiment against native temporary stand repositories.
// No product decisions or review expectations are replaced.
if (process.env.GARDA_STACK_CALIBRATION_ROOT && process.argv.some(arg => /synthetic-navigator-walk\.test\.js$/u.test(arg))) {
    const fs = require('node:fs');
    const path = require('node:path');
    const source = process.env.GARDA_STACK_CALIBRATION_ROOT;
    const measurement = require(path.join(source, '.node-build/src/core/next-step-measurement.js'));
    const { appendTaskEvent } = require(path.join(source, '.node-build/src/gate-runtime/task-events.js'));
    const { workCounters, normalizeCounterIdentity } = require(path.join(source, '.node-build/tests/node/synthetic/engine/walk-metrics.js'));
    const original = measurement.withNextStepMeasurement;
    const records = [], visited = new Set();
    const routes = new Set(['load-rule-pack', 'classify-change', 'compile-gate', 'restart-coherent-cycle', 'materialize-review-follow-up-tasks']);
    const fixtures = new Set(['unknown-quartz', 'spring-maven', 'polyglot-maven-ts']);
    const counters = value => workCounters({ measurement: value });
    measurement.withNextStepMeasurement = function (run, capture, options) {
        if (typeof capture !== 'function') return original(run, capture, options);
        let before;
        let first;
        try { first = original(run, value => { before = value; }, options); }
        catch (error) { if (before) capture(before); throw error; }
        const root = process.cwd();
        const manifestPath = path.join(root, '.stand-fixture.json');
        if (!before || !first || !routes.has(first.next_gate) || !fs.existsSync(manifestPath)) {
            capture(before); return first;
        }
        const fixture = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const task = JSON.parse(fs.readFileSync(path.join(root, '.git/stand-task.json'), 'utf8'));
        const command = first.commands?.[0]?.command ?? '';
        const stage = /--stage\s+["']?([A-Z_]+)/u.exec(command)?.[1] ?? '';
        const key = [fixture.id, task.archetype, first.next_gate, stage].join(':');
        if (!fixtures.has(fixture.id) || visited.has(key)) { capture(before); return first; }
        visited.add(key);
        // Native publication lazily materializes cadence/history inputs. Stabilize that input
        // cohort before comparing two navigations whose only difference is five more events.
        appendTaskEvent(path.join(root, 'garda-agent-orchestrator'), 'T-WALK',
            'SYNTHETIC_COUNTER_PROBE', 'INFO', 'Warm native publisher inputs before calibration.', { calibration: true, warmup: true }, { actor: 'gate' });
        original(run, value => { before = value; }, options);
        for (let index = 0; index < 5; index++) appendTaskEvent(path.join(root, 'garda-agent-orchestrator'), 'T-WALK',
            'SYNTHETIC_COUNTER_PROBE', 'INFO', 'Independent history-only calibration.', { calibration: true, index }, { actor: 'gate' });
        let after;
        const second = original(run, value => { after = value; }, options);
        capture(after);
        const left = counters(before), right = counters(after);
        const constant = key => /^(?:subprocess:|file_probes:|file_hash:file$|payload_reads$|timeline_(?:capture|payload_read|parse|verify):?)/u.test(key);
        const increases = Object.keys(right).filter(key => constant(key) && right[key] > (left[key] ?? 0))
            .map(key => ({ counter: key, before: left[key] ?? 0, after: right[key] }));
        const inputs = Object.keys(after.work).filter(key => /^(?:file_hash:|payload_read:|process:|acl_probe:)/u.test(key))
            .map(key => normalizeCounterIdentity(key));
        const beforeInputs = Object.keys(before.work).filter(key => /^(?:file_hash:|payload_read:|process:|acl_probe:)/u.test(key))
            .map(key => normalizeCounterIdentity(key));
        records.push({ fixture: fixture.id, archetype: task.archetype, route: first.status + '/' + first.next_gate,
            stage, warmupEvents: 1, appendedEvents: 5, sameRoute: first.next_gate === second.next_gate && first.status === second.status,
            targets: task.invocations.flatMap(run => run.targets), before: left, after: right, increases, beforeInputs, inputs });
        const directory = process.env.GARDA_STACK_CALIBRATION_OUTPUT;
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, process.pid + '.json'), JSON.stringify(records, null, 2) + '\n');
        return second;
    };
}
