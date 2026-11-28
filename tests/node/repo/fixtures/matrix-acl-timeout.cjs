'use strict';
require('./matrix-current-build.cjs');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const write = fs.writeFileSync;
if (/review-matrix\.cjs$/u.test(process.argv[1] || '')) {
    const spawn = cp.spawnSync;
    const load = Module._load, wrapped = new WeakSet();
    let injected = false, restarting = false;
    Module._load = function (request, parent, isMain) {
        const exports = load(request, parent, isMain);
        const file = Module._resolveFilename(request, parent);
        if (typeof file === 'string' && /[\\/]src[\\/]cli[\\/]commands[\\/]gate-command\.js$/u.test(file)
            && typeof exports.handleGate === 'function' && !wrapped.has(exports)) {
            wrapped.add(exports);
            const handle = exports.handleGate;
            exports.handleGate = async function (argv, ...args) {
                const previous = restarting;
                restarting = previous || argv[0] === 'restart-review-cycle';
                try { return await handle.call(this, argv, ...args); }
                finally { restarting = previous; }
            };
        }
        return exports;
    };
    cp.spawnSync = function (command, args, options) {
        if (!injected && restarting && path.basename(command).toLowerCase() === 'icacls.exe'
            && /[\\/]runtime[\\/]task-events$/u.test(args[0])) {
            const limit = Error.stackTraceLimit;
            Error.stackTraceLimit = 200;
            const stack = new Error().stack;
            Error.stackTraceLimit = limit;
            injected = true;
            write(process.env.GARDA_MATRIX_ACL_INJECTION_LOG, JSON.stringify({ gate: 'restart-review-cycle', command, args, timeout: options.timeout, stack }));
            return { pid: 0, status: null, signal: 'SIGTERM', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
                output: [null, Buffer.alloc(0), Buffer.alloc(0)], error: Object.assign(new Error('injected native ACL timeout'), { code: 'ETIMEDOUT' }) };
        }
        return spawn(command, args, options);
    };
}
