import * as path from 'node:path';
import { compactGuidance, compactGuidanceLine } from '../../core/compact/guidance';
import { resolveNextStepFromCliOptions } from '../../gates/next-step/next-step';
import { projectNextStepJson } from '../../gates/next-step/next-step-recommended-action';
import {
    formatNextStepCompactText,
    formatNextStepText,
    isNextStepRepositoryWorkStep
} from '../../gates/next-step/next-step-command-formatters';
import { runGateCliHandler } from './gate-cli-handler';
import { cachedUpdateAvailabilityNotice, prefetchUpdateAvailabilityNotice, scheduleUpdateAvailabilityCheck } from '../../lifecycle/update-availability/update-availability-worker';

export async function handleNextStep(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' },
        '--target-root': { key: 'repoRoot', type: 'string' },
        '--events-root': { key: 'eventsRoot', type: 'string' },
        '--reviews-root': { key: 'reviewsRoot', type: 'string' },
        '--execute-effects': { key: 'executeEffects', type: 'boolean' },
        '--effect-plan-sha256': { key: 'effectPlanSha256', type: 'string' },
        '--inspection-retry': { key: 'inspectionRetry', type: 'string' },
        '--as-json': { key: 'asJson', type: 'boolean' },
        '--verbose': { key: 'verbose', type: 'boolean' }
    };
    let notice = '';
    return runGateCliHandler(gateArgv, defs, async (options: Parameters<typeof resolveNextStepFromCliOptions>[0]) => {
        const root = path.resolve(String(options.repoRoot || '.'));
        let readNotice: ReturnType<typeof prefetchUpdateAvailabilityNotice> | undefined;
        try {
            const result = resolveNextStepFromCliOptions(options, () => {
                readNotice ??= prefetchUpdateAvailabilityNotice(root);
            });
            if (result.status === 'DONE' && result.final_report) {
                notice = await (readNotice?.() ?? cachedUpdateAvailabilityNotice(root));
                await scheduleUpdateAvailabilityCheck(root);
            }
            return result;
        } finally {
            readNotice?.cancel();
        }
    }, {
        parseConfig: { allowPositionals: true, maxPositionals: 1, allowResetPreflight: true },
        mapOptions: ({ options, positionals }) => ({ ...options, positionals: [...positionals] }),
        formatOutput: (result, { options }) => {
            const repoRoot = path.resolve(String(options.repoRoot || '.'));
            if (options.asJson === true) {
                const hint = result.status === 'DONE' ? '' : compactGuidance(repoRoot, result.task_id);
                return `${JSON.stringify({ ...projectNextStepJson(result), ...(hint ? { compact_hint: hint } : {}), ...(notice ? {
                    update_notice: notice,
                    update_notice_instruction: 'Append this English notice after the canonical final user report without changing that report.'
                } : {}) }, null, 2)}\n`;
            }
            // Text shows the compact CLI pointer only where the agent itself reads or edits the repository.
            const compactLine = isNextStepRepositoryWorkStep(result) ? compactGuidanceLine(repoRoot, result.task_id) : '';
            // The default text is the compact answer; --verbose prints the full text.
            const text = options.verbose === true ? formatNextStepText(result) : formatNextStepCompactText(result);
            return text + (compactLine ? `${compactLine}\n` : '') + (notice
                ? `\n${notice}\nAppend this English notice after the canonical final user report without changing that report.\n` : '');
        },
        resolveExitCode: () => 0
    });
}
