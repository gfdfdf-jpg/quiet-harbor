import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildReviewContextHandoffArtifactPaths,
    buildReviewEvidenceManifest,
    writeReviewContextArtifactFiles
} from '../../../../src/gates/review-context/review-context-artifacts';
import { buildReviewCoverageContract } from '../../../../src/gates/review/review-coverage-ledger';
import { resolveReviewerHandoffArtifactBindings } from '../../../../src/gates/review/review-prompt-artifact';

function sha256Text(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex');
}

function resolveJsonPointer(document: unknown, dottedField: string): unknown {
    return dottedField.split('.').reduce<unknown>(
        (value, token) => (value as Record<string, unknown> | undefined)?.[token],
        document
    );
}

// Field shape of shop T-007-4-F1: two retained JUnit adapter reports (~260 KB and ~120 KB of base64).
function buildAdapterReport(caseCount: number): string {
    const cases = Array.from({ length: caseCount }, (_, index) => (
        `  <testcase classname="shop.OrderServiceTest" name="case_${index}_keeps_order_total" time="0.01${index % 10}"/>`
    ));
    return ['<?xml version="1.0" encoding="UTF-8"?>', `<testsuite name="OrderServiceTest" tests="${caseCount}">`,
        ...cases, '</testsuite>', ''].join('\n');
}

function buildFieldShapedEvidence() {
    const reports = [buildAdapterReport(1800), buildAdapterReport(800)];
    const fullSuiteValidationEvidence: Record<string, unknown> = {
        status: 'PASSED',
        command: 'mvn -q test -Dtest=OrderServiceTest',
        task_test_adapter_reports: reports.map((xml, index) => ({
            adapter: 'junit-xml',
            reports: [{
                observation: { path: `target/surefire-reports/TEST-${index}.xml`, sha256: sha256Text(xml) },
                content_base64: Buffer.from(xml, 'utf8').toString('base64')
            }]
        })),
        violations: []
    };
    return { reports, fullSuiteValidationEvidence };
}

function buildManifest(tempRoot: string, fullSuiteValidationEvidence: Record<string, unknown>) {
    const outputPath = path.join(tempRoot, 'T-007-test-review-context.json');
    const paths = buildReviewContextHandoffArtifactPaths(outputPath);
    const result = buildReviewEvidenceManifest({
        taskId: 'T-007', reviewType: 'test', outputPath, paths,
        promptArtifactSha256: 'prompt-sha', rolePromptArtifactSha256: 'role-sha',
        promptTemplateArtifactSha256: 'prompt-template-sha', outputTemplateArtifactSha256: 'output-template-sha',
        selectedSkill: {
            skill_id: 'test-review', skill_path: 'live/skills/test-review/SKILL.md', skill_sha256: 'skill-sha',
            skill_directory_path: 'live/skills/test-review', skill_entrypoint_exists: true, candidate_skill_ids: ['test-review']
        },
        taskModePath: '', taskModeSha256: null, taskModeEvidence: null,
        preflightPath: path.join(tempRoot, 'T-007-preflight.json'), preflightSha256: 'preflight-sha',
        scopedDiffExpected: false, scopedDiffMetadataPath: '', scopedDiffMetadataSha256: null,
        gitDiff: { stat: '', diff: '', diff_truncated: false, diff_char_count: 0, command_status: 0,
            source: 'git', error: null, cache_path: null, cached: false },
        compileGateEvidence: { status: 'PASSED' },
        fullSuiteValidationEvidence,
        focusedIntermediateValidationEvidence: { status: 'AVAILABLE' },
        manualValidationEvidence: { selected_log_count: 0 },
        trustBoundaryAnalysis: { required: false } as unknown as
            Parameters<typeof buildReviewEvidenceManifest>[0]['trustBoundaryAnalysis'],
        taskEvidence: { task_intent: null, task_row: { id: 'T-007' }, plan: null },
        coverageContract: buildReviewCoverageContract({ reviewType: 'test', changedFiles: ['src/order.ts'] }),
        reviewContextElisionSource: { full_suite_validation: fullSuiteValidationEvidence, trust_boundary_analysis: { required: false } }
    });
    return { outputPath, paths, result };
}

