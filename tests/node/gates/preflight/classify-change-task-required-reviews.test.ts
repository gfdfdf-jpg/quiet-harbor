import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    applyTaskRequiredReviewDeclaration,
    resolveTaskRequiredReviewDeclaration
} from '../../../../src/gates/preflight/classify-change-task-required-reviews';
import { getDefaultReviewCapabilities } from '../../../../src/core/review-capabilities';

describe('task required-review declaration', () => {
    it('unions legacy semicolon-delimited Reviews with Required reviews instead of overriding either', () => {
        const declaration = resolveTaskRequiredReviewDeclaration({
            taskId: 'T-006-3',
            notes: 'Depends on: T-006-2; Reviews: security, api; Lane: B:application. Required reviews: code, security, test.',
            reviewCapabilities: getDefaultReviewCapabilities()
        });
        assert.deepEqual(declaration?.applied_reviews, ['security', 'api', 'code', 'test']);
        const reversed = resolveTaskRequiredReviewDeclaration({
            taskId: 'T-006-3', notes: 'Required reviews: code, test.\nReviews: security, api.',
            reviewCapabilities: getDefaultReviewCapabilities()
        });
        assert.deepEqual(reversed?.applied_reviews, ['code', 'test', 'security', 'api']);
        assert.deepEqual(resolveTaskRequiredReviewDeclaration({
            taskId: 'T-compact', notes: 'Depends:T-1;Reviews:api;Lane:B',
            reviewCapabilities: getDefaultReviewCapabilities()
        })?.applied_reviews, ['api']);
    });

    it('cannot bypass disabled API review by narrowing or omitting the canonical marker', () => {
        for (const suffix of ['', ' Required reviews: code, security, test.']) {
            assert.throws(() => resolveTaskRequiredReviewDeclaration({
                taskId: 'T-006-3',
                notes: 'Depends on: T-006-2; Reviews: security, api; Lane: B:application.' + suffix,
                reviewCapabilities: { ...getDefaultReviewCapabilities(), api: false }
            }), /Do not remove or narrow task review requirements/u);
        }
    });

    it('fails closed for malformed, repeated or unknown legacy declarations', () => {
        for (const notes of ['Reviews: ; Lane: app.', 'Reviews: code, code.', 'Reviews: ux.',
            'Reviews: api. Reviews: code.', 'Required reviews: code. Required reviews: api.']) {
            assert.throws(() => resolveTaskRequiredReviewDeclaration({
                taskId: 'T-bad', notes, reviewCapabilities: getDefaultReviewCapabilities()
            }), /invalid TASK.md required-review declaration/u);
        }
        assert.equal(resolveTaskRequiredReviewDeclaration({
            taskId: 'T-prose', notes: 'The prior reviews were accepted. See reviews: in the documentation.',
            reviewCapabilities: getDefaultReviewCapabilities()
        }), null);
    });

    it('applies an exact task-owned review declaration', () => {
        const declaration = resolveTaskRequiredReviewDeclaration({
            taskId: 'T-979-33-3',
            notes: 'Scope: guarded UI flow. Required reviews: code, api, test. Parent guard preserved.',
            reviewCapabilities: getDefaultReviewCapabilities()
        });
        const requiredReviews = { code: false, api: false, test: false };

        applyTaskRequiredReviewDeclaration(requiredReviews, declaration);

        assert.deepEqual(declaration, {
            source: 'task_queue_notes',
            declared_reviews: ['code', 'api', 'test'],
            applied_reviews: ['code', 'api', 'test']
        });
        assert.deepEqual(requiredReviews, { code: true, api: true, test: true });
    });

    it('ignores incidental prose that is not an explicit declaration sentence', () => {
        assert.equal(resolveTaskRequiredReviewDeclaration({
            taskId: 'T-1',
            notes: 'No required reviews are declared for this documentation note.',
            reviewCapabilities: getDefaultReviewCapabilities()
        }), null);
    });

    it('fails closed with an exact reason for unknown, duplicate, and malformed lanes', () => {
        const capabilities = getDefaultReviewCapabilities();
        assert.throws(
            () => resolveTaskRequiredReviewDeclaration({
                taskId: 'T-unknown',
                notes: 'Required reviews: code, ux.',
                reviewCapabilities: capabilities
            }),
            /Task 'T-unknown' has invalid TASK\.md required-review declaration: unknown lane 'ux'\. Allowed lanes:/
        );
        assert.throws(
            () => resolveTaskRequiredReviewDeclaration({
                taskId: 'T-duplicate',
                notes: 'Required reviews: code, code.',
                reviewCapabilities: capabilities
            }),
            /lane 'code' is declared more than once/
        );
        assert.throws(
            () => resolveTaskRequiredReviewDeclaration({
                taskId: 'T-malformed',
                notes: 'Required reviews code, api.',
                reviewCapabilities: capabilities
            }),
            /expected the exact form "Required reviews: lane, lane\."/
        );
    });

    it('fails closed when a declared lane is unavailable', () => {
        assert.throws(
            () => resolveTaskRequiredReviewDeclaration({
                taskId: 'T-unavailable',
                notes: 'Required reviews: code, api.',
                reviewCapabilities: { ...getDefaultReviewCapabilities(), api: false }
            }),
            /review lane 'api' is unavailable because review-capabilities\.api is not enabled/
        );
    });
});
