import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { runStand } from '../../../../scripts/node-foundation/synthetic/stand';
import { atomicWalkJson, atomicWalkText, assertWalkResumeIdentity, walkHash } from './walk-run-store';
import { acceptStandBaseline, inspectBaselinePolicy, fileDigest, type BaselineKind } from './stand-baselines';
import { buildStandSummary, renderStandSummary, type StandCheck } from './stand-summary';
import type { StandFinding } from '../../../../scripts/node-foundation/synthetic/model';
import type { WalkReport } from './walk-report';
import { checkQuietMachine, timingEnvironment, TIMING_PROTOCOL, type QuietEvidence, type TimingManifest } from './step-timing';
import type { TimingBaseline, TimingReport } from './step-timing-session';
import { standCheckPlan } from './stand-check-plan';
import { inspectStandProperties, propertyTrace, readStandProperties } from './stand-properties';
import { WALK_SCENARIOS } from './walk-scenarios';
import { expandWalkSelection } from './walk-plan';
import { parseStandShard } from './walk-sharding';
import { mergeReferenceShards, sealReferenceShard } from './reference-shards';
import type { SummaryInput } from './stand-summary';

export interface ReferenceOptions {
    action: 'short' | 'sample' | 'full' | 'sweep' | 'timing' | 'baseline' | 'merge'; report?: string; resume?: string; jobs?: string; seed?: string; only?: string;
    'step-timing'?: boolean; 'machine-busy'?: boolean; 'timing-routes'?: string;
    kind?: string; candidate?: string; reason?: string; release?: string; 'source-commit'?: string; 'expected-sha256'?: string;
    'format-only'?: boolean;
    shard?: string; inputs?: string; 'review-stacks'?: string; provider?: string;
}
function readJson<T>(file: string): T | undefined { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return undefined; } }
/** The same source identity is used before work and on resume; dirty source and fixture bytes are included. */
export function referenceSourceIdentity(root: string) {
    const git = (...args: string[]) => execFileSync('git', ['-c', 'safe.directory=' + root, ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
    const files = [...new Set(git('ls-files', '--cached', '--others', '--exclude-standard', '-z', '--',
        'src', 'template', 'scripts', 'tests', 'docs/stand', 'bin', 'package.json', 'package-lock.json', 'tsconfig*.json').split('\0').filter(Boolean))].sort();
    const digests = Object.fromEntries(files.map(file => [file, fs.existsSync(path.join(root, file)) ? fileDigest(path.join(root, file)) : null]));
    return { sourceCommit: git('rev-parse', 'HEAD').trim(), files: digests, node: process.version, arch: process.arch, platform: process.platform,
        packageHash: walkHash(Object.fromEntries(Object.entries(digests).filter(([file]) => /^(?:src|template|bin)\//u.test(file) || file === 'package.json'))),
        harnessHash: walkHash(Object.fromEntries(Object.entries(digests).filter(([file]) => file.startsWith('tests/node/synthetic/') && /\.(ts|cjs)$/u.test(file)))),
        release: (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version };
}
export async function runReferenceStand(options: ReferenceOptions): Promise<boolean> {
    const root = path.resolve('.'), data = path.join(root, 'tests/node/synthetic');
    if (options.action === 'merge') {
        if (!options.inputs || !options.report || options.shard || options.resume) throw new Error('merge requires --inputs and a fresh --report');
        const output = path.resolve(options.report), inputs = path.resolve(options.inputs);
        if (fs.existsSync(output) || output === inputs || output.startsWith(inputs + path.sep)) throw new Error('Merge report must be a new directory outside inputs');
        try {
            const source = referenceSourceIdentity(root);
            const summary = mergeReferenceShards(inputs, output, source);
            assertWalkResumeIdentity(source, referenceSourceIdentity(root));
            console.log('Merged reference summary: ' + path.join(output, 'summary.md') + ' ' + summary.verdict);
            return summary.verdict === 'PASS';
        } catch (error) {
            const summary = buildStandSummary({ level: 'merge', final: true, partial: false, checks: [], timingRequested: false,
                baselineProblems: ['Merge refused: ' + String(error)] });
            atomicWalkJson(path.join(output, 'summary.json'), summary);
            atomicWalkText(path.join(output, 'summary.md'), renderStandSummary(summary));
            console.error('Merge refused: ' + String(error)); return false;
        }
    }
    if (options.action === 'baseline') {
        const evidence = acceptStandBaseline(data, { kind: options.kind as BaselineKind, candidate: options.candidate || '', reason: options.reason || '',
            release: options.release || '', sourceCommit: options['source-commit'] || '', expectedSha256: options['expected-sha256'] || '',
            formatOnly: options['format-only'] });
        console.log('Baseline decision: ' + evidence); return true;
    }
    const level = options.action === 'sample' || options.action === 'timing' ? 'short' : options.action;
    const shard = parseStandShard(options.shard), ci = process.env.GITHUB_ACTIONS === 'true';
    if (shard && (options.action === 'timing' || options['step-timing'])) throw new Error('Shards cannot measure step timing');
    // rotation: local default (full has compact cases, sweep the seeded rotation); seeded: the seeded rotation also at full;
    // all: every deep family on every stack at full and sweep.
    if (options['review-stacks'] && !['rotation', 'seeded', 'all'].includes(options['review-stacks'])) throw new Error('review-stacks must be rotation, seeded or all');
    if (options['review-stacks']) process.env.GARDA_SYNTHETIC_REVIEW_STACKS = options['review-stacks'] === 'rotation' ? '3' : options['review-stacks'];
    if (options.provider && !['Codex', 'Claude'].includes(options.provider)) throw new Error('provider must be Codex or Claude');
    if (options.provider) process.env.GARDA_SYNTHETIC_WALK_PROVIDER = options.provider;
    options.only ??= process.env.GARDA_SYNTHETIC_WALK_ONLY;
    const jobs = Number(options.jobs || 2), seed = options.seed || '1785881697';
    if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 24) throw new Error('jobs must be 1..24');
    if (!Number.isSafeInteger(Number(seed)) || Number(seed) < 0 || Number(seed) > 0xffffffff) throw new Error('seed must be an unsigned 32-bit integer');
    if (options.action === 'timing' && options.jobs && jobs !== 1) throw new Error('Step timing requires --jobs 1');
    const output = path.resolve(options.report || options.resume || fs.mkdtempSync(path.join(os.tmpdir(), 'garda-reference-')));
    if (output.startsWith(data + path.sep)) throw new Error('Report must be outside stand sources');
    fs.mkdirSync(output, { recursive: true });
    console.log('Reference stand report: ' + output);
    const source = referenceSourceIdentity(root), baselineProblems = inspectBaselinePolicy(data);
    const properties = readStandProperties(root);
    const schedule = standCheckPlan(level, fs.readFileSync(path.join(root, 'tests/node/policy/stack-universal-gates-contract.test.ts'), 'utf8'));
    const traceProblems = inspectStandProperties(properties, { root, level, seed, scenarioIds: WALK_SCENARIOS.map(item => item.id), schedule });
    const timingRequested = !ci && (options['step-timing'] === true || options.action === 'timing');
    const identity = { schema_version: 1, source, level, only: options.only ?? null, seed, provider: process.env.GARDA_SYNTHETIC_WALK_PROVIDER || 'Codex',
        timingRequested, timingRoutes: options['timing-routes'] ?? null, action: options.action === 'sample' ? 'short' : options.action,
        reviewStacks: process.env.GARDA_SYNTHETIC_REVIEW_STACKS ?? '3',
        shard: shard ?? null, ci, quiet: !ci && process.env.GARDA_SYNTHETIC_WALK_QUIET === '1',
        protocol: TIMING_PROTOCOL, baselinePolicy: fileDigest(path.join(data, 'baseline-policy.json')) };
    const identityPath = path.join(output, 'reference-identity.json');
    if (options.resume) {
        assertWalkResumeIdentity(readJson(path.join(path.resolve(options.resume), 'reference-identity.json')), identity);
        if (path.resolve(options.resume) !== output) throw new Error('Use the same report directory when resuming');
    } else if (fs.existsSync(identityPath)) throw new Error('Report exists; use --resume or a new --report');
    atomicWalkJson(identityPath, identity);
    const checks: StandCheck[] = [];
    let quiet: QuietEvidence | undefined, final = false;
    const policy = runStand({ mode: level === 'short' ? 'sample' : 'exhaustive', seed: Number(seed) });
    atomicWalkJson(path.join(output, 'policy.json'), policy);
    let summaryInput: SummaryInput;
    const refresh = () => {
        const walk = readJson<WalkReport>(path.join(output, 'walk/navigator-walk.json'));
        summaryInput = { level, final, partial: !!shard || !!options.only || options.action === 'timing', checks, baselineProblems, shard, ci,
            policyProblems: policy.stale_known.map(id => 'Stale known policy finding: ' + id),
            walk, traceProblems, limits: properties.limits,
            traceability: propertyTrace(properties, { level, final, partial: !!options.only || options.action === 'timing',
                only: options.only ? expandWalkSelection(options.only) : undefined, checks, walk, timingRequested }),
            partialFindings: readJson<{ findings: StandFinding[] }>(path.join(output, 'walk/partial-findings.json'))?.findings,
            progress: readJson(path.join(output, 'walk/progress.json')), policyFindings: policy.findings,
            quiet, timing: readJson<TimingReport>(path.join(output, 'timing/step-timing.json')), timingRequested };
        const summary = buildStandSummary(summaryInput);
        atomicWalkJson(path.join(output, 'summary.json'), summary);
        atomicWalkText(path.join(output, 'summary.md'), renderStandSummary(summary));
        return summary;
    };
    refresh();
    const timer = setInterval(() => { const summary = refresh(); console.log('Reference heartbeat ' + JSON.stringify(summary.progress ?? summary.checks)); }, 30_000);
    timer.unref();
    const poll = setInterval(refresh, 1000); poll.unref();
    const baseEnv = { ...process.env };
    for (const key of Object.keys(baseEnv)) if (/^(?:GIT_CONFIG(?:_|$)|GARDA_SYNTHETIC_WALK_|GARDA_REFERENCE_STAND$|GARDA_SYNTHETIC_STEP_TIMING|GARDA_NEXT_STEP_TIMING$)/iu.test(key)) delete baseEnv[key];
    baseEnv.GARDA_SYNTHETIC_WALK_PROVIDER = process.env.GARDA_SYNTHETIC_WALK_PROVIDER || 'Codex';
    if (ci) baseEnv.GARDA_SYNTHETIC_WALK_QUIET = '0';
    delete baseEnv.NODE_TEST_CONTEXT;
    const runCheck = async (id: string, testFile: string, extra: NodeJS.ProcessEnv = {}, reuse = true, testPattern?: string) => {
        const log = id + '.log', marker = path.join(output, id + '.check.json'), evidence = path.join(output, id + '.oracles.jsonl');
        const saved = readJson<{ identity: string; check: StandCheck; log_sha256: string; oracle_sha256: string; digest: string }>(marker);
        const check: StandCheck = { id, status: 'running', log }; checks.push(check);
        if (options.resume && reuse && saved?.identity === walkHash(identity) && ['PASS', 'FAIL'].includes(saved.check.status)
            && saved.digest === walkHash({ identity: saved.identity, check: saved.check, log_sha256: saved.log_sha256, oracle_sha256: saved.oracle_sha256 })
            && fs.existsSync(evidence) && fileDigest(evidence) === saved.oracle_sha256
            && fs.existsSync(path.join(output, log)) && fileDigest(path.join(output, log)) === saved.log_sha256) {
            Object.assign(check, saved.check, { reused: true }); refresh(); return;
        }
        refresh();
        const fd = fs.openSync(path.join(output, log), 'w');
        fs.writeFileSync(evidence, '');
        let code: number | null = null;
        try {
            code = await new Promise<number | null>((resolve, reject) => {
                const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...(testPattern ? ['--test-name-pattern', testPattern] : []), path.resolve(__dirname, '..', testFile)],
                    { cwd: root, windowsHide: true, stdio: ['ignore', fd, fd], env: { ...baseEnv, ...extra, GARDA_STAND_CHECK_EVIDENCE: evidence } });
                child.once('error', reject); child.once('close', resolve);
            });
        } catch (error) { fs.writeSync(fd, String(error)); }
        finally { fs.closeSync(fd); }
        check.exit_code = code; check.status = code === 0 ? 'PASS' : 'FAIL';
        check.executed_tests = [...fs.readFileSync(path.join(output, log), 'utf8').matchAll(/^ok \d+ - (.+)$/gmu)]
            .map(match => match[1]).filter(name => !/ # (?:SKIP|TODO)\b/iu.test(name));
        if (!check.executed_tests.length) check.status = 'FAIL';
        check.oracles_executed = [...new Set(fs.readFileSync(evidence, 'utf8').split('\n').filter(Boolean)
            .map(line => (JSON.parse(line) as { id: string }).id))];
        const record = { identity: walkHash(identity), check, log_sha256: fileDigest(path.join(output, log)), oracle_sha256: fileDigest(evidence) };
        atomicWalkJson(marker, { ...record, digest: walkHash(record) }); refresh();
        console.log('Reference check ' + id + ' ' + check.status + ' (' + path.join(output, log) + ')');
    };
    const runContract = async () => {
        const aggregate: StandCheck = { id: 'contract', status: 'running', log: 'contract.json' }; checks.push(aggregate); refresh();
        const parts = schedule.filter(item => item.phase === 'contract');
        const pending = [...parts];
        await Promise.all(Array.from({ length: 2 }, async () => {
            for (let part = pending.shift(); part; part = pending.shift()) {
                await runCheck(part.id, part.file, {}, true, 'pattern' in part ? part.pattern : undefined);
            }
        }));
        aggregate.status = parts.every(part => checks.some(check => check.id === part.id && check.status === 'PASS')) ? 'PASS' : 'FAIL';
        aggregate.exit_code = aggregate.status === 'PASS' ? 0 : 1;
        atomicWalkJson(path.join(output, 'contract.json'), { identity: walkHash(identity), status: aggregate.status,
            parts: parts.map(part => ({ ...part, check: checks.find(check => check.id === part.id), log_sha256: fileDigest(path.join(output, part.id + '.log')) })) });
        refresh();
    };
    try {
        if (options.action !== 'timing') {
            // Cheap units first in one job, then contract/reuse beside the walk workers. No CI or full test groups.
            await Promise.all([
                (async () => {
                    if (shard && shard.index !== 1) return;
                    for (const item of schedule.filter(item => item.phase === 'unit')) await runCheck(item.id, item.file);
                    await Promise.all([
                        runContract(),
                        ...schedule.filter(item => item.phase === 'parallel').map(item => runCheck(item.id, item.file, {}, true,
                            'pattern' in item ? item.pattern : undefined))
                    ]);
                })(),
                runCheck('walk', schedule.find(item => item.id === 'walk')!.file, { GARDA_SYNTHETIC_WALK_LEVEL: level,
                    GARDA_SYNTHETIC_WALK_JOBS: String(jobs), GARDA_SYNTHETIC_SEED: seed,
                    GARDA_SYNTHETIC_WALK_SHARD: options.shard,
                    GARDA_SYNTHETIC_WALK_ONLY: options.only, GARDA_SYNTHETIC_WALK_REPORT: path.join(output, 'walk'),
                    ...(options.resume && fs.existsSync(path.join(output, 'walk/run-manifest.json')) ? { GARDA_SYNTHETIC_WALK_RESUME: path.join(output, 'walk') } : {}) }, false)
            ]);
        }
        if (timingRequested) {
            const environment = timingEnvironment();
            quiet = await checkQuietMachine(options['machine-busy'] === true);
            for (const field of ['power_plan', 'defender', 'disk'] as const) if (environment[field] === 'unavailable') {
                quiet.quiet = false; quiet.reasons.push('Environment monitoring unavailable: ' + field);
            }
            if (environment.coverage !== 'off' || /--(?:require|import|prof|inspect|experimental-test-coverage)/u.test(environment.node_options)) {
                quiet.quiet = false; quiet.reasons.push('Coverage or injected Node instrumentation is enabled');
            }
            atomicWalkJson(path.join(output, 'timing/preflight.json'), { environment, quiet, source, protocol: TIMING_PROTOCOL }); refresh();
            if (quiet.quiet) {
                const manifest = readJson<TimingManifest>(path.join(data, 'step-timing-manifest.json'))!;
                const selected = options['timing-routes']?.split(',') ?? manifest.checkpoints.map(checkpoint => checkpoint.key);
                const unknown = selected.filter(key => !manifest.checkpoints.some(checkpoint => checkpoint.key === key));
                if (unknown.length) throw new Error('Unknown timing routes: ' + unknown.join(', '));
                const configFile = path.join(output, 'timing/config.json');
                // A timing attempt rebuilds navigation prefixes; only completed timing series can be resumed.
                const timingWalk = fs.mkdtempSync(path.join(output, 'timing/walk-attempt-'));
                atomicWalkJson(configFile, { output: path.join(output, 'timing'), manifest, environment, quiet, source, selected,
                    baseline: readJson<TimingBaseline>(path.join(data, 'step-timing-baseline.json')), workReportPath: path.join(timingWalk, 'navigator-walk.json') });
                const scenarios = [...new Set(manifest.checkpoints.filter(checkpoint => selected.includes(checkpoint.key)).map(checkpoint => checkpoint.scenario))];
                await runCheck('timing', schedule.find(item => item.id === 'timing')!.file, { GARDA_SYNTHETIC_STEP_TIMING: '1', GARDA_SYNTHETIC_STEP_TIMING_CONFIG: configFile,
                    GARDA_SYNTHETIC_WALK_LEVEL: 'short', GARDA_SYNTHETIC_WALK_JOBS: '1', GARDA_SYNTHETIC_SEED: seed,
                    GARDA_SYNTHETIC_WALK_ONLY: scenarios.join(','), GARDA_SYNTHETIC_WALK_REPORT: timingWalk }, false);
            } else console.log('Step timing INCONCLUSIVE: ' + quiet.reasons.join('; '));
        }
    } finally {
        clearInterval(timer); clearInterval(poll);
        try { assertWalkResumeIdentity(source, referenceSourceIdentity(root)); }
        catch (error) { baselineProblems.push('Run inputs changed or could not be verified after execution: ' + String(error)); }
        final = true; refresh();
    }
    const summary = refresh();
    if (shard) {
        sealReferenceShard(output, identity, shard, summaryInput!);
        console.log('Reference partial shard ' + shard.index + '/' + shard.total + '; never a verdict');
        return true;
    }
    console.log('Reference summary: ' + path.join(output, 'summary.md') + ' ' + summary.verdict);
    // Short permits inconclusive timing; measured regressions still fail. Timing-only remains a diagnostic.
    const correctnessPassed = options.action === 'timing' || [summary.pillars.navigator_correctness, summary.pillars.stack_independence,
        summary.pillars.review_logic].every(pillar => pillar.verdict === 'PASS') && summary.speed.work_budgets === 'PASS';
    return baselineProblems.length === 0 && checks.every(check => check.status === 'PASS') && !policy.new_findings.length && !policy.stale_known.length
        && correctnessPassed && (options.action === 'timing' || summary.verdict === 'PASS');
}
