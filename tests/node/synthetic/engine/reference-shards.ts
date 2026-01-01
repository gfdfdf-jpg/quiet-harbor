import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StandFinding } from '../../../../scripts/node-foundation/synthetic/model';
import { fileDigest } from './stand-baselines';
import { buildStandSummary, renderStandSummary, type SummaryInput } from './stand-summary';
import { atomicWalkJson, atomicWalkText, assertWalkResumeIdentity, readWalkResultIndex, walkHash, walkResultIndex, WalkRunStore } from './walk-run-store';
import { verdictResult } from './walk-metrics';
import { shardPlan, sweepWork, SWEEP_BASELINES, workIds, type StandShard, type WalkWork } from './walk-sharding';
import { walkRunPlan } from './walk-plan';
import { WALK_SCENARIOS } from './walk-scenarios';
import type { WalkResult } from './navigator-walk';
import { judgeWalk } from './walk-verdict';
import { renderWalkReport } from './walk-report';
import { propertyTrace, readStandProperties } from './stand-properties';
import { standCheckPlan } from './stand-check-plan';

export interface ShardIdentity {
    source: unknown; level: string; seed: string; provider: string; reviewStacks: string; only: string | null; ci: boolean; quiet?: boolean;
}
interface ShardArtifact {
    schema: 1; kind: 'partial'; identity: ShardIdentity; shard: StandShard;
    scenarioSetHash: string; scenarioIds: string[]; assigned: string[];
    files: Record<string, string>; summaryInput: SummaryInput; digest: string;
}
function read<T>(file: string): T { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; }
function evidenceFiles(root: string, directory = root): string[] {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const file = path.join(directory, entry.name), relative = path.relative(root, file).replace(/\\/gu, '/');
        if (entry.isSymbolicLink()) throw new Error('Shard evidence cannot contain a symlink: ' + relative);
        // Source bytes are already bound by run-inputs.json; worker copies are diagnostic, not acceptance evidence.
        if (relative === 'walk/run-inputs' || /^(?:walk\/)?(?:full|ordinary|sweep|baselines)-job-\d+$/u.test(relative)) return [];
        if (entry.isDirectory()) return evidenceFiles(root, file);
        return entry.isFile() && !['summary.md', 'summary.json', 'shard-result.json'].includes(relative) ? [relative] : [];
    }).sort();
}
export function sealReferenceShard(output: string, identity: ShardIdentity, shard: StandShard, input: SummaryInput): void {
    const plan = read<ReturnType<typeof shardPlan>>(path.join(output, 'walk/shard-plan.json'));
    const files = Object.fromEntries(evidenceFiles(output).map(file => [file, fileDigest(path.join(output, file))]));
    const { shard: _shard, ...commonIdentity } = identity as ShardIdentity & { shard?: StandShard | null };
    const value = { schema: 1 as const, kind: 'partial' as const, identity: commonIdentity, shard, ...plan, files,
        summaryInput: { ...input, walk: undefined, traceability: undefined, progress: undefined } };
    atomicWalkJson(path.join(output, 'shard-result.json'), { ...value, digest: walkHash(value) });
}
function validateArtifact(file: string): ShardArtifact {
    const artifact = read<ShardArtifact>(file), { digest, ...body } = artifact;
    if (artifact.schema !== 1 || artifact.kind !== 'partial' || digest !== walkHash(body)) throw new Error('Tampered shard envelope: ' + file);
    const root = path.dirname(file);
    for (const [name, sha] of Object.entries(artifact.files)) {
        const target = path.resolve(root, name), relative = path.relative(root, target);
        if (relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(target).isSymbolicLink()
            || fileDigest(target) !== sha) throw new Error('Tampered shard evidence: ' + name);
    }
    if (walkHash(evidenceFiles(root)) !== walkHash(Object.keys(artifact.files).sort())) throw new Error('Shard evidence file set differs');
    return artifact;
}
function discover(directory: string): string[] {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error('Shard input cannot be a symlink');
        return entry.isDirectory() ? discover(file) : entry.name === 'shard-result.json' ? [file] : [];
    });
}
/** Missing/duplicate/mixed/tampered inputs throw before a verdict can be produced. */
export function mergeReferenceShards(inputs: string, output: string, source: unknown) {
    const files = discover(path.resolve(inputs)), artifacts = files.map(validateArtifact);
    if (!artifacts.length) throw new Error('No shard results found');
    const first = artifacts[0], identity = first.identity, total = first.shard.total;
    if (!Number.isSafeInteger(total) || total < 1 || total > 256 || artifacts.length !== total) throw new Error('Missing or duplicated shards');
    const indexes = new Set<number>();
    for (const artifact of artifacts) {
        assertWalkResumeIdentity(identity, artifact.identity);
        assertWalkResumeIdentity(first.summaryInput.policyFindings ?? [], artifact.summaryInput.policyFindings ?? []);
        assertWalkResumeIdentity(first.summaryInput.policyProblems ?? [], artifact.summaryInput.policyProblems ?? []);
        if (artifact.shard.total !== total || !Number.isSafeInteger(artifact.shard.index) || artifact.shard.index < 1
            || artifact.shard.index > total || indexes.has(artifact.shard.index)) throw new Error('Missing, duplicated or mixed shards');
        indexes.add(artifact.shard.index);
        assertWalkResumeIdentity(first.scenarioIds, artifact.scenarioIds);
        if (artifact.scenarioSetHash !== walkHash(artifact.scenarioIds)) throw new Error('Scenario set hash differs');
    }
    assertWalkResumeIdentity(identity.source, source);
    process.env.GARDA_SYNTHETIC_SEED = identity.seed;
    process.env.GARDA_SYNTHETIC_REVIEW_STACKS = identity.reviewStacks;
    process.env.GARDA_SYNTHETIC_WALK_QUIET = !identity.ci && identity.quiet ? '1' : '0';
    const plan = walkRunPlan({ GARDA_SYNTHETIC_WALK_LEVEL: identity.level, GARDA_SYNTHETIC_SEED: identity.seed,
        GARDA_SYNTHETIC_REVIEW_STACKS: identity.reviewStacks, GARDA_SYNTHETIC_WALK_ONLY: identity.only ?? undefined }, WALK_SCENARIOS.map(item => item.id));
    const records = new Map<string, WalkResult>(), findings: StandFinding[] = [];
    const checks: SummaryInput['checks'] = [];
    const baselineProblems = new Set<string>(), traceProblems = new Set<string>();
    let ownerInput: SummaryInput | undefined;
    const expectedChecks = [...standCheckPlan(identity.level, fs.readFileSync(path.resolve('tests/node/policy/stack-universal-gates-contract.test.ts'), 'utf8'))
        .filter(check => check.phase !== 'timing').map(check => check.id), 'contract'].sort();
    for (let index = 0; index < artifacts.length; index++) {
        const artifact = artifacts[index], root = path.dirname(files[index]);
        assertWalkResumeIdentity(artifact.summaryInput.checks.map(check => check.id).sort(), artifact.shard.index === 1 ? expectedChecks : ['walk']);
        if (artifact.summaryInput.checks.some(check => check.status === 'running')) throw new Error('Shard checks did not finish');
        const manifest = read<{ shard: StandShard; runInputsHash: string }>(path.join(root, 'walk/run-manifest.json'));
        assertWalkResumeIdentity(manifest.shard, artifact.shard);
        if (walkHash(read(path.join(root, 'walk/run-inputs.json'))) !== manifest.runInputsHash) throw new Error('Tampered walk inputs');
        const store = new WalkRunStore(path.join(root, 'walk'), walkHash(manifest));
        // The index names each record and its content digest; the record itself is read, checksummed and reduced to
        // what the verdict reads one at a time, so no shard or union is ever one JSON text.
        const raw = readWalkResultIndex(path.join(root, 'walk/results.json'));
        if (!raw.executionFindings) throw new Error('Shard result index lacks execution findings');
        assertWalkResumeIdentity(raw.records.map(item => item.id).sort(), artifact.assigned);
        for (const entry of raw.records) {
            const sealed = store.readSealed(entry.id);
            if (!sealed || sealed.digest !== entry.digest || records.has(entry.id)) throw new Error('Duplicated or tampered scenario: ' + entry.id);
            records.set(entry.id, verdictResult(sealed.record.result)); findings.push(...sealed.record.findings);
        }
        findings.push(...raw.executionFindings.filter(finding => finding.id.startsWith('walk:worker:')));
        for (const problem of artifact.summaryInput.baselineProblems) baselineProblems.add(problem);
        for (const problem of artifact.summaryInput.traceProblems ?? []) traceProblems.add(problem);
        if (artifact.shard.index === 1) { ownerInput = artifact.summaryInput; checks.push(...ownerInput.checks.filter(check => check.id !== 'walk')); }
        const check = artifact.summaryInput.checks.find(item => item.id === 'walk');
        if (!check || check.status === 'running') throw new Error('Shard walk did not finish');
        // Failure is retained even if a child crashed after publishing its last scenario.
        if (check.status === 'FAIL' && !raw.executionFindings.length) baselineProblems.add('Shard walk process failed: ' + artifact.shard.index);
    }
    const allItems: WalkWork[] = plan.scenarioIds.map(baseline => ({ baseline }));
    if (plan.runSweep) {
        const baselineIds = identity.level === 'sweep' && !plan.only || plan.only?.some(id => id.startsWith('sweep-stack-'))
            ? SWEEP_BASELINES : SWEEP_BASELINES.slice(0, 3);
        const baselines = baselineIds.map(id => {
            const result = records.get(id), scenario = WALK_SCENARIOS.find(item => item.id === id)!;
            if (!result || result.outcome !== 'done') throw new Error('Missing native sweep planning baseline: ' + id);
            return { scenario, result };
        });
        allItems.push(...baselineIds.filter(id => !plan.scenarioIds.includes(id)).map(baseline => ({ baseline })),
            ...sweepWork(baselines, Number(identity.seed)).map(item => ({ ...item,
                variants: item.variants!.filter(variant => !plan.only || plan.only.includes(variant.id)) })).filter(item => item.variants.length));
    }
    for (const artifact of artifacts) {
        const expected = shardPlan(allItems, artifact.shard);
        assertWalkResumeIdentity(expected.scenarioIds, artifact.scenarioIds);
        assertWalkResumeIdentity(expected.assigned, artifact.assigned);
    }
    assertWalkResumeIdentity(allItems.flatMap(workIds).sort(), [...records.keys()].sort());
    // A checkpoint family's completion marker is required as well as its individual records.
    for (const item of allItems.filter(item => item.variants)) {
        const artifactIndex = artifacts.findIndex(artifact => artifact.assigned.includes(workIds(item)[0]));
        const root = path.join(path.dirname(files[artifactIndex]), 'walk');
        const store = new WalkRunStore(root, walkHash(read(path.join(root, 'run-manifest.json'))));
        if (!store.readFamily(workIds(item))) throw new Error('Incomplete or tampered checkpoint family');
    }
    const oracleFile = path.join(output, 'merge-oracles.jsonl');
    atomicWalkText(oracleFile, '');
    const previousOracleFile = process.env.GARDA_STAND_CHECK_EVIDENCE;
    process.env.GARDA_STAND_CHECK_EVIDENCE = oracleFile;
    let walk: ReturnType<typeof judgeWalk>;
    try { walk = judgeWalk([...records.values()], findings, identity.level, !!identity.only); }
    finally {
        if (previousOracleFile === undefined) delete process.env.GARDA_STAND_CHECK_EVIDENCE;
        else process.env.GARDA_STAND_CHECK_EVIDENCE = previousOracleFile;
    }
    const mergeOracles = fs.readFileSync(oracleFile, 'utf8').split('\n').filter(Boolean)
        .map(line => (JSON.parse(line) as { id: string }).id);
    // Per-shard budget/coverage verdicts are deliberately ignored; recompute on the complete raw union.
    const walkChecks = artifacts.map(artifact => artifact.summaryInput.checks.find(item => item.id === 'walk')!);
    checks.push({ id: 'walk', log: 'walk/navigator-walk.json', status: walk.findings.length || walkChecks.some(check => check.status === 'FAIL') ? 'FAIL' : 'PASS',
        executed_tests: [...new Set(walkChecks.flatMap(check => check.executed_tests ?? []))],
        oracles_executed: [...new Set([...walkChecks.flatMap(check => check.oracles_executed ?? []), ...mergeOracles])] });
    const properties = readStandProperties(path.resolve('.'));
    const input: SummaryInput = { ...ownerInput!, shard: undefined, final: true, partial: !!identity.only, ci: identity.ci,
        checks, walk, baselineProblems: [...baselineProblems], traceProblems: [...traceProblems] };
    input.traceability = propertyTrace(properties, { ...input, only: plan.only ?? undefined });
    const summary = buildStandSummary(input);
    fs.mkdirSync(path.join(output, 'walk'), { recursive: true });
    atomicWalkJson(path.join(output, 'walk/navigator-walk.json'), walk);
    atomicWalkText(path.join(output, 'walk/navigator-walk.md'), renderWalkReport(walk));
    atomicWalkJson(path.join(output, 'reference-identity.json'), { ...identity, scenarioSetHash: first.scenarioSetHash, total });
    const mergedStore = new WalkRunStore(path.join(output, 'walk'), walkHash({ identity, scenarioSetHash: first.scenarioSetHash, total }));
    for (const artifactFile of files) {
        const root = path.join(path.dirname(artifactFile), 'walk'), store = new WalkRunStore(root, walkHash(read(path.join(root, 'run-manifest.json'))));
        for (const id of read<ShardArtifact>(artifactFile).assigned) mergedStore.save(store.read(id)!);
    }
    for (const item of allItems.filter(item => item.variants)) mergedStore.finishFamily(workIds(item));
    atomicWalkJson(path.join(output, 'walk/results.json'), walkResultIndex(mergedStore, [...records.keys()], walk.findings));
    // Preserve relative links to the shared check evidence and all immutable raw shard records.
    for (let index = 0; index < artifacts.length; index++) {
        const root = path.dirname(files[index]), artifact = artifacts[index];
        fs.cpSync(root, path.join(output, 'shards', String(artifact.shard.index)), { recursive: true,
            filter: file => !file.includes(path.sep + 'run-inputs' + path.sep) && path.basename(file) !== 'run-inputs' });
        if (artifact.shard.index === 1) for (const name of Object.keys(artifact.files).filter(name => !name.startsWith('walk/') && name !== 'reference-identity.json')) {
            fs.copyFileSync(path.join(root, name), path.join(output, name));
        }
    }
    atomicWalkText(path.join(output, 'walk.log'), artifacts.map(artifact => 'Raw shard evidence: shards/' + artifact.shard.index + '/walk.log').join('\n')
        + '\nMerge oracle evidence: merge-oracles.jsonl\n');
    atomicWalkJson(path.join(output, 'summary.json'), summary);
    atomicWalkText(path.join(output, 'summary.md'), renderStandSummary(summary));
    return summary;
}
