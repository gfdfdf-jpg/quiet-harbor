import * as fs from 'node:fs';
import * as path from 'node:path';

import { getRepoRoot } from '../build';
import type { LayerResult, StandFinding } from './model';
import { comparePathObservation, createPathObserver, runPathLayer, type PathVariant } from './path-layer';
import { compareMode, compareRerunLanes, observeMode, observeRerunLanes, runPolicyLayers } from './policy-layer';
import type { FileRole } from './model';
import type { ModeCase, RerunCase } from './oracle';

/**
 * Synthetic review stand, layers without a workflow engine: stack path roles and
 * the remediation review policies. `sample` runs in the normal test suite;
 * `exhaustive` is the pre-release run (see tests/node/synthetic/README.md).
 */

export const DEFAULT_STAND_SEED = 20261030;
export const SAMPLE_POLICY_FRACTION = 0.02;

export type CorpusEntry =
    | { id: string; layer: 'path'; note: string; stack: string; role: FileRole; file: string; variant: PathVariant }
    | { id: string; layer: 'policy-mode'; note: string; input: ModeCase }
    | { id: string; layer: 'policy-rerun'; note: string; input: RerunCase };

export interface KnownFinding {
    id: string;
    note: string;
}

export interface StandReport {
    schema_version: 1;
    mode: 'sample' | 'exhaustive';
    seed: number;
    wall_time_ms: number;
    layers: Array<{ layer: LayerResult['layer']; cases: number; findings: number }>;
    findings: StandFinding[];
    new_findings: StandFinding[];
    known_open: string[];
    stale_known: string[];
}

export function standDataRoot(repoRoot = getRepoRoot()): string {
    return path.join(repoRoot, 'tests', 'node', 'synthetic');
}

export function readCorpus(dataRoot = standDataRoot()): CorpusEntry[] {
    const corpusRoot = path.join(dataRoot, 'corpus');
    if (!fs.existsSync(corpusRoot)) return [];
    return fs.readdirSync(corpusRoot).filter((name) => name.endsWith('.json')).sort()
        .flatMap((name) => JSON.parse(fs.readFileSync(path.join(corpusRoot, name), 'utf8')) as CorpusEntry[]);
}

export function readKnownFindings(dataRoot = standDataRoot()): KnownFinding[] {
    const file = path.join(dataRoot, 'known-findings.json');
    return fs.existsSync(file)
        ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { findings: KnownFinding[] }).findings
        : [];
}

/** Corpus entries are minimized past failures; each must stay green forever. */
export function replayCorpus(entries: readonly CorpusEntry[]): LayerResult {
    const observer = createPathObserver();
    const findings: StandFinding[] = [];
    try {
        for (const entry of entries) {
            const found = entry.layer === 'path'
                ? comparePathObservation(entry, observer.observe(entry.file, entry.variant))
                : entry.layer === 'policy-mode'
                    ? [compareMode(entry.input, observeMode(entry.input))].filter((item): item is StandFinding => item !== null)
                    : [compareRerunLanes(entry.input, observeRerunLanes(entry.input))].filter((item): item is StandFinding => item !== null);
            findings.push(...found.map((finding) => ({ ...finding, id: `corpus:${entry.id}:${finding.id}`, layer: 'corpus' as const })));
        }
    } finally {
        observer.dispose();
    }
    return { layer: 'corpus', cases: entries.length, findings };
}

export function runStand(options: { mode: 'sample' | 'exhaustive'; seed?: number; dataRoot?: string }): StandReport {
    const started = performance.now();
    const seed = options.seed ?? DEFAULT_STAND_SEED;
    const layers = [
        runPathLayer(),
        ...runPolicyLayers(options.mode === 'exhaustive'
            ? { kind: 'exhaustive' }
            : { kind: 'sample', seed, fraction: SAMPLE_POLICY_FRACTION }),
        replayCorpus(readCorpus(options.dataRoot))
    ];
    const findings = layers.flatMap((layer) => layer.findings);
    const known = readKnownFindings(options.dataRoot);
    const knownIds = new Set(known.map((entry) => entry.id));
    const foundIds = new Set(findings.map((finding) => finding.id));
    // Sampled policy layers may legitimately miss a known policy finding; only full runs prove a policy entry stale.
    // Engine entries are proven by the remediation engine's fixed reproductions, not by these layers.
    const staleCandidates = known.filter((entry) => !entry.id.startsWith('engine:')
        && (options.mode === 'exhaustive' || entry.id.startsWith('path:')));
    return {
        schema_version: 1,
        mode: options.mode,
        seed,
        wall_time_ms: Math.round(performance.now() - started),
        layers: layers.map((layer) => ({ layer: layer.layer, cases: layer.cases, findings: layer.findings.length })),
        findings,
        new_findings: findings.filter((finding) => !knownIds.has(finding.id)),
        known_open: known.filter((entry) => foundIds.has(entry.id)).map((entry) => entry.id),
        stale_known: staleCandidates.filter((entry) => !foundIds.has(entry.id)).map((entry) => entry.id)
    };
}

export function renderStandMarkdown(report: StandReport): string {
    const lines = [
        `# Synthetic review stand (${report.mode}, seed ${report.seed})`,
        '',
        `Wall time: ${report.wall_time_ms} ms. New findings: ${report.new_findings.length}. Known open: ${report.known_open.length}. Stale known: ${report.stale_known.length}.`,
        '',
        '| Layer | Cases | Findings |',
        '|---|---|---|',
        ...report.layers.map((layer) => `| ${layer.layer} | ${layer.cases} | ${layer.findings} |`),
        '',
        '## Findings',
        '',
        '| Kind | Id | Summary |',
        '|---|---|---|',
        ...report.findings.map((finding) => `| ${finding.kind} | \`${finding.id}\` | ${finding.summary} |`)
    ];
    return lines.join('\n') + '\n';
}
