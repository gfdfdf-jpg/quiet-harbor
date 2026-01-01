export const COMPILE_TEST_SEPARATION_RULE = 'Do not use test commands here';

/** Keep this module new to the task-test contract: an in-flight older updater may
 * already have rule-contracts in its module cache when the new migrations load. */
export function getRuleContractSnippetAlternatives(snippet: string): readonly string[] {
    const legacy = 'Do not use full-suite test commands here';
    return snippet === COMPILE_TEST_SEPARATION_RULE || snippet === legacy
        ? [COMPILE_TEST_SEPARATION_RULE, legacy] : [snippet];
}
