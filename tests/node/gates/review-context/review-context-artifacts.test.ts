import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildExhaustiveReviewContractLines,
    buildReviewContextHandoffArtifactPaths,
    buildReviewContextHandoffArtifacts,
    buildReviewerInstructionArtifacts,
    buildReviewEvidenceManifest,
    resolveReviewHandoffArtifactPath,
    type ReviewSkillBinding
} from '../../../../src/gates/review-context/review-context-artifacts';
import type { GitDiffSummary } from '../../../../src/gates/review-context/review-context-diff';
import { buildReviewCoverageContract } from '../../../../src/gates/review/review-coverage-ledger';
import type { ReviewContextLaneBinding } from '../../../../src/gates/review-context/review-context-lane';
import { buildBuildOutputExclusionMarkdown } from '../../../../src/gates/review-context/review-context-task-scope-markdown';
import { buildReviewerFocusedSelfValidationContractLines } from '../../../../src/gates/review/reviewer-execution-contract';

function sha256Text(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex');
}

function sampleSelectedSkill(): ReviewSkillBinding {
    return {
        skill_id: 'code-review',
        skill_path: 'garda-agent-orchestrator/live/skills/code-review/SKILL.md',
        skill_sha256: 'skill-sha',
        skill_directory_path: 'garda-agent-orchestrator/live/skills/code-review',
        skill_entrypoint_exists: true,
        candidate_skill_ids: ['code-review']
    };
}

function sampleGitDiff(): GitDiffSummary {
    return {
        stat: ' src/example.ts | 2 ++',
        diff: 'diff --git a/src/example.ts b/src/example.ts\n+const value = 1;\n',
        diff_truncated: false,
        diff_char_count: 64,
        command_status: 0,
        source: 'git',
        error: null,
        cache_path: 'garda-agent-orchestrator/runtime/reviews/T-001-code-scoped.diff',
        cached: false
    };
}

