'use strict';
const path = require('node:path');
const cp = require('node:child_process');
// The owning targeted test holds the build driver's lock. Recheck its exact
// source/output fingerprints without recursively acquiring that lock.
if (/review-matrix\.cjs$/u.test(process.argv[1] || '')) {
    const spawn = cp.spawnSync;
    cp.spawnSync = function (command, args, options) {
        if (command === process.execPath && args[0] === 'scripts/node-foundation/build-scripts.cjs' && args[1] === 'build.js') {
            const root = options.cwd, b = require(path.join(root, '.scripts-build/scripts/node-foundation/build.js'));
            const publish = args[2] === 'publish-runtime';
            const fingerprint = (publish ? b.buildPublishRuntimeInputFingerprint : b.buildNodeFoundationInputFingerprint)(root);
            const check = b.checkReusableBuildRoot(path.join(root, publish ? 'dist' : '.node-build'),
                path.join(root, publish ? '.scripts-build/publish-runtime-build-cache.json' : '.node-build/node-foundation-manifest.json'),
                fingerprint, 'GARDA_TEST_NO_FORCE', !publish, publish ? path.join(root, 'dist/publish-runtime-manifest.json') : undefined);
            if (!check.accepted) throw new Error('Matrix test requires current compiled source: ' + check.reason);
            return { status: 0 };
        }
        return spawn(command, args, options);
    };
}