describe('gates/review-evidence-manifest-externalization', () => {
    it('keeps a field-sized evidence manifest readable and moves retained report bytes to hash-bound files', () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-manifest-bounded-'));
        try {
            const evidence = buildFieldShapedEvidence();
            const originalSize = JSON.stringify(evidence.fullSuiteValidationEvidence).length;
            assert.ok(originalSize > 200_000, `fixture must reproduce the oversized field manifest (${originalSize})`);
            const { outputPath, paths, result } = buildManifest(tempRoot, evidence.fullSuiteValidationEvidence);

            assert.ok(result.evidenceManifestText.length < 32 * 1024,
                `manifest must stay within a normal file-read limit; got ${result.evidenceManifestText.length} chars`);
            assert.ok(Math.max(...result.evidenceManifestText.split('\n').map((line) => line.length)) < 1000);
            const manifest = result.evidenceManifest as Record<string, Record<string, unknown>>;
            const fields = manifest.externalized_manifest_values.fields as string[];
            assert.deepEqual(fields, [
                'artifacts.full_suite_validation.task_test_adapter_reports.0.reports.0.content_base64',
                'artifacts.full_suite_validation.task_test_adapter_reports.1.reports.0.content_base64'
            ]);

            writeReviewContextArtifactFiles({
                paths, promptArtifactText: 'p', rolePromptArtifactText: 'r', promptTemplateArtifactText: 't',
                outputTemplateArtifactText: 'o', evidenceManifestText: result.evidenceManifestText,
                externalizedValueFiles: result.externalizedValueFiles, outputPath,
                reviewContextPayload: { full_suite_validation: evidence.fullSuiteValidationEvidence }, repoRoot: tempRoot
            });
            assert.deepEqual((manifest.externalized_manifest_values.files as Array<Record<string, string>>)
                .map((file) => [file.content_path, file.content_sha256]),
            result.externalizedValueFiles.map((file) => [file.path, sha256Text(file.text)]),
            'the manifest binds every sidecar path and sha256');
            const reviewContext = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
            fields.forEach((field, index) => {
                const reference = resolveJsonPointer(manifest, field) as Record<string, unknown>;
                const original = resolveJsonPointer(reviewContext, field.replace(/^artifacts\./u, '')) as string;
                const fileText = fs.readFileSync(String(reference.content_path), 'utf8');
                assert.equal(reference.externalized_manifest_value, true, field);
                assert.equal(reference.content_encoding, 'utf8_decoded_from_base64', field);
                assert.equal(fileText, evidence.reports[index], field);
                assert.equal(sha256Text(fileText), reference.content_sha256, field);
                assert.equal(path.basename(String(reference.content_path)), `${reference.content_sha256}.txt`, field);
                assert.equal(Buffer.from(fileText, 'utf8').toString('base64'), original, field);
                assert.equal(sha256Text(original), reference.original_value_sha256, field);
                assert.equal(reference.original_char_count, original.length, field);
            });
            const fullSuite = manifest.artifacts.full_suite_validation as Record<string, unknown>;
            assert.equal(fullSuite.command, evidence.fullSuiteValidationEvidence.command);
            assert.equal(fs.readFileSync(paths.evidenceManifestArtifactPath, 'utf8'), result.evidenceManifestText);
            assert.equal(buildManifest(tempRoot, evidence.fullSuiteValidationEvidence).result.evidenceManifestSha256,
                result.evidenceManifestSha256, 'manifest bytes stay deterministic for identical evidence');
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('stores a long non-base64 or non-UTF-8 value verbatim and leaves short values inline', () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-manifest-verbatim-'));
        try {
            const binary = Buffer.alloc(6000, 0xff).toString('base64');
            const longText = 'x'.repeat(5000);
            const { result } = buildManifest(tempRoot, {
                status: 'PASSED', stdout_base64: binary, summary: longText, short_base64: Buffer.from('ok').toString('base64')
            });
            const fullSuite = (result.evidenceManifest as Record<string, Record<string, Record<string, unknown>>>)
                .artifacts.full_suite_validation;
            const stdout = fullSuite.stdout_base64 as unknown as Record<string, unknown>;
            const summary = fullSuite.summary as unknown as Record<string, unknown>;
            assert.equal(stdout.content_encoding, 'utf8');
            assert.equal(stdout.content_sha256, sha256Text(binary));
            assert.equal(summary.content_encoding, 'utf8');
            assert.equal(summary.content_sha256, sha256Text(longText));
            assert.equal(fullSuite.short_base64, Buffer.from('ok').toString('base64'));
            assert.deepEqual(result.externalizedValueFiles.map((file) => file.text).sort(), [binary, longText].sort());
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('bounds the total manifest size when one large report sits beside many smaller ones', () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-manifest-total-'));
        try {
            // Probe shape from the review: 1 large report and 31 small ones gave a 102,189-byte manifest.
            const reports = [buildAdapterReport(1800), ...Array.from({ length: 31 }, () => buildAdapterReport(30))];
            const evidence = {
                status: 'PASSED', command: 'mvn -q test',
                task_test_adapter_reports: reports.map((xml, index) => ({ adapter: 'junit-xml', reports: [{
                    observation: { path: `target/surefire-reports/TEST-${index}.xml`, sha256: sha256Text(xml) },
                    content_base64: Buffer.from(xml, 'utf8').toString('base64') }] })),
                violations: []
            };
            const { result } = buildManifest(tempRoot, evidence);
            assert.ok(result.evidenceManifestText.length < 48 * 1024,
                `manifest total must stay bounded; got ${result.evidenceManifestText.length} chars`);
            const manifest = result.evidenceManifest as Record<string, Record<string, unknown>>;
            const section = manifest.externalized_manifest_values;
            const index = section.index as { content_path: string; content_sha256: string } | undefined;
            const indexFile = index && result.externalizedValueFiles.find(file => file.path === index.content_path);
            if (index) {
                assert.ok(indexFile);
                assert.equal(sha256Text(indexFile.text), index.content_sha256);
            }
            const { files: listed } = indexFile ? JSON.parse(indexFile.text) as { files: unknown[] } : section;
            assert.ok(Array.isArray(listed));
            assert.equal(listed.length, result.externalizedValueFiles.length - Number(Boolean(indexFile)));
            for (const file of result.externalizedValueFiles) assert.ok(file.text.length > 0);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('bounds the final manifest with its index included when many captures are externalized', () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-manifest-index-'));
        try {
            // Review probe: 128 captures gave a 71 KB manifest because the fields and files index stayed inline.
            const reports = Array.from({ length: 128 }, (_, index) => buildAdapterReport(40 + index));
            const evidence = {
                status: 'PASSED', command: 'mvn -q test',
                task_test_adapter_reports: reports.map((xml, index) => ({ adapter: 'junit-xml', reports: [{
                    observation: { path: `target/surefire-reports/TEST-${index}.xml`, sha256: sha256Text(xml) },
                    content_base64: Buffer.from(xml, 'utf8').toString('base64') }] })),
                violations: []
            };
            const { outputPath, paths, result } = buildManifest(tempRoot, evidence);
            assert.ok(result.evidenceManifestText.length < 32 * 1024,
                `final manifest including its index must stay bounded; got ${result.evidenceManifestText.length} chars`);
            const section = (result.evidenceManifest as Record<string, Record<string, unknown>>).externalized_manifest_values;
            assert.equal(section.files, undefined, 'a long index is not inline');
            const index = section.index as Record<string, unknown>;
            const indexFile = result.externalizedValueFiles.find((file) => file.path === index.content_path);
            assert.ok(indexFile, 'the index sidecar is written with the other sidecars');
            assert.equal(sha256Text(indexFile!.text), index.content_sha256);
            const listed = JSON.parse(indexFile!.text) as { fields: string[]; files: Array<Record<string, string>> };
            assert.equal(listed.files.length, result.externalizedValueFiles.length - 1);
            assert.equal(index.file_count, listed.files.length);
            assert.ok(listed.fields.length >= 128, String(listed.fields.length));

            writeReviewContextArtifactFiles({
                paths, promptArtifactText: 'p', rolePromptArtifactText: 'r', promptTemplateArtifactText: 't',
                outputTemplateArtifactText: 'o', evidenceManifestText: result.evidenceManifestText,
                externalizedValueFiles: result.externalizedValueFiles, outputPath,
                reviewContextPayload: { full_suite_validation: evidence }, repoRoot: tempRoot
            });
            const handoff = (file: string) => ({ artifact_path: file.replace(/\\/gu, '/'),
                artifact_sha256: sha256Text(fs.readFileSync(file, 'utf8')) });
            const reviewContext = { reviewer_handoff: {
                prompt_template: handoff(paths.promptTemplateArtifactPath),
                output_template: handoff(paths.outputTemplateArtifactPath),
                evidence_manifest: handoff(paths.evidenceManifestArtifactPath)
            } };
            const bind = () => resolveReviewerHandoffArtifactBindings({ repoRoot: tempRoot, contextPath: outputPath,
                reviewContext, gateName: 'prepare-reviewer-launch' });
            bind();
            // The index binds every listed file, and the manifest binds the index.
            const listedFile = listed.files[0].content_path;
            const listedText = fs.readFileSync(listedFile, 'utf8');
            fs.writeFileSync(listedFile, `${listedText} `);
            assert.throws(bind, /evidence manifest value file is stale/u);
            fs.writeFileSync(listedFile, listedText);
            fs.writeFileSync(indexFile!.path, indexFile!.text.replace(listed.files[1].content_sha256, 'f'.repeat(64)));
            assert.throws(bind, /evidence manifest value file is stale/u);
            fs.writeFileSync(indexFile!.path, indexFile!.text);
            bind();
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('checks the references inside a JSON subtree sidecar from the same bytes it hashed', () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-manifest-json-sidecar-'));
        try {
            const evidence = buildFieldShapedEvidence();
            const { outputPath, paths, result } = buildManifest(tempRoot, evidence.fullSuiteValidationEvidence);
            writeReviewContextArtifactFiles({
                paths, promptArtifactText: 'p', rolePromptArtifactText: 'r', promptTemplateArtifactText: 't',
                outputTemplateArtifactText: 'o', evidenceManifestText: result.evidenceManifestText,
                externalizedValueFiles: result.externalizedValueFiles, outputPath,
                reviewContextPayload: { full_suite_validation: evidence.fullSuiteValidationEvidence }, repoRoot: tempRoot
            });
            const valuesDirectory = path.dirname(result.externalizedValueFiles[0].path);
            const reference = (contentPath: string, sha256: string, encoding: string) => ({ externalized_manifest_value: true,
                content_path: contentPath.replace(/\\/gu, '/'), content_sha256: sha256, content_encoding: encoding,
                content_char_count: 1, original_value_sha256: sha256, original_char_count: 1 });
            // A JSON subtree sidecar that references a file the manifest never listed.
            const unlisted = path.join(valuesDirectory, `${'a'.repeat(64)}.txt`);
            const subtreeText = `${JSON.stringify({ nested: reference(unlisted, 'a'.repeat(64), 'utf8') }, null, 2)}\n`;
            const subtreePath = path.join(valuesDirectory, `${sha256Text(subtreeText)}.txt`);
            fs.writeFileSync(subtreePath, subtreeText);
            const manifest = JSON.parse(result.evidenceManifestText) as Record<string, Record<string, unknown>>;
            manifest.artifacts.extra_subtree = reference(subtreePath, sha256Text(subtreeText), 'json');
            (manifest.externalized_manifest_values.files as unknown[]).push({
                content_path: subtreePath.replace(/\\/gu, '/'), content_sha256: sha256Text(subtreeText) });
            fs.writeFileSync(paths.evidenceManifestArtifactPath, `${JSON.stringify(manifest, null, 2)}\n`);
            const handoff = (file: string) => ({ artifact_path: file.replace(/\\/gu, '/'),
                artifact_sha256: sha256Text(fs.readFileSync(file, 'utf8')) });
            const reviewContext = { reviewer_handoff: {
                prompt_template: handoff(paths.promptTemplateArtifactPath),
                output_template: handoff(paths.outputTemplateArtifactPath),
                evidence_manifest: handoff(paths.evidenceManifestArtifactPath)
            } };
            assert.throws(() => resolveReviewerHandoffArtifactBindings({ repoRoot: tempRoot, contextPath: outputPath,
                reviewContext, gateName: 'prepare-reviewer-launch' }), /evidence manifest value file is not listed/u);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('refuses sidecar writes through a junction out of the repository and detects replaced or missing sidecars at launch', () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-manifest-sidecar-'));
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-manifest-outside-'));
        try {
            const evidence = buildFieldShapedEvidence();
            const { outputPath, paths, result } = buildManifest(tempRoot, evidence.fullSuiteValidationEvidence);
            const write = (repoRoot?: string) => writeReviewContextArtifactFiles({
                paths, promptArtifactText: 'p', rolePromptArtifactText: 'r', promptTemplateArtifactText: 't',
                outputTemplateArtifactText: 'o', evidenceManifestText: result.evidenceManifestText,
                externalizedValueFiles: result.externalizedValueFiles, outputPath,
                reviewContextPayload: { full_suite_validation: evidence.fullSuiteValidationEvidence },
                ...(repoRoot ? { repoRoot } : {})
            });
            const valuesDirectory = path.dirname(result.externalizedValueFiles[0].path);
            assert.throws(() => write(), /ExternalizedManifestValuePath must resolve inside repo root/u,
                'sidecars are never written without a repository root to contain them');
            fs.symlinkSync(outside, valuesDirectory, 'junction');
            assert.throws(() => write(tempRoot), /ExternalizedManifestValuePath must resolve inside repo root/u);
            assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written outside the repository');
            fs.rmSync(valuesDirectory, { recursive: true, force: true });

            write(tempRoot);
            const handoff = (file: string) => ({ artifact_path: file.replace(/\\/gu, '/'),
                artifact_sha256: sha256Text(fs.readFileSync(file, 'utf8')) });
            const reviewContext = { reviewer_handoff: {
                prompt_template: handoff(paths.promptTemplateArtifactPath),
                output_template: handoff(paths.outputTemplateArtifactPath),
                evidence_manifest: handoff(paths.evidenceManifestArtifactPath)
            } };
            const bind = () => resolveReviewerHandoffArtifactBindings({ repoRoot: tempRoot, contextPath: outputPath,
                reviewContext, gateName: 'prepare-reviewer-launch' });
            bind();
            const sidecar = result.externalizedValueFiles[0].path;
            const original = fs.readFileSync(sidecar, 'utf8');
            fs.writeFileSync(sidecar, original.replace('case_0_', 'case_X_'));
            assert.throws(bind, /evidence manifest value file is stale/u);
            fs.rmSync(sidecar);
            assert.throws(bind, /evidence manifest value file is missing/u);
            fs.writeFileSync(sidecar, original);
            bind();
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });
});
