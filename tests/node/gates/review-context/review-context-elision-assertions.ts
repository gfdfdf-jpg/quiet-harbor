import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

const ELIDABLE_ENTRIES = ['full_suite_validation', 'trust_boundary_analysis'] as const;

function resolveJsonPointer(document: unknown, pointer: string): unknown {
    return pointer.split('/').slice(1).reduce<unknown>(
        (value, token) => (value as Record<string, unknown> | undefined)?.[token],
        document
    );
}

/**
 * Reads a written evidence manifest and the review context JSON it names, asserts that every entry in
 * expectElidedEntries has at least one elided field, that every elided reference resolves in the written review
 * context JSON with a matching value_sha256, and that the review context JSON itself keeps full values only.
 * Returns the elided field list.
 */
export function assertElidedReviewContextReferencesResolve(
    evidenceManifestPath: string,
    expectElidedEntries: ReadonlyArray<typeof ELIDABLE_ENTRIES[number]>
): string[] {
    const manifest = JSON.parse(fs.readFileSync(evidenceManifestPath, 'utf8'));
    const reviewContextJson = JSON.parse(fs.readFileSync(manifest.artifacts.review_context.artifact_path, 'utf8'));
    const fields: string[] = manifest.elided_review_context_copies?.fields ?? [];
    for (const entryKey of expectElidedEntries) {
        assert.ok(fields.some((field) => field.startsWith(`artifacts.${entryKey}.`)),
            `expected at least one elided field of ${entryKey}; elided: ${JSON.stringify(fields)}`);
    }
    for (const entryKey of ELIDABLE_ENTRIES) {
        assert.equal(JSON.stringify(reviewContextJson[entryKey] ?? null).includes('elided_copy_of_review_context_value'), false,
            `review context JSON must keep the full ${entryKey}`);
    }
    for (const field of fields) {
        const [, entryKey, fieldKey] = field.split('.');
        const reference = manifest.artifacts[entryKey][fieldKey];
        assert.equal(reference.elided_copy_of_review_context_value, true, field);
        assert.equal(reference.review_context_json_pointer, `/${entryKey}/${fieldKey}`, field);
        const value = resolveJsonPointer(reviewContextJson, reference.review_context_json_pointer);
        assert.notEqual(value, undefined, field);
        assert.equal(crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'), reference.value_sha256, field);
    }
    return fields;
}
