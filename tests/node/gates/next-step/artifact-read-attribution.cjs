'use strict';

// Opt-in diagnostic for the in-process synthetic walk. Example:
// GARDA_READ_TRACE_ROOT=<checkout> GARDA_READ_TRACE_OUT=<new file> NODE_OPTIONS=--require=<this file>
// Use {pid} in the output name for parallel workers. Each JSONL record is one navigator invocation;
// repeated paths include the full source stacks responsible for each payload read.
if (process.env.GARDA_READ_TRACE_ROOT && process.env.GARDA_READ_TRACE_OUT
    && process.argv.some(arg => /synthetic-navigator-walk\.test\.js$/u.test(arg))) {
    const fs = require('node:fs');
    const path = require('node:path');
    const measurement = require(path.join(process.env.GARDA_READ_TRACE_ROOT, '.node-build/src/core/next-step-measurement.js'));
    const originalMeasurement = measurement.withNextStepMeasurement;
    const original = { readFileSync: fs.readFileSync, openSync: fs.openSync, readSync: fs.readSync, closeSync: fs.closeSync };
    let invocation = 0;
    if (process.setSourceMapsEnabled) process.setSourceMapsEnabled(true);
    Error.stackTraceLimit = 40;

    measurement.withNextStepMeasurement = function (run, capture, options) {
        if (typeof capture !== 'function') return originalMeasurement(run, capture, options);
        const reads = new Map();
        const descriptors = new Map();
        let wholeFileDepth = 0;
        let recording = false;
        const record = file => {
            if (recording || typeof file !== 'string') return;
            const absolute = path.resolve(file);
            // Discard executable/source loading and record the synthetic repository only.
            if (!/garda-walk-[^\\/]+[\\/]/iu.test(absolute)) return;
            recording = true;
            try {
                const frames = (new Error().stack || '').split('\n').slice(1)
                    .filter(frame => /[\\/]src[\\/]/u.test(frame))
                    .map(frame => frame.trim().replace(/^.*?([\\/]src[\\/])/u, 'src/').replace(/\\/gu, '/'));
                const calls = reads.get(absolute) || [];
                calls.push(frames);
                reads.set(absolute, calls);
            } finally { recording = false; }
        };
        fs.openSync = function (file, ...args) {
            const fd = original.openSync.call(this, file, ...args);
            if (typeof file === 'string') descriptors.set(fd, { file, seen: false });
            return fd;
        };
        fs.closeSync = function (fd) {
            try { return original.closeSync.call(this, fd); }
            finally { descriptors.delete(fd); }
        };
        fs.readSync = function (fd, ...args) {
            const count = original.readSync.call(this, fd, ...args);
            const descriptor = descriptors.get(fd);
            if (!wholeFileDepth && descriptor && !descriptor.seen && count >= 0) {
                descriptor.seen = true;
                record(descriptor.file);
            }
            return count;
        };
        fs.readFileSync = function (file, ...args) {
            wholeFileDepth++;
            try {
                const result = original.readFileSync.call(this, file, ...args);
                record(typeof file === 'number' ? descriptors.get(file)?.file : file);
                return result;
            } finally { wholeFileDepth--; }
        };
        let result;
        try { result = originalMeasurement(run, capture, options); return result; }
        finally {
            Object.assign(fs, original);
            const repeated = [...reads].filter(([, calls]) => calls.length > 1)
                .map(([file, calls]) => ({ file, calls }));
            const output = process.env.GARDA_READ_TRACE_OUT.replace('{pid}', String(process.pid));
            fs.appendFileSync(output, JSON.stringify({
                invocation: invocation++, result, repeated
            }) + '\n');
        }
    };
}
