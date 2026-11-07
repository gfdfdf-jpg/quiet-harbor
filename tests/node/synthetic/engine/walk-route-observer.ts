import * as path from 'node:path';
import { installRouteObserver } from './walk-routes';

// Timing uses the compiled production resolver, without source instrumentation/getter wrappers.
if (process.env.GARDA_SYNTHETIC_STEP_TIMING !== '1') installRouteObserver(path.resolve('.'));
