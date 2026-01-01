// Test-only clock/measurement adapter. The installed launcher installs its own genuine source-receipt
// bootstrap before importing application code. No loader, source or receipt is replaced here.
const path = require('node:path');
const offset = Number(process.env.GARDA_SYNTHETIC_NATIVE_CLOCK_MS);
if (!Number.isFinite(offset)) throw new Error('Invalid native walk clock offset');
const RealDate = Date;
globalThis.Date = class extends RealDate {
    constructor(...values) { super(...(values.length ? values : [RealDate.now() + offset])); }
    static now() { return RealDate.now() + offset; }
};
const launcher = path.resolve('garda-agent-orchestrator/bin/garda.js');
const cli = require(launcher);
const { installRecordedWorkObserver, installLoadedFileObserver } = require('./walk-recorded-work-observer.cjs');
installRecordedWorkObserver(require(path.resolve('garda-agent-orchestrator/dist/src/core/invocation-read-observation.js')),
    require(path.resolve('garda-agent-orchestrator/dist/src/core/next-step-measurement.js')));
installLoadedFileObserver(require(path.resolve('garda-agent-orchestrator/dist/src/core/loaded-code-identity.js')),
    require(path.resolve('garda-agent-orchestrator/dist/src/core/invocation-file-observation.js')),
    require(path.resolve('garda-agent-orchestrator/dist/src/core/next-step-measurement.js')));
if (process.env.GARDA_STAND_COUNTER_ATTRIBUTION === '1') require('./walk-counter-attribution.cjs').installCounterAttribution(
    require('node:fs'), require(path.resolve('garda-agent-orchestrator/dist/src/core/next-step-measurement.js')));
void cli.main(process.argv.slice(2)).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
