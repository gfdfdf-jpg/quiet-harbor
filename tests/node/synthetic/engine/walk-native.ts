import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { nativeOwnerClockOffset } from './walk-clock';
import { runDiagnostics } from '../../../../scripts/node-foundation/diagnose-next-step';
import { atomicWalkJson } from './walk-run-store';
import type { NativeFamily } from './walk-native-runner';
import type { WalkWork } from './walk-sharding';
import type { WalkResult } from './navigator-walk';
import type { StandFinding } from '../../../../scripts/node-foundation/synthetic/model';

const CLI = path.resolve('tests/node/synthetic/engine/walk-native-cli.cjs');

/** The CLI prints Error.message, so follow only its explicit stale-plan reinspection instruction. */
export function nativeEffectNeedsReinspection(output: string): boolean {
    return /^(?:Next-step effect plan (?:is stale|became stale during execution)|Review-context recovery evidence changed\.)[^\n]*Rerun next-step inspection\.$/mu.test(output);
}

/** A finished fallback walk does not establish that the requested live summary path was measured. */
export function nativeWalkPathFindings(result: WalkResult): StandFinding[] {
    const observed = (key: string) => result.steps.some(step => !step.reusedPrefix && (step.measurement?.work[key] ?? 0) > 0);
    const failures: StandFinding[] = [];
    if (observed('loaded_code_receipts_unavailable') || observed('closed-review-summary:rejected:capture')) failures.push({
        layer: 'walk', kind: 'contract', id: 'walk:native-code-receipts:' + result.scenarioId,
        summary: 'The native replay fell back because loaded-code capture refused; live-summary calibration is unavailable.',
        detail: { replay: 'GARDA_SYNTHETIC_WALK_ONLY=' + result.scenarioId }
    });
    if (result.scenarioId === 'field-onlinestore-t022-1-closeout' && !observed('closed-review-summary:accepted')) failures.push({
        layer: 'walk', kind: 'contract', id: 'walk:native-summary-path:' + result.scenarioId,
        summary: 'The field replay must actually accept the closed-review summary, as live work does.',
        detail: { replay: 'GARDA_SYNTHETIC_WALK_ONLY=' + result.scenarioId }
    });
    return failures;
}

/** Only the child sees the fixture clock. NODE_OPTIONS remains subject to the real bootstrap's refusal. */
function withNativeClock<T>(action: () => T): T {
    const previous = process.env.GARDA_SYNTHETIC_NATIVE_CLOCK_MS;
    process.env.GARDA_SYNTHETIC_NATIVE_CLOCK_MS = String(nativeOwnerClockOffset());
    try { return action(); } finally {
        if (previous === undefined) delete process.env.GARDA_SYNTHETIC_NATIVE_CLOCK_MS;
        else process.env.GARDA_SYNTHETIC_NATIVE_CLOCK_MS = previous;
    }
}

export function nativeWalkNavigation(repoRoot: string, taskId: string, scenarioId: string) {
    return withNativeClock(() => runDiagnostics({ repoRoot, taskId,
        outputDir: process.env.GARDA_SYNTHETIC_WALK_DIAGNOSTICS!, launcher: CLI, label: scenarioId,
        cpuProfile: process.env.GARDA_SYNTHETIC_WALK_DIAGNOSTICS_CPU === '1' }));
}

/** Gates and effects must publish with the same installed code identity that navigation captures. */
export function nativeWalkCommand(argv: string[]): { exitCode: number; output: string; threw?: boolean } {
    return withNativeClock(() => {
        const { NODE_TEST_CONTEXT: _context, GARDA_NEXT_STEP_TIMING: _timing, ...env } = process.env;
        const child = spawnSync(process.execPath, [CLI, ...argv], { cwd: process.cwd(), env,
            encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
        if (child.error || child.signal) throw new Error('Native walk command failed: ' + child.error + ' ' + child.signal + '\n' + child.stderr);
        return { exitCode: child.status ?? 1, output: child.stdout + child.stderr };
    });
}

/** A fresh process reconstructs scenario closures and fixture state; never replay a mutated closure. */
export async function replayNativeWalkFamily(item: WalkWork, directory: string): Promise<NativeFamily> {
    fs.mkdirSync(directory, { recursive: true });
    const input = path.join(directory, 'work.json'), output = path.join(directory, 'family.json');
    atomicWalkJson(input, item);
    const log = fs.openSync(path.join(directory, 'worker.log'), 'w');
    const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
    try {
        await new Promise<void>((resolve, reject) => {
            const child = spawn(process.execPath, [require.resolve('./walk-native-runner'), input, output], {
                windowsHide: true, stdio: ['ignore', log, log], env: { ...env,
                    GARDA_SYNTHETIC_WALK_DIAGNOSTICS: path.join(directory, 'journals') } });
            child.once('error', reject);
            child.once('close', code => code === 0 ? resolve() : reject(new Error('Native replay exit ' + code + ': ' + directory)));
        });
    } finally { fs.closeSync(log); }
    return JSON.parse(fs.readFileSync(output, 'utf8')) as NativeFamily;
}
