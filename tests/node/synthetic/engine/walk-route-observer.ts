import * as path from 'node:path';
import { installRouteObserver } from './walk-routes';
import { canonicalizeTempRoot, installRootChainProbes } from './walk-root-chain';

// Timing uses the compiled production resolver, without source instrumentation/getter wrappers.
if (process.env.GARDA_SYNTHETIC_STEP_TIMING !== '1') {
    installRouteObserver(path.resolve('.'));
    // Before any fixture root exists: one spelling of the same temp location, whatever TMP/TEMP/TMPDIR said.
    canonicalizeTempRoot();
    installRootChainProbes();
}
