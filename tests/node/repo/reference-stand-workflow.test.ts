import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { referenceStandMatrix } = require(path.resolve('scripts/ci/reference-stand-matrix.cjs')) as {
    referenceStandMatrix: (env: NodeJS.ProcessEnv) => {
        shards: { include: Array<{ os: string; runner: string; shard: number; total: number; review_stacks: string }> };
        systems: { include: Array<{ os: string; runner: string }> } };
};
const env = { STAND_LEVEL: 'full', STAND_LINUX_SHARDS: '10', STAND_WINDOWS_SHARDS: '16', STAND_SEED: '1785881697', STAND_OS: 'both',
    STAND_LINUX_REVIEW_STACKS: 'all', STAND_WINDOWS_REVIEW_STACKS: 'seeded', STAND_PROVIDER: 'Codex' };
test('reference stand dispatch validates and bounds the OS/shard matrix and permits one exact failed shard', () => {
    const matrix = referenceStandMatrix(env);
    assert.equal(matrix.shards.include.length, 26); assert.equal(matrix.systems.include.length, 2);
    for (const [os, total, stacks] of [['linux', 10, 'all'], ['windows', 16, 'seeded']] as const) {
        const rows = matrix.shards.include.filter(row => row.os === os);
        assert.deepEqual(rows.map(row => row.shard), Array.from({ length: total }, (_, index) => index + 1));
        assert.ok(rows.every(row => row.total === total && row.review_stacks === stacks), os);
    }
    // Defaults: Linux carries every deep family on every stack; Windows keeps full with the seeded deep rotation and more shards.
    const defaults = referenceStandMatrix({ STAND_LEVEL: 'full', STAND_SEED: '1785881697', STAND_OS: 'both', STAND_PROVIDER: 'Codex' });
    assert.deepEqual(defaults.shards.include.filter(row => row.shard === 1).map(row => [row.os, row.total, row.review_stacks]),
        [['linux', 10, 'all'], ['windows', 16, 'seeded']]);
    assert.deepEqual(referenceStandMatrix({ ...env, STAND_OS: 'windows', STAND_ONLY_SHARD: '13' }).shards.include,
        [{ os: 'windows', runner: 'windows-latest', shard: 13, total: 16, review_stacks: 'seeded' }]);
    assert.deepEqual(referenceStandMatrix({ ...env, STAND_OS: 'linux', STAND_ONLY_SHARD: '7' }).shards.include,
        [{ os: 'linux', runner: 'ubuntu-latest', shard: 7, total: 10, review_stacks: 'all' }]);
    for (const invalid of [{ STAND_LINUX_SHARDS: '129' }, { STAND_WINDOWS_SHARDS: '0' }, { STAND_WINDOWS_SHARDS: '1.5' }, { STAND_OS: 'macos' },
        { STAND_SEED: '-1' }, { STAND_SEED: '4294967296' }, { STAND_PROVIDER: 'injected' }, { STAND_LINUX_REVIEW_STACKS: 'none' },
        { STAND_WINDOWS_REVIEW_STACKS: 'none' }, { STAND_ONLY_SHARD: '11' }, { STAND_ONLY_SHARD: '17' }, { STAND_ONLY_SHARD: '0' }])
        assert.throws(() => referenceStandMatrix({ ...env, ...invalid }), JSON.stringify(invalid));
});
test('reference stand is manual only, immutable, bounded, least privilege and uploads partial and merged evidence on failure', () => {
    const workflow = fs.readFileSync(path.resolve('.github/workflows/reference-stand.yml'), 'utf8');
    assert.match(workflow, /^ {2}workflow_dispatch:/mu);
    assert.doesNotMatch(workflow, /^ {2}(?:push|pull_request|schedule|workflow_call|release):/mu);
    assert.match(workflow, /^ {2}contents: read$/mu);
    assert.doesNotMatch(workflow, /(?:contents|actions|id-token): write|secrets: inherit/u);
    assert.ok(workflow.includes('group: ${{ github.workflow }}-${{ github.ref }}'));
    assert.equal((workflow.match(/fail-fast: false/gu) ?? []).length, 2);
    assert.equal((workflow.match(/ref: \$\{\{ github.sha \}\}/gu) ?? []).length, 3);
    assert.equal((workflow.match(/cache: npm/gu) ?? []).length, 2);
    const plan = workflow.slice(workflow.indexOf('  plan:'), workflow.indexOf('  shard:'));
    assert.match(plan, /fetch-depth: 0/u);
    assert.ok(plan.indexOf('Verify pinned native field producer') < plan.indexOf('Validate manual selection'));
    assert.match(plan, /run: node scripts\/ci\/reference-stand-source-fixtures[.]cjs/u);
    assert.match(workflow, /shell: bash/u); assert.match(workflow, /command -v icacls/u);
    for (const timeout of workflow.matchAll(/timeout-minutes: (\d+)/gu)) assert.ok(Number(timeout[1]) < 360);
    assert.match(workflow, /name: Upload partial evidence even on failure\n {8}if: always\(\)/u);
    assert.match(workflow, /name: Upload combined verdict and evidence\n {8}if: always\(\)/u);
    assert.match(workflow, /GITHUB_STEP_SUMMARY/u);
    assert.doesNotMatch(workflow, /run:.*\$\{\{ inputs\./u);
    // Each shard runs its own OS's review selection; workflow_dispatch accepts at most ten inputs.
    assert.match(workflow, /STAND_REVIEW_STACKS: \$\{\{ matrix\.review_stacks \}\}/u);
    assert.match(workflow, /--review-stacks "\$STAND_REVIEW_STACKS"/u);
    const inputs = workflow.slice(workflow.indexOf('    inputs:'), workflow.indexOf('\npermissions:'));
    const names = [...inputs.matchAll(/^ {6}([a-z_]+):\r?$/gmu)].map(match => match[1]);
    assert.deepEqual(names, ['level', 'linux_shards', 'windows_shards', 'seed', 'os', 'linux_review_stacks', 'windows_review_stacks', 'provider', 'only_shard']);
    assert.ok(names.length <= 10);
});
