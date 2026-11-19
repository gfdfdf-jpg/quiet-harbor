import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { environment } from './p4-fixtures';

test('historical producer environment preserves Path and PATH and exposes one child search path', () => {
    for (const key of ['Path', 'PATH', 'path']) {
        const original = { [key]: 'fixture-git-and-tar', GIT_CONFIG_PARAMETERS: 'foreign override', NODE_TEST_CONTEXT: 'child-v8' };
        const env = environment(original);
        assert.deepEqual(Object.keys(env).filter(name => name.toUpperCase() === 'PATH'), ['PATH']);
        assert.ok(env.PATH!.split(path.delimiter).includes('fixture-git-and-tar'));
        if (process.platform === 'win32') assert.equal(env.PATH!.split(path.delimiter)[0], 'C:\\Windows\\System32');
        assert.equal(env.GIT_CONFIG_PARAMETERS, undefined);
        assert.equal(env.NODE_TEST_CONTEXT, undefined);
        assert.equal(original[key], 'fixture-git-and-tar');
    }
    assert.ok(environment({ Path: 'shadow', PATH: 'canonical' }).PATH!.split(path.delimiter).includes('canonical'));
});
