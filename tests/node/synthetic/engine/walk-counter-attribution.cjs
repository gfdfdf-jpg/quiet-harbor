// Opt-in diagnosis only. Forward every native probe unchanged and retain its
// source caller and input identity alongside the ordinary measurement.
function installCounterAttribution(fs, measurement) {
    const wrap = (owner, name, label) => {
        const original = owner[name];
        const wrapped = function (...args) {
            const previous = Error.stackTraceLimit;
            let stack;
            try { Error.stackTraceLimit = 32; stack = String(new Error().stack); } finally { Error.stackTraceLimit = previous; }
            const frames = stack.split('\n').filter(line => /[\\/]dist[\\/]src[\\/]/.test(line)
                && !/(?:next-step-measurement|file-stat|invocation-file-observation|invocation-read-observation|derivation-observation-recorder|immutable-json|paths)\.js/.test(line));
            const caller = frames.slice(0, 2).map(line => line.trim().replace(/^.*?[\\/]dist[\\/]src[\\/]/, 'src/').replace(/\\/g, '/')).join('|');
            const file = String(args[0]).replace(/\\/g, '/').replace(/^.*?garda-walk-[^/]+\//, '');
            measurement.countNextStepWork('stand_io:' + label + ':' + caller + ':' + file);
            return Reflect.apply(original, this, args);
        };
        if (original.native) wrapped.native = original.native;
        owner[name] = wrapped;
    };
    for (const name of ['existsSync', 'lstatSync', 'realpathSync']) wrap(fs, name, name);
    wrap(fs.realpathSync, 'native', 'realpathSync.native');
}
module.exports = { installCounterAttribution };
