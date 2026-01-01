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
function wait(condition) {
    const deadline = performance.now() + 30_000;
    while (!condition()) {
        if (performance.now() >= deadline) throw new Error('Owner publication test handshake timed out');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
}
if (owner) fs.renameSync = function (from, to) {
    if (marker(to) && JSON.parse(read(from, 'utf8')).child_pid !== null) {
        trace({ publication: to, control: control(to) });
        wait(() => exists(control(to)));
        trace('observer released publication');
    }
    return rename(from, to);
};
if (parent) fs.readFileSync = function (file, ...args) {
    const bytes = read(file, ...args);
    if (marker(file) && JSON.parse(bytes.toString()).child_pid === null
        && exists(path.join(path.dirname(control(file)), 'matrix-tests-ready'))) {
        write(control(file), 'observer captured the pre-publication marker');
        trace({ observation: file, control: control(file) });
        wait(() => JSON.parse(read(file, 'utf8')).child_pid !== null);
    }
    return bytes;
};
