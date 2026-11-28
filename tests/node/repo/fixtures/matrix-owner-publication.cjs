'use strict';
// Force the real child to be ready before its real owner publishes child_pid.
// The observer can be descheduled after reading the old, valid marker bytes.
const fs = require('node:fs');
const path = require('node:path');
require('./matrix-current-build.cjs');
const read = fs.readFileSync, rename = fs.renameSync, exists = fs.existsSync, write = fs.writeFileSync;
const append = fs.appendFileSync;
const trace = detail => { if (process.env.GARDA_MATRIX_OWNER_LOG) append(process.env.GARDA_MATRIX_OWNER_LOG, JSON.stringify({ pid: process.pid, detail }) + '\n'); };
const parent = /review-matrix\.cjs$/u.test(process.argv[1] || '');
const owner = /walk-native-owner\.js$/u.test(process.argv[1] || '');
trace({ argv: process.argv, parent, owner });
const marker = file => typeof file === 'string' && file.endsWith('T-WALK-full-suite-run-marker.json');
const control = file => path.resolve(path.dirname(file), '../../..', '.git/matrix-marker-observed');
function wait(label, condition) {
    const deadline = performance.now() + 30_000;
    while (!condition()) {
        if (performance.now() >= deadline) throw new Error('Owner publication test handshake timed out: ' + label);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
}
if (owner) fs.renameSync = function (from, to) {
    const child = marker(to) && JSON.parse(read(from, 'utf8')).child_pid;
    if (Number.isSafeInteger(child) && child > 0) {
        trace({ publication: to, control: control(to) });
        wait('observer', () => exists(control(to)));
        trace('observer released publication');
        const result = rename(from, to);
        write(control(to) + '.published', String(process.pid));
        trace({ published: to, child_pid: child });
        return result;
    }
    return rename(from, to);
};
const observed = new Set();
if (parent) fs.readFileSync = function (file, ...args) {
    const bytes = read(file, ...args);
    const value = marker(file) && JSON.parse(bytes.toString());
    if (value && value.child_pid === null && value.gate_pid !== process.pid && !observed.has(file)
        && exists(path.join(path.dirname(control(file)), 'matrix-tests-ready'))) {
        observed.add(file);
        write(control(file), 'observer captured the pre-publication marker');
        trace({ observation: file, control: control(file) });
    }
    return bytes;
};
// Return the old observation immediately: waiting inside readFileSync keeps its
// caller's observation/event-loop turn open. Gate the independent competing CLI
// instead, so the original stale snapshot deterministically fails preservation.
if (/main\.js$/u.test(process.argv[1] || '') && process.argv[2] === 'gate' && process.argv[3] === 'full-suite-validation') {
    const file = path.resolve(process.cwd(), 'garda-agent-orchestrator/runtime/reviews/T-WALK-full-suite-run-marker.json');
    if (exists(control(file))) wait('published owner marker', () => exists(control(file) + '.published'));
}
