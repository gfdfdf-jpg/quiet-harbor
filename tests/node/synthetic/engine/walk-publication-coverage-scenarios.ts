import { splitCommandLine } from '../../../../src/core/command-line';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WalkScenario } from './navigator-walk';
import { NativeWalkOwner } from './walk-native-owner';
import { interruptPublication } from './walk-publication-interrupt';

function publication(kind: 'delegation-start' | 'launch-complete' | 'correction-transport'): WalkScenario {
    let owner: NativeWalkOwner | undefined;
    const correction = kind === 'correction-transport';
    const gate = correction ? 'record-review-output-correction-transport' : kind === 'delegation-start'
        ? 'record-reviewer-delegation-started' : 'complete-reviewer-launch';
    const modulePath = correction
        ? require.resolve('../../../../src/cli/commands/gate-review-handlers/result/review-result-handlers')
        : kind === 'delegation-start'
            ? require.resolve('../../../../src/cli/commands/gate-review-handlers/launch/review-launch-delegation-started-handler')
            : require.resolve('../../../../src/cli/commands/gate-review-handlers/launch/review-launch-complete-handler');
    const statement = correction ? 'await emitPersistedTransportSelection(persisted);'
        : kind === 'delegation-start' ? 'appendCommitted = await options.emitStartedEvent('
            : 'appendCommitted = await options.emitCompletedEvent(';
    return {
        id: 'coverage-publication-' + kind,
        edits: [{ path: 'src/app.ts', append: '// publication recovery\n' }, { path: 'tests/app.test.ts', append: '// publication recovery\n' }],
        expectedReviews: correction ? { code: 2, test: 1 } : { code: 1, test: 1 },
        expectedModes: correction ? ['code:FULL', 'code:FULL', 'test:FULL'] : ['code:FULL', 'test:FULL'],
        // After the original session is closed, recovery must restart the affected review in FULL.
        expectedRoutes: correction ? ['src/gates/next-step/next-step-review-reuse-routing.ts:237:16']
            : ['src/gates/next-step/next-step-review-readiness-routing.ts:'
            + (kind === 'delegation-start' ? '181:20' : '208:20')],
        ...(correction ? { disturbances: [{ kind: 'invalid-report-shape' as const, lane: 'code' }],
            reviewerAttestation: 'provider-no-live-receipt' as const, expectedFailingGates: ['record-review-result'],
            prepare: async (root, steps, run) => {
                const last = steps.at(-1);
                if (owner || last?.gate !== 'record-review-result' || !last.exitCode) return;
                const correctionPath = path.join(root, 'garda-agent-orchestrator/runtime/reviews/T-WALK-code-output-correction.json');
                const artifact = JSON.parse(fs.readFileSync(correctionPath, 'utf8')) as {
                    binding: { reviewer_identity: string }; transport_binding: { provider_invocation_id: string }
                };
                const argv = [gate, '--task-id', 'T-WALK', '--review-type', 'code',
                    '--correction-artifact-path', correctionPath, '--session-availability', 'closed',
                    '--reviewer-identity', artifact.binding.reviewer_identity,
                    '--provider-invocation-id', artifact.transport_binding.provider_invocation_id, '--repo-root', '.'];
                owner = new NativeWalkOwner(root, argv, true);
                const boundary = await interruptPublication(owner, modulePath, statement);
                (last.preparation ??= []).push({ command: gate, output: 'Native owner interrupted at ' + boundary + '.' });
                await run(argv);
            } } : {}),
        disturbanceReason: 'Interrupt the real native ' + gate + ' at a debugger breakpoint after durable publication and before its next authenticated write.',
        execute: async (root, step) => {
            if (correction || owner || step.gate !== gate) return false;
            const argv = splitCommandLine(step.command!);
            owner = new NativeWalkOwner(root, argv.slice(argv.indexOf('gate') + 1), true);
            const boundary = await interruptPublication(owner, modulePath, statement);
            step.output = 'Native owner interrupted at ' + boundary + '. No evidence was edited.';
            return true;
        },
        cleanup: async () => { await owner?.killTree(); }
    };
}

export const PUBLICATION_COVERAGE_WALK_SCENARIOS: readonly WalkScenario[] = [
    publication('delegation-start'), publication('launch-complete'), publication('correction-transport')
];
