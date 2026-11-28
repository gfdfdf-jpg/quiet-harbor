import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import { describe, it } from 'node:test';

/** The compiled modules a fresh process loads for one entry module, as repository-relative paths without extensions. */
function loadedModules(entry: string): string[] {
    const output = childProcess.execFileSync(process.execPath, ['-e',
        'require(process.argv[1]); process.stdout.write(JSON.stringify(Object.keys(require.cache)));',
        require.resolve(entry)], { encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    return (JSON.parse(output) as string[]).map(file => file.split(path.sep).join('/').replace(/\.[cm]?js$/u, ''));
}

describe('split-required WIP restore module graph', () => {
    // CI (Node 26): a value import of parent-audit-navigation in the no-dead-end invariant pulled ~350 extra modules
    // (+25 MB RSS) into the restore child and broke its 256 MiB peak budget. The budget stays; the graph stays small.
    it('loading the restore plan does not load the parent-audit navigation graph', () => {
        const modules = loadedModules('../../../../src/gates/split-required/split-required-wip-restore-plan');
        assert.ok(modules.some(file => file.endsWith('/gates/split-required/split-required-wip-restore-plan')), 'entry loaded');
        const navigation = modules.filter(file => file.endsWith('/gates/parent-audit/parent-audit-navigation'));
        assert.deepEqual(navigation, [], `restore plan loads ${modules.length} modules, including parent-audit-navigation`);
    });

    it('the no-dead-end invariant stays a leaf module', () => {
        const modules = loadedModules('../../../../src/gates/next-step/next-step-progress-invariant')
            .filter(file => !file.includes('/node_modules/'))
            .map(file => file.slice(file.lastIndexOf('/src/') + 1)).sort();
        assert.deepEqual(modules, ['src/core/command-quoting', 'src/gates/next-step/next-step-progress-invariant',
            'src/gates/parent-audit/parent-audit-source-prerequisites-reason']);
    });
});
