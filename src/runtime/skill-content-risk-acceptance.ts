import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertContainedDestination, bindContainedDestination, ensureContainedDirectory,
    removeContainedPath, writeContainedFile } from '../core/contained-filesystem';
import { lstatFileIdentitySync } from '../core/file-stat';
import { isPlainRecord } from '../core/records';
import { readBoundedSkillInput, readSkillContentInputs } from './skill-content-inputs';
import { scanSkillContent } from './skill-content-scan';
import { HIDDEN_SKILL_CHARACTERS } from './skill-content-scan-patterns';

interface Roots { repoRoot: string; bundleRoot: string }
export interface SkillRiskSubject { review_id: string; skill_id: string }
export interface SkillRiskBinding extends SkillRiskSubject {
    content_sha256: string;
    finding_ids: string[];
    accepted_finding_ids: string[];
}
const STATE_PATH = 'runtime/skill-content-risk-state.json';
const KEY_PATH = 'runtime/skill-content-risk-key';
const AUDIT_PATH = 'runtime/review-catalog-management-audit.jsonl';
const STATE_BYTES = 128 * 1024;
const AUDIT_BYTES = 8 * 1024 * 1024;
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

export function captureSkillRiskBinding(roots: Roots, subject: SkillRiskSubject): SkillRiskBinding {
    try {
        if (![subject.review_id, subject.skill_id].every(id => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(id))) {
            throw new Error('Skill risk subjects require stable lane and skill IDs.');
        }
        const skillRoot = path.join(roots.bundleRoot, 'live', 'skills', subject.skill_id);
        const identity = bindContainedDestination(roots.bundleRoot, skillRoot);
        const inputs = readSkillContentInputs(skillRoot);
        assertContainedDestination(identity);
        const findingIds = [...new Set(scanSkillContent(inputs.files)
            .filter(finding => finding.severity === 'HIGH').map(finding => finding.rule_id))].sort();
        return { ...subject, content_sha256: inputs.content_sha256, finding_ids: findingIds, accepted_finding_ids: [] };
    } catch (error) {
        const message = Array.from(error instanceof Error ? error.message : String(error)).map(character =>
            HIDDEN_SKILL_CHARACTERS.test(character) || /\p{Cc}/u.test(character)
                ? '\\u{' + character.codePointAt(0)!.toString(16) + '}' : character).join('');
        throw new Error(`Skill risk input refused: ${message}`);
    }
}

