import type { NextStepResult } from './next-step';
import { selectTaskCompositeAction } from './next-step-composite-action';
import { isNextStepAdvanceRecommendationUnavailable } from './next-step-composite-recommendation-context';

export interface NextStepRecommendedAction {
    mode: 'advance';
    command: string;
}

/** Presentation only. Eligibility, including the default effect allowlist, belongs to the runner's selector. */
export function selectNextStepRecommendedAction(result: NextStepResult): NextStepRecommendedAction | null {
    if (result.review_cycle_block || isNextStepAdvanceRecommendationUnavailable(result)) return null;
    if (selectTaskCompositeAction(result, 'advance', null).kind !== 'execute') return null;
    // Reuse the navigator invocation verbatim, including its CLI prefix and repo-root argument. This substitution
    // formats the recommendation; command text never supplies execution authority or determines eligibility.
    const invocation = ` next-step "${result.task_id}" `;
    const command = result.navigator_command.replace(invocation, ` task "${result.task_id}" advance `);
    if (command === result.navigator_command) return null;
    return { mode: 'advance', command };
}

/** Existing fields and single-step commands are retained; no descriptor or executable authority is serialized. */
export function projectNextStepJson(result: NextStepResult): NextStepResult & { recommended_action?: NextStepRecommendedAction } {
    const recommended = selectNextStepRecommendedAction(result);
    const output: NextStepResult & { recommended_action?: NextStepRecommendedAction } = { ...result };
    if (recommended) output.recommended_action = recommended;
    else delete output.recommended_action;
    return output;
}
