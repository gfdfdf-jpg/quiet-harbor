'use strict';
require('./matrix-current-build.cjs');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
if (/review-matrix\.cjs$/u.test(process.argv[1] || '')) {
    const spawn = cp.spawnSync, load = Module._load, wrapped = new WeakSet();
    const exhausted = process.env.GARDA_MATRIX_SHELL_MODE === 'exhausted';
    let restarting = false, injected = 0, launches = 0, observed = false;
    cp.spawnSync = function (command, args, options) {
        if (restarting && command === process.execPath && args[1] === '--version'
            && path.basename(args[0]) === 'garda.js') {
            launches += 1;
            if (injected < (exhausted ? 3 : 1)) {
                injected += 1;
                assert.equal(options.timeout, 10_000);
                return { pid: 0, status: null, signal: 'SIGTERM', stdout: '', stderr: '', output: [null, '', ''],
                    error: Object.assign(new Error('injected CLI launch ETIMEDOUT'), { code: 'ETIMEDOUT' }) };
            }
        }
        return spawn(command, args, options);
    };
    Module._load = function (request, parent, isMain) {
        const exports = load(request, parent, isMain);
        const file = Module._resolveFilename(request, parent);
        if (typeof file === 'string' && /[\\/]gate-flows[\\/]recovery[\\/]recovery-flow-review-cycle\.js$/u.test(file)
            && typeof exports.runRestartReviewCycleCommand === 'function' && !wrapped.has(exports)) {
            wrapped.add(exports);
            const handle = exports.runRestartReviewCycleCommand;
            exports.runRestartReviewCycleCommand = async function (options, ...args) {
                const previous = restarting;
                restarting = true;
                try {
                    let result = await handle.call(this, options, ...args);
                    if (injected && !observed) {
                        observed = true;
                        const repo = options.repoRoot || '.';
                        const artifactPath = path.resolve(repo, 'garda-agent-orchestrator/runtime/reviews/T-WALK-shell-smoke.json');
                        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
                        const evidence = { injected, launches, artifact, restart: result };
                        fs.writeFileSync(process.env.GARDA_MATRIX_SHELL_LOG, JSON.stringify(evidence));
                        const probe = artifact.probes.find(p => p.check === 'cli_launchability');
                        assert.deepEqual(probe.attempts.map(a => a.status), exhausted ? ['timeout', 'timeout', 'timeout'] : ['timeout', 'ok']);
                        if (exhausted) {
                            assert.notEqual(result.exitCode, 0);
                            assert.equal(artifact.outcome, 'FAIL');
                            const output = result.outputLines.join('\n');
                            assert.match(output, /REVIEW_CYCLE_RESTART_FAILED/u);
                            assert.match(output, /launch timed out 3 times/u);
                            const retry = /Retry command: ([^\r\n]+)/u.exec(output)?.[1];
                            assert.ok(retry, 'the failed real restart publishes the exact recovery command');
                            // Execute the published command from a different cwd, as an agent would.
                            const recovery = spawn(process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
                                process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', retry] : ['-c', retry],
                                { cwd: process.env.TMP, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
                            evidence.recovery = { command: retry, status: recovery.status, stdout: recovery.stdout, stderr: recovery.stderr };
                            fs.writeFileSync(process.env.GARDA_MATRIX_SHELL_LOG, JSON.stringify(evidence));
                            assert.equal(recovery.status, 0, recovery.stdout + recovery.stderr);
                            evidence.recoveredArtifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
                            assert.equal(evidence.recoveredArtifact.outcome, 'PASS');
                            result = await handle.call(this, options, ...args);
                            evidence.resumedRestart = result;
                            fs.writeFileSync(process.env.GARDA_MATRIX_SHELL_LOG, JSON.stringify(evidence));
                        }
                        assert.equal(result.exitCode, 0, result.outputLines.join('\n'));
                    }
                    return result;
                } finally { restarting = previous; }
            };
        }
        return exports;
    };
}
