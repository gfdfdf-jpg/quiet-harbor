import * as path from 'node:path';
import { installRouteObserver } from './walk-routes';

installRouteObserver(path.resolve('.'));