describe('gates/review-context-artifacts', () => {
    it('T-428 displays bounded build-output exclusions as escaped reviewer data', () => {
        const paths = ['bin/Debug/app.dll', 'bin/[click](https://example.invalid)/`script`.dll', 'bin/new\nheading.dll',
            ...Array.from({ length: 22 }, (_, index) => `bin/${index}.dll`)];
        const summary = buildBuildOutputExclusionMarkdown({ build_output_excluded_untracked_count: 25,
            build_output_excluded_untracked_files: paths }).join('\n');
        assert.match(summary, /25 untracked files \(first 20:/);
        assert.match(summary, /bin\/Debug\/app\.dll/);
        assert.ok(summary.includes('\\[click\\]\\(https://example.invalid\\)'));
        assert.ok(!summary.includes('\nheading'));
        assert.ok(!summary.includes('bin/21.dll'));
        assert.deepEqual(buildBuildOutputExclusionMarkdown({ build_output_excluded_untracked_count: 0,
            build_output_excluded_untracked_files: [] }), []);
        assert.deepEqual(buildBuildOutputExclusionMarkdown({ build_output_excluded_untracked_count: -1,
            build_output_excluded_untracked_files: paths }), []);
    });
    it('adds only normalized custom-lane role bindings while retaining the shared findings output contract', () => {
        const outputPath = path.join('runtime', 'reviews', 'T-001-architecture-boundary-review-context.json');
        const paths = buildReviewContextHandoffArtifactPaths(outputPath);
        const coverageContract = buildReviewCoverageContract({
            reviewType: 'architecture-boundary',
            changedFiles: ['src/example.ts'],
            categoryIds: ['maintainability']
        });
        const binding: ReviewContextLaneBinding = {
            schema_version: 1,
            review_type: 'architecture-boundary',
            selection: 'required',
            built_in: false,
            catalog_sha256: 'a'.repeat(64),
            profile_policy_sha256: 'b'.repeat(64),
            profile_snapshot_sha256: 'c'.repeat(64),
            effective_review_snapshot_sha256: 'd'.repeat(64),
            lane_definition_sha256: 'e'.repeat(64),
            skill_ids: ['architecture-review'],
            coverage_category_ids: ['maintainability'],
            reviewer_role: {
                role_id: 'architecture-reviewer',
                focus_tags: ['maintainability']
            },
            verdict_tokens: {
                pass: 'ARCHITECTURE BOUNDARY REVIEW PASSED',
                fail: 'ARCHITECTURE BOUNDARY REVIEW FAILED'
            },
            binding_sha256: 'f'.repeat(64)
        };

        const artifacts = buildReviewContextHandoffArtifacts({
            reviewType: 'architecture-boundary',
            selectedSkill: {
                ...sampleSelectedSkill(),
                skill_id: 'architecture-review',
                candidate_skill_ids: ['architecture-review']
            },
            paths,
            ruleContextSections: { source_file_count: 0, summary: {}, source_files: [] },
            promptArtifactText: '# Reviewer context\n',
            stripExamplesApplied: false,
            stripCodeBlocksApplied: false,
            coverageContract,
            reviewLaneBinding: binding
        });

        assert.match(artifacts.rolePromptArtifactText, /Catalog reviewer role id: architecture-reviewer/u);
        assert.match(artifacts.rolePromptArtifactText, /Catalog reviewer focus tags: maintainability/u);
        assert.match(artifacts.promptTemplateArtifactText, /Immutable lane binding sha256: f{64}/u);
        assert.match(artifacts.outputTemplateArtifactText, /"coverage_ledger"/u);
        assert.doesNotMatch(artifacts.outputTemplateArtifactText, /ARCHITECTURE BOUNDARY REVIEW (?:PASSED|FAILED)/u);
    });

    it('derives role, template, and manifest paths from canonical review-context output paths', () => {
        const outputPath = path.join(
            'garda-agent-orchestrator',
            'runtime',
            'reviews',
            'T-001-code-review-context.json'
        );

        assert.equal(
            resolveReviewHandoffArtifactPath(outputPath, '-role-prompt.md'),
            path.join('garda-agent-orchestrator', 'runtime', 'reviews', 'T-001-code-role-prompt.md')
        );

        const paths = buildReviewContextHandoffArtifactPaths(outputPath);
        assert.deepEqual(paths, {
            ruleContextArtifactPath: path.join('garda-agent-orchestrator', 'runtime', 'reviews', 'T-001-code-review-context.md'),
            rolePromptArtifactPath: path.join('garda-agent-orchestrator', 'runtime', 'reviews', 'T-001-code-role-prompt.md'),
            promptTemplateArtifactPath: path.join('garda-agent-orchestrator', 'runtime', 'reviews', 'T-001-code-prompt-template.md'),
            outputTemplateArtifactPath: path.join('garda-agent-orchestrator', 'runtime', 'reviews', 'T-001-code-output-template.md'),
            evidenceManifestArtifactPath: path.join('garda-agent-orchestrator', 'runtime', 'reviews', 'T-001-code-evidence-manifest.json')
        });
    });

    it('derives handoff paths from non-canonical json output paths without changing the basename prefix', () => {
        const outputPath = path.join('tmp', 'custom-review-context-output.json');

        assert.equal(
            resolveReviewHandoffArtifactPath(outputPath, '-evidence-manifest.json'),
            path.join('tmp', 'custom-review-context-output-evidence-manifest.json')
        );
        assert.equal(
            buildReviewContextHandoffArtifactPaths(outputPath).ruleContextArtifactPath,
            path.join('tmp', 'custom-review-context-output.md')
        );
    });

    it('builds evidence manifest shape with normalized artifact paths and stable sha wiring', () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-manifest-'));
        const outputPath = path.join('garda-agent-orchestrator', 'runtime', 'reviews', 'T-001-code-review-context.json');
        const paths = buildReviewContextHandoffArtifactPaths(outputPath);
        const selectedSkill = sampleSelectedSkill();
        const gitDiff = sampleGitDiff();
        const diffCachePath = path.join(tempRoot, 'T-001-scoped-diff-summary.json');
        fs.writeFileSync(diffCachePath, JSON.stringify({ summary: { diff: gitDiff.diff } }, null, 2) + '\n', 'utf8');
        gitDiff.cache_path = diffCachePath;
        const taskEvidence = {
            task_intent: { summary: 'Add focused helper tests' },
            task_row: { id: 'T-001' },
            plan: null
        };

        const result = buildReviewEvidenceManifest({
            taskId: 'T-001',
            reviewType: 'code',
            outputPath,
            paths,
            promptArtifactSha256: 'prompt-sha',
            rolePromptArtifactSha256: 'role-sha',
            promptTemplateArtifactSha256: 'prompt-template-sha',
            outputTemplateArtifactSha256: 'output-template-sha',
            selectedSkill,
            taskModePath: path.join('garda-agent-orchestrator', 'runtime', 'task-mode', 'T-001-task-mode.json'),
            taskModeSha256: 'task-mode-sha',
            taskModeEvidence: {
                dirty_workspace_baseline: {
                    changed_files: ['src/example.ts'],
                    file_hashes: { 'src/example.ts': 'entry-sha' }
                }
            },
            preflightPath: path.join('garda-agent-orchestrator', 'runtime', 'reviews', 'T-001-preflight.json'),
            preflightSha256: 'preflight-sha',
            scopedDiffExpected: true,
            scopedDiffMetadataPath: path.join('garda-agent-orchestrator', 'runtime', 'reviews', 'T-001-code-scoped.json'),
            scopedDiffMetadataSha256: 'scoped-sha',
            gitDiff,
            compileGateEvidence: { status: 'PASSED' },
            fullSuiteValidationEvidence: { status: 'PASSED' },
            focusedIntermediateValidationEvidence: { status: 'AVAILABLE' },
            manualValidationEvidence: { selected_log_count: 1 },
            trustBoundaryAnalysis: {
                required: false,
                status: 'not_required',
                applicability_reasons: [],
                rule_id: 'trust_boundary_adversarial_analysis',
                artifact_path: null,
                artifact_sha256: null,
                recorded_artifact_sha256: null,
                binding_event_sha256: null,
                matrix_sha256: null,
                matrix: [],
                violations: []
            },
            taskEvidence,
            coverageContract: buildReviewCoverageContract({
                reviewType: 'code',
                changedFiles: ['src/example.ts']
            })
        });

        assert.equal(result.evidenceManifest.schema_version, 1);
        assert.equal(result.evidenceManifest.task_id, 'T-001');
        assert.equal(result.evidenceManifest.review_type, 'code');
        assert.equal(result.evidenceManifest.selected_skill, selectedSkill);
        assert.equal(result.evidenceManifest.task_evidence, taskEvidence);
        assert.deepEqual(result.evidenceManifest.evidence_roles, {
            historical_authorization: [
                'task_mode',
                'task_mode.dirty_workspace_baseline'
            ],
            current_verification: [
                'preflight',
                'scoped_diff',
                'compile_gate',
                'full_suite_validation',
                'focused_intermediate_validation',
                'manual_validation',
                'trust_boundary_analysis',
                'tree_state'
            ],
            instruction: 'Historical task-mode authorization snapshots describe what was authorized at task entry. Use current verification artifacts for current file hashes, scoped diffs, compile/full-suite status, authenticated focused validation evidence, authenticated trust-boundary analysis, and review tree state.'
        });

        const artifacts = result.evidenceManifest.artifacts as Record<string, Record<string, unknown>>;
        assert.equal(artifacts.review_context.artifact_path, outputPath.replace(/\\/g, '/'));
        assert.equal(artifacts.reviewer_prompt.artifact_path, paths.ruleContextArtifactPath.replace(/\\/g, '/'));
        assert.equal(artifacts.reviewer_prompt.artifact_sha256, 'prompt-sha');
        assert.equal(artifacts.role_prompt.artifact_path, paths.rolePromptArtifactPath.replace(/\\/g, '/'));
        assert.equal(artifacts.role_prompt.artifact_sha256, 'role-sha');
        assert.equal(Object.hasOwn(artifacts.role_prompt, 'selected_skill'), false);
        assert.equal(result.evidenceManifest.selected_skill, selectedSkill);
        assert.equal(artifacts.prompt_template.artifact_path, paths.promptTemplateArtifactPath.replace(/\\/g, '/'));
        assert.equal(artifacts.prompt_template.artifact_sha256, 'prompt-template-sha');
        assert.equal(artifacts.output_template.artifact_path, paths.outputTemplateArtifactPath.replace(/\\/g, '/'));
        assert.equal(artifacts.output_template.artifact_sha256, 'output-template-sha');
        assert.equal(artifacts.task_mode.artifact_path, 'garda-agent-orchestrator/runtime/task-mode/T-001-task-mode.json');
        assert.equal(artifacts.task_mode.artifact_sha256, 'task-mode-sha');
        assert.equal(artifacts.task_mode.evidence_role, 'historical_authorization');
        assert.equal(artifacts.task_mode.current_verification_source, false);
        assert.deepEqual(artifacts.task_mode.current_verification_artifacts, [
            'preflight',
            'scoped_diff',
            'compile_gate',
            'full_suite_validation',
            'focused_intermediate_validation',
            'manual_validation',
            'trust_boundary_analysis',
            'tree_state'
        ]);
        const taskModeDirtyBaseline = artifacts.task_mode.dirty_workspace_baseline as Record<string, unknown>;
        assert.equal(taskModeDirtyBaseline.present, true);
        assert.equal(taskModeDirtyBaseline.evidence_role, 'historical_authorization_snapshot');
        assert.equal(taskModeDirtyBaseline.file_hashes_are_current, false);
        assert.equal(taskModeDirtyBaseline.changed_file_count, 1);
        assert.equal(taskModeDirtyBaseline.file_hash_count, 1);
        assert.equal(artifacts.preflight.artifact_sha256, 'preflight-sha');
        assert.equal(artifacts.scoped_diff.expected, true);
        assert.equal(artifacts.scoped_diff.diff_cache_path, gitDiff.cache_path);
        assert.equal(artifacts.scoped_diff.diff_cache_artifact_sha256, sha256Text(fs.readFileSync(diffCachePath, 'utf8')));
        assert.equal(artifacts.scoped_diff.diff_content_sha256, sha256Text(gitDiff.diff || ''));
        assert.equal(artifacts.scoped_diff.diff_sha256, sha256Text(gitDiff.diff || ''));
        assert.deepEqual(artifacts.compile_gate, { status: 'PASSED' });
        assert.deepEqual(artifacts.full_suite_validation, { status: 'PASSED' });
        assert.deepEqual(artifacts.focused_intermediate_validation, { status: 'AVAILABLE' });
        assert.deepEqual(artifacts.manual_validation, { selected_log_count: 1 });

        assert.ok(result.evidenceManifestText.endsWith('\n'));
        assert.equal(result.evidenceManifestSha256, sha256Text(result.evidenceManifestText));
        assert.deepEqual(JSON.parse(result.evidenceManifestText), result.evidenceManifest);
    });

    function buildElisionManifest(options: {
        fullSuiteValidationEvidence: Record<string, unknown>;
        trustBoundaryAnalysis: Record<string, unknown>;
        reviewContextElisionSource?: Parameters<typeof buildReviewEvidenceManifest>[0]['reviewContextElisionSource'];
    }) {
        const outputPath = path.join('garda-agent-orchestrator', 'runtime', 'reviews', 'T-002-test-review-context.json');
        return buildReviewEvidenceManifest({
            taskId: 'T-002',
            reviewType: 'test',
            outputPath,
            paths: buildReviewContextHandoffArtifactPaths(outputPath),
            promptArtifactSha256: 'prompt-sha',
            rolePromptArtifactSha256: 'role-sha',
            promptTemplateArtifactSha256: 'prompt-template-sha',
            outputTemplateArtifactSha256: 'output-template-sha',
            selectedSkill: sampleSelectedSkill(),
            taskModePath: '',
            taskModeSha256: null,
            taskModeEvidence: null,
            preflightPath: path.join('garda-agent-orchestrator', 'runtime', 'reviews', 'T-002-preflight.json'),
            preflightSha256: 'preflight-sha',
            scopedDiffExpected: false,
            scopedDiffMetadataPath: '',
            scopedDiffMetadataSha256: null,
            gitDiff: { ...sampleGitDiff(), cache_path: null },
            compileGateEvidence: { status: 'PASSED' },
            fullSuiteValidationEvidence: options.fullSuiteValidationEvidence,
            focusedIntermediateValidationEvidence: { status: 'AVAILABLE' },
            manualValidationEvidence: { selected_log_count: 0 },
            trustBoundaryAnalysis: options.trustBoundaryAnalysis as unknown as
                Parameters<typeof buildReviewEvidenceManifest>[0]['trustBoundaryAnalysis'],
            taskEvidence: { task_intent: null, task_row: { id: 'T-002' }, plan: null },
            coverageContract: buildReviewCoverageContract({ reviewType: 'test', changedFiles: ['src/example.ts'] }),
            ...(options.reviewContextElisionSource !== undefined
                ? { reviewContextElisionSource: options.reviewContextElisionSource }
                : {})
        });
    }

    function resolveJsonPointer(document: unknown, pointer: string): unknown {
        return pointer.split('/').slice(1).reduce<unknown>(
            (value, token) => (value as Record<string, unknown> | undefined)?.[token],
            document
        );
    }

    function sampleElisionEvidence(tempRoot: string) {
        const validationPlan = {
            mode: 'task_selection',
            cases: Array.from({ length: 4 }, (_, index) => ({ id: `case-${index}`, command: `npm test -- tests/example-${index}.test.ts` }))
        };
        const processEvidence = {
            runs: Array.from({ length: 3 }, (_, index) => ({
                execution_id: `exec-${index}`, exit_code: 0, command: `npm test -- tests/example-${index}.test.ts`, cwd: tempRoot
            }))
        };
        const cycleBinding = {
            preflight_sha256: 'p'.repeat(64),
            compile_gate_sha256: 'c'.repeat(64),
            compile_gate_artifact_path: 'garda-agent-orchestrator/runtime/reviews/T-002-compile-gate.json',
            matches_current_preflight: true
        };
        const matrix = ['cli-input', 'review-output-path', 'skill-reference'].map((boundaryId) => ({
            boundary_id: boundaryId, threat: 'path traversal through untrusted input', mitigation: 'resolve inside the repository root'
        }));
        const validationPhases = {
            schema_version: 1,
            phases: ['focused', 'compile', 'full-suite'].map((phase) => ({ phase, status: 'passed', command: `npm run ${phase}` }))
        };
        const fullSuitePath = path.join(tempRoot, 'T-002-full-suite-validation.json');
        const checklistPath = path.join(tempRoot, 'T-002-quality-checklist.json');
        const fullSuiteText = JSON.stringify({ task_test_validation_plan: validationPlan, task_test_process_evidence: processEvidence }) + '\n';
        const checklistText = JSON.stringify({ validation_phases: validationPhases, answers: [{ rule_id: 'x', trust_boundary_matrix: matrix }] }) + '\n';
        fs.writeFileSync(fullSuitePath, fullSuiteText, 'utf8');
        fs.writeFileSync(checklistPath, checklistText, 'utf8');
        const fullSuiteValidationEvidence: Record<string, unknown> = {
            status: 'PASSED',
            artifact_path: fullSuitePath,
            artifact_sha256: sha256Text(fullSuiteText),
            validation_plan: validationPlan,
            task_test_process_evidence: processEvidence,
            cycle_binding: cycleBinding,
            violations: []
        };
        const trustBoundaryAnalysis: Record<string, unknown> = {
            required: true,
            status: 'current',
            rule_id: 'trust_boundary_adversarial_analysis',
            artifact_path: checklistPath,
            artifact_sha256: sha256Text(checklistText),
            matrix,
            validation_phases: validationPhases,
            violations: []
        };
        return { fullSuitePath, checklistPath, fullSuiteValidationEvidence, trustBoundaryAnalysis };
    }

    it('references the hash-bound review context JSON for large copies and never the mutable primary artifacts', () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-manifest-elide-'));
        const evidence = sampleElisionEvidence(tempRoot);
        // The values build-review-context writes to the review context JSON, as that file is serialized.
        const reviewContextJson = JSON.parse(JSON.stringify({
            full_suite_validation: evidence.fullSuiteValidationEvidence,
            trust_boundary_analysis: evidence.trustBoundaryAnalysis
        }, null, 2)) as Record<string, unknown>;
        const build = () => buildElisionManifest({
            fullSuiteValidationEvidence: evidence.fullSuiteValidationEvidence,
            trustBoundaryAnalysis: evidence.trustBoundaryAnalysis,
            reviewContextElisionSource: {
                full_suite_validation: evidence.fullSuiteValidationEvidence,
                trust_boundary_analysis: evidence.trustBoundaryAnalysis
            }
        });

        const bound = build();
        const manifest = bound.evidenceManifest as Record<string, unknown>;
        const artifacts = manifest.artifacts as Record<string, Record<string, unknown>>;
        const elidedFields = [
            'artifacts.full_suite_validation.validation_plan',
            'artifacts.full_suite_validation.task_test_process_evidence',
            'artifacts.full_suite_validation.cycle_binding',
            'artifacts.trust_boundary_analysis.validation_phases',
            'artifacts.trust_boundary_analysis.matrix'
        ];
        assert.deepEqual(manifest.elided_review_context_copies, {
            fields: elidedFields,
            instruction: 'Each listed field is a verbatim copy of the value at its review_context_json_pointer in the review context JSON '
                + '(artifacts.review_context.artifact_path). The delegated reviewer is authorized to open that file and read the values '
                + 'at these pointers; its reviewer_routing.opaque_handoff_instruction addresses the launching orchestrator, not the reviewer. '
                + 'That file is bound by the review_context_sha256 of this launch handoff and verified when the review is recorded, so read '
                + 'the value there; value_sha256 (sha256 of the value\'s compact JSON) identifies it and need not be recomputed.'
        });
        assert.equal(artifacts.review_context.artifact_path,
            path.join('garda-agent-orchestrator', 'runtime', 'reviews', 'T-002-test-review-context.json').replace(/\\/g, '/'));
        for (const field of elidedFields) {
            const [, entryKey, fieldKey] = field.split('.');
            const reference = artifacts[entryKey][fieldKey] as Record<string, unknown>;
            const pointer = `/${entryKey}/${fieldKey}`;
            assert.deepEqual(reference, {
                elided_copy_of_review_context_value: true,
                review_context_json_pointer: pointer,
                value_sha256: sha256Text(JSON.stringify((reviewContextJson[entryKey] as Record<string, unknown>)[fieldKey]))
            }, field);
            // The review context JSON keeps the full value at the pointer.
            const resolved = resolveJsonPointer(reviewContextJson, pointer);
            assert.deepEqual(resolved, (entryKey === 'full_suite_validation'
                ? evidence.fullSuiteValidationEvidence : evidence.trustBoundaryAnalysis)[fieldKey], field);
            assert.equal(sha256Text(JSON.stringify(resolved)), reference.value_sha256, field);
        }
        assert.equal(bound.evidenceManifestText.includes('primary_json_pointer'), false);
        assert.equal(bound.evidenceManifestText.includes('elided_copy_of_primary_artifact'), false);
        assert.equal(artifacts.full_suite_validation.status, 'PASSED');
        assert.equal(artifacts.full_suite_validation.artifact_path, evidence.fullSuitePath);
        assert.equal(artifacts.full_suite_validation.artifact_sha256, evidence.fullSuiteValidationEvidence.artifact_sha256);
        assert.deepEqual(artifacts.full_suite_validation.violations, []);

        // Rewriting, corrupting or deleting a primary after construction changes nothing the reviewer is pointed at,
        // and a rebuild does not depend on the primaries at all.
        fs.writeFileSync(evidence.fullSuitePath, JSON.stringify({ task_test_validation_plan: { mode: 'rewritten' } }) + '\n', 'utf8');
        fs.writeFileSync(evidence.checklistPath, 'not json', 'utf8');
        assert.equal(build().evidenceManifestText, bound.evidenceManifestText);
        fs.rmSync(evidence.fullSuitePath);
        fs.rmSync(evidence.checklistPath);
        assert.equal(build().evidenceManifestText, bound.evidenceManifestText);
        for (const field of elidedFields) {
            const [, entryKey, fieldKey] = field.split('.');
            const reference = artifacts[entryKey][fieldKey] as Record<string, unknown>;
            assert.equal(sha256Text(JSON.stringify(resolveJsonPointer(reviewContextJson, `/${entryKey}/${fieldKey}`))), reference.value_sha256);
        }
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    it('keeps every manifest copy that the review context JSON does not hold verbatim or that is not worth a reference', () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-manifest-keep-'));
        const evidence = sampleElisionEvidence(tempRoot);
        const assertNothingElided = (result: ReturnType<typeof buildElisionManifest>, label: string) => {
            const artifacts = result.evidenceManifest.artifacts as Record<string, unknown>;
            assert.deepEqual(artifacts.full_suite_validation, evidence.fullSuiteValidationEvidence, label);
            assert.deepEqual(artifacts.trust_boundary_analysis, evidence.trustBoundaryAnalysis, label);
            assert.equal(Object.hasOwn(result.evidenceManifest, 'elided_review_context_copies'), false, label);
        };
        const build = (source: Parameters<typeof buildReviewEvidenceManifest>[0]['reviewContextElisionSource'], label: string) =>
            assertNothingElided(buildElisionManifest({
                fullSuiteValidationEvidence: evidence.fullSuiteValidationEvidence,
                trustBoundaryAnalysis: evidence.trustBoundaryAnalysis,
                reviewContextElisionSource: source
            }), label);

        assertNothingElided(buildElisionManifest({
            fullSuiteValidationEvidence: evidence.fullSuiteValidationEvidence,
            trustBoundaryAnalysis: evidence.trustBoundaryAnalysis
        }), 'no review context source');
        build(null, 'null review context source');
        build({}, 'review context source without the entries');
        build({ full_suite_validation: 'not an object', trust_boundary_analysis: [evidence.trustBoundaryAnalysis] }, 'non-object entries');
        build({ full_suite_validation: {}, trust_boundary_analysis: {} }, 'entries without the fields');
        const differing = (entry: Record<string, unknown>, fields: string[]) => Object.fromEntries(
            Object.entries(entry).map(([key, value]) => [key, fields.includes(key) ? { changed: key } : value])
        );
        build({
            full_suite_validation: differing(evidence.fullSuiteValidationEvidence,
                ['validation_plan', 'task_test_process_evidence', 'cycle_binding']),
            trust_boundary_analysis: differing(evidence.trustBoundaryAnalysis, ['validation_phases', 'matrix'])
        }, 'differing review context values');

        // A field that is missing, null, or so small that a reference is not shorter stays as it is.
        const small = buildElisionManifest({
            fullSuiteValidationEvidence: { ...evidence.fullSuiteValidationEvidence, validation_plan: null, cycle_binding: { ok: true } },
            trustBoundaryAnalysis: { ...evidence.trustBoundaryAnalysis, matrix: [], validation_phases: undefined },
            reviewContextElisionSource: {
                full_suite_validation: { ...evidence.fullSuiteValidationEvidence, validation_plan: null, cycle_binding: { ok: true } },
                trust_boundary_analysis: { ...evidence.trustBoundaryAnalysis, matrix: [] }
            }
        });
        const smallArtifacts = small.evidenceManifest.artifacts as Record<string, Record<string, unknown>>;
        assert.equal(smallArtifacts.full_suite_validation.validation_plan, null);
        assert.deepEqual(smallArtifacts.full_suite_validation.cycle_binding, { ok: true });
        assert.deepEqual(smallArtifacts.trust_boundary_analysis.matrix, []);
        assert.equal(Object.hasOwn(smallArtifacts.trust_boundary_analysis, 'validation_phases'), true);
        assert.equal(smallArtifacts.trust_boundary_analysis.validation_phases, undefined);
        assert.deepEqual((small.evidenceManifest as Record<string, unknown>).elided_review_context_copies, {
            fields: ['artifacts.full_suite_validation.task_test_process_evidence'],
            instruction: (small.evidenceManifest as Record<string, Record<string, unknown>>).elided_review_context_copies.instruction
        });
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    it('writes the evidence manifest as indented JSON without extreme lines', () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-manifest-lines-'));
        const evidence = sampleElisionEvidence(tempRoot);
        const result = buildElisionManifest({
            fullSuiteValidationEvidence: evidence.fullSuiteValidationEvidence,
            trustBoundaryAnalysis: evidence.trustBoundaryAnalysis
        });
        assert.equal(result.evidenceManifestText, JSON.stringify(result.evidenceManifest, null, 2) + '\n');
        assert.equal(result.evidenceManifestSha256, sha256Text(result.evidenceManifestText));
        const lines = result.evidenceManifestText.split('\n');
        assert.ok(lines.length > 50);
        assert.ok(Math.max(...lines.map((line) => line.length)) < 1000);
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    it('selects the role prompt rules by hasEmptyReviewerScope for empty and nonempty scopes', () => {
        const paths = buildReviewContextHandoffArtifactPaths(
            path.join('garda-agent-orchestrator', 'runtime', 'reviews', 'T-003-code-review-context.json')
        );
        const build = (changedFiles: string[]) => buildReviewerInstructionArtifacts({
            reviewType: 'code',
            selectedSkill: sampleSelectedSkill(),
            paths,
            coverageContract: buildReviewCoverageContract({ reviewType: 'code', changedFiles })
        });
        const count = (text: string, line: string) => text.split(line).length - 1;
        const genericExhaustiveLines = buildExhaustiveReviewContractLines();
        const emptyScopeLines = buildExhaustiveReviewContractLines(
            buildReviewCoverageContract({ reviewType: 'code', changedFiles: [] })
        );
        const focusedLines = buildReviewerFocusedSelfValidationContractLines();
        const focusedNote = '- Focused self-check rules are part of the Findings-Only Output Contract in the prompt template artifact.';
        const activeFindingFieldsLine = 'Active finding object fields: id, title, description';
        assert.notDeepEqual(emptyScopeLines, genericExhaustiveLines);

        // Empty authenticated scope: the empty-scope variant only (operator decision of 2026-11-16), and the focused
        // self-check rules stay in the role prompt as before because the prompt template replaces them.
        const empty = build([]);
        for (const line of [...emptyScopeLines, ...focusedLines]) {
            assert.equal(count(empty.rolePromptArtifactText, line), 1, line);
        }
        for (const line of genericExhaustiveLines) {
            assert.equal(empty.rolePromptArtifactText.includes(line), false, line);
        }
        assert.equal(empty.rolePromptArtifactText.includes(focusedNote), false);
        assert.equal(empty.rolePromptArtifactText.includes(activeFindingFieldsLine), false);
        assert.ok(empty.promptTemplateArtifactText.includes(
            'An empty evidence domain has no authorized focused command target; inspect existing validation records without executing commands.'
        ));
        for (const line of focusedLines) {
            assert.equal(empty.promptTemplateArtifactText.includes(line), false, line);
        }

        // Nonempty scope: the generic exhaustive-review lines once in the role prompt, the focused rules once in the
        // prompt template contract, which the role prompt names instead of repeating them.
        const nonEmpty = build(['src/example.ts']);
        for (const line of genericExhaustiveLines) {
            assert.equal(count(nonEmpty.rolePromptArtifactText, line), 1, line);
        }
        for (const line of emptyScopeLines) {
            assert.equal(nonEmpty.rolePromptArtifactText.includes(line), false, line);
        }
        for (const line of focusedLines) {
            assert.equal(nonEmpty.rolePromptArtifactText.includes(line), false, line);
            assert.equal(count(nonEmpty.promptTemplateArtifactText, line), 1, line);
        }
        assert.equal(count(nonEmpty.rolePromptArtifactText, focusedNote), 1);
        assert.ok(nonEmpty.promptTemplateArtifactText.includes('Active finding object shape: {"id":"F-001"'));
    });

    it('carries both neutral missing-plan rules once, in the prompt template', () => {
        const artifacts = buildReviewerInstructionArtifacts({
            reviewType: 'code',
            selectedSkill: sampleSelectedSkill(),
            paths: buildReviewContextHandoffArtifactPaths(
                path.join('garda-agent-orchestrator', 'runtime', 'reviews', 'T-004-code-review-context.json')
            ),
            coverageContract: buildReviewCoverageContract({ reviewType: 'code', changedFiles: ['src/example.ts'] })
        });
        for (const line of [
            '- If no task-mode JSON plan or optional Markdown working plan was attached, treat that absence as neutral for non-plan-guided tasks; do not report it as a finding, deferred finding, or residual risk.',
            '- Missing optional Markdown working plans and absent task-mode JSON plans in non-plan-guided tasks are neutral; do not report their absence as a finding, deferred finding, or residual risk.'
        ]) {
            assert.equal(artifacts.promptTemplateArtifactText.split(line).length - 1, 1, line);
            assert.equal(artifacts.rolePromptArtifactText.includes(line), false, line);
            assert.equal(artifacts.outputTemplateArtifactText.includes(line), false, line);
        }
    });
});
