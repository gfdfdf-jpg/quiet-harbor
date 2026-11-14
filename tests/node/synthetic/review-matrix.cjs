'use strict';
// Development stand only. Not loaded by the installed CLI or included in the npm package.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const root = path.resolve(__dirname, '../../..');
const build = path.join(root, '.node-build');
const selectedProvider = process.env.GARDA_SYNTHETIC_WALK_PROVIDER || process.env.STAND_PROVIDER || 'Codex';
if (!['Codex', 'Claude'].includes(selectedProvider)) throw new Error('Unknown synthetic provider');
process.env.GARDA_SYNTHETIC_WALK_PROVIDER = selectedProvider;
const args = process.argv.slice(2);
const action = args.shift();
const options = {};
while (args.length) {
    const key = args.shift();
    if (!['--report', '--shard', '--partition', '--only', '--inputs'].includes(key) || !args.length || Object.hasOwn(options, key.slice(2))) throw new Error('Expected unique known --option value');
    options[key.slice(2)] = args.shift();
}
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const atomic = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.' + process.pid + '.tmp'; fs.writeFileSync(temporary, JSON.stringify(value) + '\n'); fs.renameSync(temporary, file);
};
const sourceIdentity = () => {
    const git = argv => cp.execFileSync('git', ['-c', 'safe.directory=' + root, ...argv], { cwd: root, encoding: 'utf8', windowsHide: true });
    const files = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'src', 'tests', 'template', 'scripts', 'bin', 'docs/stand',
        'package.json', 'package-lock.json', 'tsconfig*.json'])
        .split('\0').filter(Boolean).sort();
    return { commit: git(['rev-parse', 'HEAD']).trim(), platform: process.platform, arch: process.arch,
        node: process.version, provider: selectedProvider,
        digest: hash([...new Set(files)].map(file => [file, fs.existsSync(path.join(root, file))
            ? crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') : null])) };
};
if (!['run', 'merge', 'inventory'].includes(action)) throw new Error('Use run, merge or inventory');
// Use the same locked, fingerprint-checked compiler as stand.cjs. A stale .node-build can never certify new source.
for (const target of action === 'run' ? ['publish-runtime', 'node-foundation'] : ['node-foundation']) {
    const compilation = cp.spawnSync(process.execPath, ['scripts/node-foundation/build-scripts.cjs', 'build.js', target],
        { cwd: root, stdio: ['ignore', 2, 2], windowsHide: true });
    if (compilation.error) throw compilation.error;
    if (compilation.status !== 0) throw new Error('Current source compilation failed (' + target + '): ' + compilation.status);
}
const matrix = require(path.join(build, 'tests/node/synthetic/engine/common-review-matrix.js'));
const inventory = matrix.commonReviewMatrixCells();
const catalogHash = hash({ rows: matrix.COMMON_REVIEW_MATRIX, cells: inventory });
async function run() {
    if (!['run', 'merge', 'inventory'].includes(action)) throw new Error('Use run, merge or inventory');
    if (action === 'inventory') { console.log(JSON.stringify({ catalogHash, rows: matrix.COMMON_REVIEW_MATRIX, cells: inventory,
        auditControls: matrix.COMMON_REVIEW_MATRIX.filter(row => row.id.startsWith('audit-')).map(row => ({ id: row.id, rule: row.rule,
            expected: matrix.matrixLaunchContract(row) })) }, null, 2)); return; }
    if (!options.report) throw new Error('--report is required');
    const output = path.resolve(options.report);
    if (fs.existsSync(output)) throw new Error('Use a new report directory; failed runs are never overwritten');
    fs.mkdirSync(output, { recursive: true });
    const source = sourceIdentity();
    if (action === 'merge') {
        if (!options.inputs) throw new Error('merge requires --inputs');
        const parts = [], evidenceFiles = new Map();
        const visit = directory => {
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                const file = path.join(directory, entry.name);
                if (entry.isDirectory()) visit(file);
                else if (entry.name === 'review-matrix-partial.json') parts.push(JSON.parse(fs.readFileSync(file, 'utf8')));
                else if (/\.json(?:\.gz)?$/u.test(entry.name) && path.basename(directory) === 'cells')
                    evidenceFiles.set(entry.name, [...evidenceFiles.get(entry.name) || [], file]);
            }
        };
        visit(path.resolve(options.inputs));
        const problems = [], results = parts.flatMap(part => part.results);
        for (const part of parts) {
            if (part.catalogHash !== catalogHash || hash(part.source) !== hash(source)) problems.push('source-or-catalog-mismatch:' + part.shard);
            if (!part.complete) problems.push('unfinished-shard:' + part.shard);
            problems.push(...part.problems);
        }
        for (const result of results) {
            const cell = inventory.find(item => item.id === result.id);
            if (!cell) continue;
            if (![result.id + '.json', result.id + '.json.gz'].includes(result.evidenceFile)) {
                problems.push('invalid-native-evidence-path:' + result.id); continue;
            }
            const candidates = evidenceFiles.get(result.evidenceFile) || [];
            if (candidates.length !== 1 || crypto.createHash('sha256').update(fs.readFileSync(candidates[0])).digest('hex') !== result.evidenceSha256) {
                problems.push('missing-or-modified-native-evidence:' + result.id);
                continue;
            }
            const bytes = fs.readFileSync(candidates[0]);
            const retained = JSON.parse((result.evidenceFile.endsWith('.gz') ? zlib.gunzipSync(bytes) : bytes).toString('utf8'));
            if (hash(retained.cell) !== hash(cell) || hash(retained.source) !== hash(source)) problems.push('foreign-native-evidence:' + result.id);
            // Judge native records again; a rewritten summary cannot turn a red trace green.
            const engine = require(path.join(build, 'tests/node/synthetic/engine/navigator-walk.js'));
            const { nativeReviewMatrixScenario } = require(path.join(build, 'tests/node/synthetic/engine/review-matrix-native.js'));
            const { STACK_MANIFESTS } = require(path.join(build, 'tests/node/synthetic/engine/walk-stack-fixtures.js'));
            const entry = matrix.COMMON_REVIEW_MATRIX.find(row => row.id === cell.row);
            const scenario = nativeReviewMatrixScenario(STACK_MANIFESTS.find(stack => stack.id === cell.stack), entry, cell.mode);
            const judged = { id: result.id, outcome: retained.result.outcome,
                launches: retained.result.reviews.map(review => review.lane + ':' + review.mode), nativeSteps: retained.result.steps.length,
                findings: engine.compareWalk(scenario, retained.result).map(finding => finding.id + ': ' + finding.summary) };
            for (const key of ['outcome', 'launches', 'nativeSteps', 'findings'])
                if (hash(judged[key]) !== hash(result[key])) problems.push('summary-disagrees-with-native:' + result.id + ':' + key);
            problems.push(...matrix.reviewMatrixProblems([judged], [cell]));
        }
        problems.push(...matrix.reviewMatrixProblems(results, inventory));
        atomic(path.join(output, 'review-matrix-verdict.json'), { source, catalogHash, expected: inventory.length,
            completed: results.length, problems, verdict: problems.length ? 'FAIL' : 'PASS' });
        console.log('Common review matrix: ' + results.length + '/' + inventory.length + ', ' + (problems.length ? 'FAIL' : 'PASS'));
        if (problems.length) { console.error(problems.slice(0, 30).join('\n')); process.exitCode = 1; }
        return;
    }
    const match = /^(\d+)\/(\d+)$/u.exec(options.shard || '1/1');
    if (!match || +match[1] < 1 || +match[1] > +match[2] || +match[2] > 128) throw new Error('shard must be 1..total, total <=128');
    const shard = +match[1], total = +match[2];
    const worker = /^(\d+)\/(\d+)$/u.exec(options.partition || '1/1');
    if (!worker) throw new Error('partition must be index/total');
    const selectedIds = options.only?.split(',');
    if (selectedIds?.some(id => !inventory.some(cell => cell.id === id))) throw new Error('Unknown matrix cell selection');
    const selected = matrix.selectCommonReviewCells(inventory, { index: shard, total }, { index: +worker[1], total: +worker[2] })
        .filter(cell => !selectedIds || selectedIds.includes(cell.id));
    if (selectedIds && !selected.length) throw new Error('Selected cells belong to another shard/worker partition');
    const providers = require(path.join(build, 'src/core/provider/provider-registry.js'));
    for (const marker of providers.getProviderEnvironmentDetectionMarkers()) delete process.env[marker];
    delete process.env.GARDA_EXECUTION_PROVIDER;
    const engine = require(path.join(build, 'tests/node/synthetic/engine/navigator-walk.js'));
    const provider = providers.getProviderEntryById(providers.normalizeProviderId(engine.WALK_PROVIDER) || engine.WALK_PROVIDER);
    if (!provider?.environmentDetection.markers[0]) throw new Error('Native fixture needs registered provider identity');
    process.env[provider.environmentDetection.markers[0]] = '1';
    const { STACK_MANIFESTS } = require(path.join(build, 'tests/node/synthetic/engine/walk-stack-fixtures.js'));
    const { nativeReviewMatrixScenario } = require(path.join(build, 'tests/node/synthetic/engine/review-matrix-native.js'));
    process.env.GARDA_ALLOW_COMMIT = '1';
    const results = [], problems = [], templates = new Map();
    const save = complete => atomic(path.join(output, 'review-matrix-partial.json'), { schema: 1, source, catalogHash,
        shard: shard + '/' + total + ':' + worker[1] + '/' + worker[2], complete, selection: selectedIds || null, problems, results });
    save(false);
    try {
        for (const cell of selected) {
            const entry = matrix.COMMON_REVIEW_MATRIX.find(row => row.id === cell.row);
            const scenario = nativeReviewMatrixScenario(STACK_MANIFESTS.find(stack => stack.id === cell.stack), entry, cell.mode);
            const inspect = scenario.inspectResult;
            scenario.inspectResult = async (repoRoot, result) => {
                const retain = () => {
                    for (const relative of ['garda-agent-orchestrator/runtime/reviews', 'garda-agent-orchestrator/runtime/task-events'])
                        fs.cpSync(path.join(repoRoot, relative), path.join(output, 'failure-evidence', cell.id, relative), { recursive: true });
                };
                try { await inspect?.(repoRoot, result); }
                catch (error) {
                    retain();
                    throw error;
                }
                if (engine.compareWalk(scenario, result).length) retain();
            };
            // Templates contain immutable install bytes. Mutable task plans and native receipts are per walk.
            const key = hash(scenario.fixture);
            let template = templates.get(key);
            if (!template) { template = await engine.createWalkTemplate(root, scenario.fixture); templates.set(key, template); }
            const result = await engine.walkTask(template, scenario);
            const findings = engine.compareWalk(scenario, result).map(finding => finding.id + ': ' + finding.summary);
            const record = { id: cell.id, outcome: result.outcome, launches: result.reviews.map(review => review.lane + ':' + review.mode),
                findings, nativeSteps: result.steps.length };
            // Retain all measured next-step phases/work counters, distinct from gate duration. This correctness
            // matrix introduces new input shapes; it never rewrites or replaces the original stand's work ceilings.
            const retained = { cell, source, rule: entry.rule, expected: matrix.matrixLaunchContract(entry), result, findings };
            const evidenceFile = path.join(output, 'cells', cell.id + (findings.length ? '.json' : '.json.gz'));
            fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
            if (findings.length) atomic(evidenceFile, retained);
            else fs.writeFileSync(evidenceFile, zlib.gzipSync(Buffer.from(JSON.stringify(retained)), { level: 6 }));
            record.evidenceFile = path.basename(evidenceFile);
            record.evidenceSha256 = crypto.createHash('sha256').update(fs.readFileSync(evidenceFile)).digest('hex');
            results.push(record);
            save(false);
            console.log('Matrix ' + results.length + '/' + selected.length + ' ' + cell.id + ' ' + result.outcome + ' findings=' + findings.length);
        }
        problems.push(...matrix.reviewMatrixProblems(results, selected));
        if (hash(sourceIdentity()) !== hash(source)) problems.push('source-changed-during-execution');
        save(true);
        if (problems.length) { console.error(problems.slice(0, 30).join('\n')); process.exitCode = 1; }
    } finally {
        for (const template of templates.values()) {
            const target = path.resolve(template);
            if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('garda-walk-template-'))
                throw new Error('Refuse unexpected cleanup target');
            fs.rmSync(target, { recursive: true, force: true });
        }
    }
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; });
