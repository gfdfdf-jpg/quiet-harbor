import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha256RedactedJsonPayload } from '../../../../src/core/redaction';
import { isSafeOrdinaryDocumentationPath } from '../../../../src/gates/preflight/classify-change-doc-safety';
import { classifyReviewRemediationDelta } from '../../../../src/gates/review-remediation/review-remediation-delta';
import { createTempRepo } from '../../cli/commands/gate-test-helpers';
import { buildLeafTestDeltaClassification } from '../next-step/next-step-benchmark-remediation-fixture';
import { makeConfig } from '../preflight/classify-change-test-support';

test('MDX pages remain in remediation scope while ordinary documentation stays out', () => {
    const repoRoot = createTempRepo();
    try {
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const preflightPath = path.join(reviewsRoot, 'T-MDX-preflight.json');
        fs.writeFileSync(preflightPath, '{}\n');
        const config = makeConfig({ ordinary_doc_paths: ['pages/**', 'components/**', 'docs/**', 'doc/**', 'documentation/**'] });
        const isOrdinaryDocument = (file: string): boolean => isSafeOrdinaryDocumentationPath(file, config);

        for (const [index, file] of ['pages/blog.mdx', 'components/Intro.mdx', 'pages/security.mdx',
            'src/docs/guide.mdx', 'docs/guide.mdx', 'doc/guide.mdx', 'documentation/guide.mdx'].entries()) {
            const taskId = `T-MDX-${index}`;
            const baseline = buildLeafTestDeltaClassification({ repoRoot, taskId, reviewType: 'code', changedFile: file,
                preflightPath, preflightSha256: sha256RedactedJsonPayload({}), profilePolicySnapshot: {} });
            const delta = classifyReviewRemediationDelta({ repoRoot, taskId, reviewType: 'code',
                baselineArtifactPath: baseline.baseline.artifact_path, baselineArtifactSha256: baseline.baseline.artifact_sha256,
                currentChangedFiles: [file], isOrdinaryDocument });
            const ordinaryDoc = file === 'docs/guide.mdx' || file === 'doc/guide.mdx' || file === 'documentation/guide.mdx';
            assert.equal(delta.documents_only, ordinaryDoc, file);
            assert.deepEqual(delta.changed_files, [file], file);
            if (ordinaryDoc) {
                assert.equal(delta.full_review_required, true, file);
                assert.equal(delta.file_deltas[0].reason, 'path is a document', file);
            } else {
                assert.equal(delta.file_deltas[0].category, 'global', file);
            }
        }

        const taskId = 'T-MDX-MIXED';
        const baseline = buildLeafTestDeltaClassification({ repoRoot, taskId, reviewType: 'code', changedFile: 'src/index.ts',
            preflightPath, preflightSha256: sha256RedactedJsonPayload({}), profilePolicySnapshot: {} });
        const delta = classifyReviewRemediationDelta({ repoRoot, taskId, reviewType: 'code',
            baselineArtifactPath: baseline.baseline.artifact_path, baselineArtifactSha256: baseline.baseline.artifact_sha256,
            currentChangedFiles: ['src/index.ts', 'pages/blog.mdx', 'docs/guide.mdx'], isOrdinaryDocument });
        assert.equal(delta.documents_only, false);
        assert.deepEqual(delta.changed_files, ['pages/blog.mdx', 'src/index.ts']);
        assert.equal(delta.scope.membership_unchanged, false);
        assert.equal(delta.full_review_required, true);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