function readText(roots: Roots, relative: string, maximum: number): string | null {
    const filePath = path.join(roots.bundleRoot, relative);
    try { fs.lstatSync(filePath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    return readBoundedSkillInput(filePath, roots.bundleRoot, maximum, 'Skill risk authority').bytes.toString('utf8');
}

function workspaceIdentity(roots: Roots): string {
    return digest([roots.repoRoot, roots.bundleRoot].map(directory => {
        const binding = bindContainedDestination(directory, directory);
        const stat = lstatFileIdentitySync(directory, { bigint: true });
        if (!stat.isDirectory()) throw new Error('Skill risk authority requires ordinary workspace directories.');
        const realPath = fs.realpathSync.native(directory);
        assertContainedDestination(binding);
        return [process.platform === 'win32' ? realPath.toLowerCase() : realPath,
            String(stat.dev), String(stat.ino), String(stat.birthtimeNs)];
    }));
}

function readKey(roots: Roots, create = false): Buffer {
    let text = readText(roots, KEY_PATH, 128);
    if (text === null && create) {
        ensureContainedDirectory(roots.bundleRoot, path.join(roots.bundleRoot, 'runtime'));
        const keyPath = path.join(roots.bundleRoot, KEY_PATH);
        const identity = bindContainedDestination(roots.bundleRoot, keyPath);
        assertContainedDestination(identity);
        fs.writeFileSync(keyPath, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
        text = readText(roots, KEY_PATH, 128);
    }
    if (!text || !/^[a-f0-9]{64}\n$/u.test(text)) throw new Error('Skill risk authentication key is missing or malformed.');
    return Buffer.from(text.trim(), 'hex');
}

function signature(key: Buffer, domain: string, payload: unknown): string {
    return createHmac('sha256', key).update(`garda-skill-risk-v1:${domain}\n`).update(JSON.stringify(payload)).digest('hex');
}
function authenticated(key: Buffer, domain: string, value: Record<string, unknown>): boolean {
    const { skill_risk_mac: mac, ...payload } = value;
    return typeof mac === 'string' && /^[a-f0-9]{64}$/u.test(mac)
        && timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(signature(key, domain, payload), 'hex'));
}

export function signSkillRiskConfirmation(roots: Roots, payload: object) {
    const bound = { ...payload, workspace_sha256: workspaceIdentity(roots) };
    return { ...bound, skill_risk_mac: signature(readKey(roots, true), 'confirmation', bound) };
}

export function assertSkillRiskConfirmation(roots: Roots, payload: Record<string, unknown>): void {
    if (payload.workspace_sha256 !== workspaceIdentity(roots) || !authenticated(readKey(roots), 'confirmation', payload)) {
        throw new Error('Confirmation lacks authenticated native issuance; run a fresh operator-approved --confirm.');
    }
}

function readState(text: string | null, key: Buffer, workspace: string): Record<string, string> {
    if (text === null) return {};
    const state: unknown = JSON.parse(text);
    if (!isPlainRecord(state) || state.workspace_sha256 !== workspace || !authenticated(key, 'state', state)
        || !isPlainRecord(state.grants) || Object.entries(state.grants).some(([id, sha]) =>
            !/^[a-z][a-z0-9-]*$/u.test(id) || typeof sha !== 'string' || !/^[a-f0-9]{64}$/u.test(sha))) {
        throw new Error('Skill risk authority state is malformed, foreign or unauthenticated.');
    }
    return state.grants as Record<string, string>;
}

export function assertSkillRiskBindingsCurrent(roots: Roots, bindings: readonly SkillRiskBinding[]): void {
    for (const binding of bindings) {
        const current = captureSkillRiskBinding(roots, binding);
        if (current.content_sha256 !== binding.content_sha256 || !same(current.finding_ids, binding.finding_ids)) {
            throw new Error('Skill risk content changed after preview; obtain a new exact-content confirmation.');
        }
    }
}

export function prepareSkillRiskPublication(roots: Roots, bindings: readonly SkillRiskBinding[], audit: Record<string, unknown>) {
    assertSkillRiskBindingsCurrent(roots, bindings);
    const record = { ...audit, skill_content_bindings: bindings };
    if (!bindings.some(binding => binding.finding_ids.length) && readText(roots, KEY_PATH, 128) === null) {
        return { record, publish: () => undefined, rollback: () => undefined };
    }
    const key = readKey(roots, true);
    const workspace = workspaceIdentity(roots);
    const before = readText(roots, STATE_PATH, STATE_BYTES);
    const grants = { ...readState(before, key, workspace) };
    const payload = { ...record, workspace_sha256: workspace };
    const signed = { ...payload, skill_risk_mac: signature(key, 'audit', payload) };
    for (const binding of bindings) grants[binding.review_id] = digest(signed);
    const nextState = { workspace_sha256: workspace, grants };
    const after = JSON.stringify({ ...nextState, skill_risk_mac: signature(key, 'state', nextState) }) + '\n';
    if (Buffer.byteLength(after) > STATE_BYTES) throw new Error('Skill risk authority state exceeds its bound.');
    const statePath = path.join(roots.bundleRoot, STATE_PATH);
    let publishedIdentity: ReturnType<typeof bindContainedDestination> | undefined;
    return {
        record: signed,
        publish: () => {
            assertSkillRiskBindingsCurrent(roots, bindings);
            if (readText(roots, STATE_PATH, STATE_BYTES) !== before) throw new Error('Skill risk authority changed during publication.');
            writeContainedFile(roots.bundleRoot, statePath, after, () => {
                publishedIdentity = bindContainedDestination(roots.bundleRoot, statePath);
            });
            assertSkillRiskBindingsCurrent(roots, bindings);
        },
        rollback: () => {
            if (!publishedIdentity) return;
            assertContainedDestination(publishedIdentity);
            if (readText(roots, STATE_PATH, STATE_BYTES) !== after) throw new Error('Skill risk rollback preserved concurrent authority.');
            if (before === null) removeContainedPath(roots.bundleRoot, statePath);
            else writeContainedFile(roots.bundleRoot, statePath, before);
        }
    };
}

function currentAuditRecord(roots: Roots, reviewId: string): Record<string, unknown> | undefined {
    const text = readText(roots, AUDIT_PATH, AUDIT_BYTES);
    if (!text) return undefined;
    const records = text.trim().split('\n').map(line => JSON.parse(line) as unknown);
    const committed = new Map<string, Record<string, unknown>>();
    const rolledBack = new Set<string>();
    for (const record of records) {
        if (!isPlainRecord(record) || record.event_source !== 'review-catalog-management'
            || typeof record.transaction_id !== 'string') throw new Error('Malformed skill risk audit history.');
        if (record.transaction_state === 'ROLLED_BACK') rolledBack.add(record.transaction_id);
        if (record.transaction_state !== 'COMMITTED') continue;
        if (committed.has(record.transaction_id)) throw new Error('Replayed skill risk transaction.');
        committed.set(record.transaction_id, record);
    }
    return [...committed.entries()].filter(([id, record]) => !rolledBack.has(id)
        && (record.review_id === reviewId || Array.isArray(record.skill_content_bindings)
            && record.skill_content_bindings.some(binding => isPlainRecord(binding) && binding.review_id === reviewId)))
        .at(-1)?.[1];
}

export function hasCurrentSkillRiskAcceptance(input: Roots & {
    reviewId: string; skillId: string; contentSha256: string; findingIds: readonly string[];
}): boolean {
    try {
        const current = captureSkillRiskBinding(input, { review_id: input.reviewId, skill_id: input.skillId });
        if (current.content_sha256 !== input.contentSha256 || !same(current.finding_ids, input.findingIds)
            || !current.finding_ids.length) return false;
        const catalog = JSON.parse(readText(input, 'live/config/review-catalog.json', STATE_BYTES) ?? 'null') as unknown;
        if (!isPlainRecord(catalog) || !Array.isArray(catalog.custom_review_types)
            || !catalog.custom_review_types.some(lane => isPlainRecord(lane) && lane.id === input.reviewId
                && lane.skill_id === input.skillId)) return false;
        const key = readKey(input);
        const workspace = workspaceIdentity(input);
        const grants = readState(readText(input, STATE_PATH, STATE_BYTES), key, workspace);
        const record = currentAuditRecord(input, input.reviewId);
        if (!record || record.workspace_sha256 !== workspace || !authenticated(key, 'audit', record)
            || grants[input.reviewId] !== digest(record) || record.actor !== 'operator_command'
            || typeof record.confirmation_receipt_sha256 !== 'string'
            || !/^[a-f0-9]{64}$/u.test(record.confirmation_receipt_sha256)) return false;
        return Array.isArray(record.skill_content_bindings) && record.skill_content_bindings.some(binding =>
            isPlainRecord(binding) && same(binding, { ...current, accepted_finding_ids: current.finding_ids }));
    } catch {
        // Missing, corrupt or drifting local evidence never grants risk acceptance.
        return false;
    }
}
