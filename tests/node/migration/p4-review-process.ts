// Controlled process reviewer for migration mechanics, not real-model semantic acceptance.
// This process writes only ordinary reviewer output. The old CLI produces all launch/receipt evidence.
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import assert from 'node:assert/strict';

interface Context {
    task_scope: { changed_files: string[] };
    tree_state: { tree_state_sha256: string };
    coverage_contract: { contract_sha256: string; obligations: Array<{ id: string; kind: string; target: string }> };
    review_execution: { mode: string; contract_sha256: string; delta?: { required_delta_targets?: string[] };
        finding_reconciliation: { resolvable_finding_ids: string[] } };
}

process.stdin.once('data', () => {
    setTimeout(() => {
        const [inputPath, verdict] = process.argv.slice(2);
        const input = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as Record<string, string>;
        const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        for (const name of ['review_context', 'role_prompt', 'prompt_template', 'reviewer_prompt', 'evidence_manifest', 'output_template']) {
            assert.equal(hash(input[`${name}_path`]), input[`${name}_sha256`], `Exact reviewer input binding: ${name}`);
        }
        const contextPath = input.review_context_path, outputPath = input.review_output_path, lane = input.review_type;
        const bytes = fs.readFileSync(contextPath);
        const context = JSON.parse(bytes.toString()) as Context;
        const file = context.coverage_contract.obligations.find(item => item.kind === 'file')?.target ?? context.task_scope.changed_files[0];
        const failed = verdict === 'FAIL';
        const finding = { id: 'F-001', title: 'Numeric input normalization is missing',
            description: 'The total function concatenates a numeric string instead of normalizing it before addition.',
            evidence: [{ location: `${file}:1`, observation: 'The implementation uses a + b without converting numeric input.' }],
            coverage_obligation_ids: [context.coverage_contract.obligations[0].id] };
        const execution = context.review_execution;
        const report = { schema_version: 2, task_id: 'T-P4', review_type: lane,
            review_context_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
            tree_state_sha256: context.tree_state.tree_state_sha256,
            review_execution: { mode: execution.mode, contract_sha256: execution.contract_sha256,
                covered_delta_targets: execution.delta?.required_delta_targets ?? [],
                inspected_prior_finding_ids: execution.finding_reconciliation.resolvable_finding_ids },
            validation_notes: [{ id: 'N-001', topic: 'complete-scope-sweep',
                note: 'Controlled local process reviewed the arithmetic fixture for the migration contract.',
                evidence: [{ location: `${file}:1`, observation: 'Source and changed task tests are available in the assigned context.' }] }],
            coverage_ledger: { coverage_contract_sha256: context.coverage_contract.contract_sha256,
                entries: context.coverage_contract.obligations.map((item, index) => ({ obligation_id: item.id,
                    evidence: [{ location: `${item.kind === 'file' ? item.target : file}:1`,
                        observation: `Inspected assigned ${item.kind} obligation ${item.target} in the controlled fixture.` }],
                    finding_ids: failed && index === 0 ? ['F-001'] : [] })) },
            findings: { critical: [], high: failed ? [finding] : [], medium: [], low: [] },
            residual_risks: [], reviewer_notes: ['P4 controlled process provider; no real model review is claimed.'] };
        fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
    }, 11_000); // Real elapsed work, no backdated launch timestamps or clock replacement.
});
