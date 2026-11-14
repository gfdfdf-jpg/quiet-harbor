// Measurement only: keep the native loader, module bytes, memo result, callback,
// exception and freshness validators. Observe the semantic key of work actually
// executed inside an existing memo factory, including a regressed double build.
const { createHash } = require('node:crypto');
const installed = new WeakSet();
const codeInstalled = new WeakSet();
const owners = {
    'derive:getReviewContextContractViolations': 'review-context-contract-violations',
    'derive:resolvePersistedRemediationReviewExecutionAuthority': 'persisted-remediation-review-execution-authority',
    'derive:authoritative_coverage_scope': 'authoritative-review-coverage-contract'
};
function installRecordedWorkObserver(memo, measurement) {
    if (installed.has(memo)) return;
    installed.add(memo);
    const originalMemo = memo.memoizeInvocationRead, originalCount = measurement.countNextStepWork;
    const stack = [];
    memo.memoizeInvocationRead = function (key, memoId, build) {
        const owner = key.token.description;
        if (!Object.values(owners).includes(owner)) return originalMemo(key, memoId, build);
        return originalMemo(key, memoId, () => {
            stack.push({ owner, memoId });
            try { return build(); } finally { stack.pop(); }
        });
    };
    measurement.countNextStepWork = function (name, count) {
        originalCount(name, count);
        if (!owners[name]) return;
        const frame = stack.findLast(value => value.owner === owners[name]);
        if (!frame) { originalCount('stand_unit_missing:' + name, count); return; }
        const identity = createHash('sha256').update(frame.memoId).digest('hex');
        originalCount('stand_unit:' + name + ':' + identity, count);
    };
}
module.exports = { installRecordedWorkObserver };

function installLoadedFileObserver(code, files, measurement) {
    if (codeInstalled.has(code)) return;
    codeInstalled.add(code);
    const capture = code.captureLoadedCodeClosure, stack = [], measurements = [];
    const identityModule = Object.values(require.cache).find(module => module?.exports === code)?.filename;
    const measure = measurement.withNextStepMeasurement;
    if (typeof measure === 'function') measurement.withNextStepMeasurement = function (...args) {
        if (measurements.length || typeof args[1] !== 'function' && process.env.GARDA_NEXT_STEP_TIMING !== '1')
            return Reflect.apply(measure, this, args);
        measurements.push(new Map(Object.entries(require.cache)));
        try { return Reflect.apply(measure, this, args); } finally { measurements.pop(); }
    };
    code.captureLoadedCodeClosure = function (domain, roots) {
        if (typeof domain !== 'string' || !Array.isArray(roots) || !roots.every(root => typeof root === 'string'))
            return Reflect.apply(capture, this, [domain, roots]);
        const owner = createHash('sha256').update(JSON.stringify([domain, [...new Set([...roots, ...identityModule ? [identityModule] : []])].sort()])).digest('hex');
        stack.push(owner);
        try { return Reflect.apply(capture, this, [domain, roots]); } finally { stack.pop(); }
    };
    for (const name of ['readInvocationFileContent', 'readInvocationFileContentWithObservation']) {
        const original = files[name];
        files[name] = function (...args) {
            const result = Reflect.apply(original, this, args), owner = stack.at(-1);
            if (owner && result && typeof args[0] === 'string') {
                const identity = owner + ':' + args[0];
                measurement.countNextStepWork('stand_loaded_file:' + identity);
                const started = measurements.at(-1), module = require.cache[args[0]];
                if (started && module && started.get(args[0]) !== module)
                    measurement.countNextStepWork('stand_loaded_loader:' + identity);
                if (name === 'readInvocationFileContent') measurement.countNextStepWork('stand_loaded_fallback:' + identity);
                else if (!result.capturedNow) measurement.countNextStepWork('stand_loaded_retained:' + identity);
            }
            return result;
        };
    }
}
module.exports.installLoadedFileObserver = installLoadedFileObserver;
