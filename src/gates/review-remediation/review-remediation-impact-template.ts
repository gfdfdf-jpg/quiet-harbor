/** Value of `--impact-analysis` shown in guidance; every `<analysis>` field must be replaced before the command runs. */
export const REVIEW_REMEDIATION_IMPACT_ANALYSIS_TEMPLATE = [
    'Reviewer finding: <analysis>',
    'Intended fix: <analysis>',
    'Affected files and contracts: <analysis>',
    'API/runtime/artifact/test impact: <analysis>',
    'Possible side effects: <analysis>',
    'Required targeted checks: <analysis>',
    'Scope or review-type changes: <analysis>',
    'Related blocker or follow-up decision: <analysis>'
].join('; ');
