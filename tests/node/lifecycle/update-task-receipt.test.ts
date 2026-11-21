import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
    getUpdateReceiptWorkspaceIdentity, publishAuthenticatedUpdateTaskReceipt, readAuthenticatedUpdateTaskReceipt
} from '../../../src/core/auth/update-task-receipt';
import {
    assertUpdateTaskReceipt, UPDATE_TASK_RECEIPT_DOMAIN, updateReceiptDigest, type UpdateTaskReceiptBody
} from '../../../src/core/update-task-receipt';
import {
    attestVerifiedTaskUpdate, captureVerifiedTaskUpdate, publishVerifiedTaskUpdate, withTaskUpdateVerification
} from '../../../src/lifecycle/update/update-task-receipt';
import { createTempRepo, initializeGitRepo, runEnterTaskMode, runGit, seedInitAnswers, seedTaskQueue, writeBalancedProfilesConfig } from '../cli/commands/gate-test-helpers';
import type { AcquiredUpdateSource } from '../../../src/lifecycle/check-update/check-update-types';
import { acquireUpdateSource } from '../../../src/lifecycle/check-update/check-update-source';
import type { UpdatePipelineStageResult } from '../../../src/lifecycle/update/update-execution';
import { runUpdate } from '../../../src/lifecycle/update';
import { runContractMigrations } from '../../../src/lifecycle/contract-migrations';
import { formatVerifyResult, runVerify } from '../../../src/validators/verify';
import { formatManifestResult, validateManifest } from '../../../src/validators/validate-manifest';
import { findRepoRoot, setupTestWorkspace } from '../materialization/install-workspace-builder';
import { runCheckUpdate } from '../../../src/lifecycle/check-update';
import { writeProtectedControlPlaneManifest } from '../../../src/gates/shared/helpers';
import { type ReceiptRegistryFixture, type ReceiptRegistryOptions, withReceiptRegistry } from './update-task-receipt-fixtures';
import { readRuntimeMutationGeneration, RuntimeMutationGenerationError } from '../../../src/gate-runtime/runtime-mutation-generation';

const TASK_ID = 'T-RECEIPT';
const ENTRY_SHA = 'a'.repeat(64);
const mutableFilesystem = require('../../../src/core/filesystem') as {
    writeFileAtomically: typeof import('../../../src/core/filesystem').writeFileAtomically;
};

function fixture(run: (root: string, body: UpdateTaskReceiptBody, entry: string, seal: string) => void): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-task-update-auth-'));
    try {
        initializeGitRepo(root);
        const body: UpdateTaskReceiptBody = {
            schema_version: 1, domain: UPDATE_TASK_RECEIPT_DOMAIN,
            workspace_identity: getUpdateReceiptWorkspaceIdentity(root), transaction_id: randomUUID(),
            completed_at_utc: new Date().toISOString(),
            active_entries: [{ task_id: TASK_ID, task_mode_sha256: ENTRY_SHA,
                task_mode_path: 'garda-agent-orchestrator/runtime/reviews/T-RECEIPT-task-mode.json', status: 'IN_PROGRESS' }],
            protected_roots: ['garda-agent-orchestrator/dist/'],
            protected_before: { 'garda-agent-orchestrator/dist/cli.js': 'b'.repeat(64) },
            protected_after: { 'garda-agent-orchestrator/dist/cli.js': 'c'.repeat(64) },
            source_provenance: { source_type: 'npm', package_name: 'garda-agent-orchestrator',
                exact_package_spec: 'garda-agent-orchestrator@2.0.0', resolved_package_version: '2.0.0',
                resolved_package_integrity: 'sha512-YWJjZA==', package_payload_sha256: 'd'.repeat(64) }
        };
        const storage = path.join(root, '.git', 'garda-private', 'update-task-receipts');
        run(root, body, path.join(storage, 'entries', `${TASK_ID}-${ENTRY_SHA}.json`),
            path.join(storage, 'transactions', `${body.transaction_id}.json`));
    } finally {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        fs.rmSync(root, { recursive: true, force: true });
    }
}

describe('authenticated verified task update receipts', () => {
    it('round-trips the exact workspace, transaction, provenance, protected states and active entry', () => fixture((root, body) => {
        assert.equal(readAuthenticatedUpdateTaskReceipt(root, TASK_ID, ENTRY_SHA), null);
        publishAuthenticatedUpdateTaskReceipt(root, body);
        const receipt = readAuthenticatedUpdateTaskReceipt(root, TASK_ID, ENTRY_SHA)!;
        const { hmac_sha256, ...actual } = receipt;
        assert.deepEqual(actual, body);
        assert.match(hmac_sha256, /^[a-f0-9]{64}$/u);
        assert.equal(readAuthenticatedUpdateTaskReceipt(root, 'T-OTHER', ENTRY_SHA), null);
        assert.equal(readAuthenticatedUpdateTaskReceipt(root, TASK_ID, 'f'.repeat(64)), null);
    }));

    for (const field of ['protected_after', 'active_entries', 'source_provenance', 'workspace_identity'] as const) {
        it(`rejects a modified ${field} without treating it as trusted empty state`, () => fixture((root, body, entry) => {
            publishAuthenticatedUpdateTaskReceipt(root, body);
            const value = JSON.parse(fs.readFileSync(entry, 'utf8'));
            if (field === 'protected_after') value.protected_after['garda-agent-orchestrator/dist/cli.js'] = 'e'.repeat(64);
            else if (field === 'active_entries') value.active_entries[0].task_mode_sha256 = 'e'.repeat(64);
            else if (field === 'source_provenance') value.source_provenance.resolved_package_integrity = 'sha512-Zm9yZ2Vk';
            else value.workspace_identity = 'e'.repeat(64);
            fs.writeFileSync(entry, JSON.stringify(value) + '\n');
            assert.throws(() => readAuthenticatedUpdateTaskReceipt(root, TASK_ID, ENTRY_SHA), /authentication/iu);
        }));
    }

    it('does not activate partially published entries without the final transaction seal', () => fixture((root, body, _entry, seal) => {
        publishAuthenticatedUpdateTaskReceipt(root, body);
        fs.unlinkSync(seal);
        assert.equal(readAuthenticatedUpdateTaskReceipt(root, TASK_ID, ENTRY_SHA), null);
    }));

    it('keeps the first entry inert when a later entry publication fails', () => fixture((root, body, entry, seal) => {
        const second = { ...body.active_entries[0], task_id: 'T-SECOND', task_mode_sha256: 'e'.repeat(64) };
        body.active_entries.push(second);
        fs.mkdirSync(path.dirname(entry), { recursive: true });
        const secondPath = path.join(path.dirname(entry), `${second.task_id}-${second.task_mode_sha256}.json`);
        fs.writeFileSync(secondPath, 'untrusted\n');
        fs.linkSync(secondPath, path.join(root, 'linked-second-entry.json'));
        assert.throws(() => publishAuthenticatedUpdateTaskReceipt(root, body), /hard-linked/u);
        assert.equal(fs.existsSync(entry), true);
        assert.equal(fs.existsSync(seal), false);
        assert.equal(readAuthenticatedUpdateTaskReceipt(root, TASK_ID, ENTRY_SHA), null);
    }));

    it('rejects a forged transaction seal and a receipt with no private key', () => fixture((root, body, _entry, seal) => {
        publishAuthenticatedUpdateTaskReceipt(root, body);
        const value = JSON.parse(fs.readFileSync(seal, 'utf8'));
        value.receipt_sha256 = '0'.repeat(64);
        fs.writeFileSync(seal, JSON.stringify(value));
        assert.throws(() => readAuthenticatedUpdateTaskReceipt(root, TASK_ID, ENTRY_SHA), /not committed/u);
        fs.unlinkSync(path.join(root, '.git/garda-private/update-task-receipts/key'));
        assert.throws(() => readAuthenticatedUpdateTaskReceipt(root, TASK_ID, ENTRY_SHA), /authentication/u);
    }));

    it('rejects copied receipts and keys in another physical worktree', () => fixture((root, body) => {
        publishAuthenticatedUpdateTaskReceipt(root, body);
        const other = path.join(root, 'other-worktree');
        fs.mkdirSync(other);
        fs.cpSync(path.join(root, '.git'), path.join(other, '.git'), { recursive: true });
        assert.notEqual(getUpdateReceiptWorkspaceIdentity(other), body.workspace_identity);
        assert.throws(() => readAuthenticatedUpdateTaskReceipt(other, TASK_ID, ENTRY_SHA), /authentication/u);
    }));

    it('rejects a hard-linked receipt without reading it as authority', () => fixture((root, body, entry) => {
        publishAuthenticatedUpdateTaskReceipt(root, body);
        fs.linkSync(entry, path.join(root, 'linked-receipt.json'));
        assert.throws(() => readAuthenticatedUpdateTaskReceipt(root, TASK_ID, ENTRY_SHA), /[Uu]nsafe transaction/);
    }));

    it('rejects malformed, unknown and escaping entry identities', () => fixture((root, body, entry) => {
        publishAuthenticatedUpdateTaskReceipt(root, body);
        assert.throws(() => readAuthenticatedUpdateTaskReceipt(root, '../T-RECEIPT', ENTRY_SHA), /entry identity/u);
        const value = JSON.parse(fs.readFileSync(entry, 'utf8'));
        for (const mutation of [
            { schema_version: 2 }, { protected_before: null }, { active_entries: [] },
            { transaction_id: '../../../forged' }, { protected_after: { '../outside': 'a'.repeat(64) } }
        ]) assert.throws(() => assertUpdateTaskReceipt({ ...value, ...mutation }), /contract/u);
        fs.writeFileSync(entry, '{');
        assert.throws(() => readAuthenticatedUpdateTaskReceipt(root, TASK_ID, ENTRY_SHA), SyntaxError);
    }));

    it('does not turn unverified trust metadata, dry runners or forged captures into publication authority', () => fixture((root) => {
        const source = { sourceType: 'path', trustPolicy: 'overridden', trustOverrideUsed: true } as AcquiredUpdateSource;
        assert.equal(captureVerifiedTaskUpdate({ root, bundle: path.join(root, 'bundle'), source }), null);
        const forgedRegistry = { sourceType: 'npm', trustPolicy: 'enforced', trustOverrideUsed: false,
            packageName: 'garda-agent-orchestrator', sourceRoot: root, exactPackageSpec: 'garda-agent-orchestrator@2.0.0',
            resolvedPackageVersion: '2.0.0', resolvedPackageIntegrity: 'sha512-YWJjZA==',
            releaseProvenanceStatus: 'NPM_REGISTRY_INTEGRITY_RECORDED' } as AcquiredUpdateSource;
        assert.equal(captureVerifiedTaskUpdate({ root, bundle: path.join(root, 'bundle'), source: forgedRegistry }), null);
        assert.equal(readAuthenticatedUpdateTaskReceipt(root, TASK_ID, ENTRY_SHA), null);
        assert.throws(() => withTaskUpdateVerification({} as never, () => undefined), /Unrecognized/u);
        assert.doesNotThrow(() => attestVerifiedTaskUpdate(root, root, {} as never));
        assert.equal(readAuthenticatedUpdateTaskReceipt(root, TASK_ID, ENTRY_SHA), null);
    }));
});

async function lifecycleFixture(run: (root: string, bundle: string, source: AcquiredUpdateSource,
    entryHash: string, registry: ReceiptRegistryFixture) => void | Promise<void>,
    sourceCheckout = false, nativePipeline = false, versionBeforeEntry?: string,
    registryOptions: ReceiptRegistryOptions = {}): Promise<void> {
    const realBundle = sourceCheckout || nativePipeline;
    const sourceRepo = realBundle ? findRepoRoot() : null;
    const root = sourceRepo ? setupTestWorkspace(sourceRepo).projectRoot : createTempRepo();
    try {
        const bundle = path.join(root, 'garda-agent-orchestrator');
        const copyPackage = (destination: string) => {
            const files = JSON.parse(fs.readFileSync(path.join(sourceRepo!, 'package.json'), 'utf8')).files as string[];
            for (const file of files) {
                const from = path.join(sourceRepo!, file);
                if (!fs.existsSync(from)) continue;
                fs.mkdirSync(path.dirname(path.join(destination, file)), { recursive: true });
                fs.cpSync(from, path.join(destination, file), { recursive: true });
            }
        };
        if (realBundle) {
            copyPackage(bundle);
            fs.rmSync(path.join(root, '.git'), { recursive: true, force: true });
            fs.mkdirSync(path.join(root, 'src'));
            fs.writeFileSync(path.join(root, 'src/app.ts'), 'export const app = 1;\n');
            fs.writeFileSync(path.join(root, '.gitignore'), '/garda-agent-orchestrator/\n/acquired/\n');
            fs.mkdirSync(path.join(bundle, 'live/config'), { recursive: true });
            fs.writeFileSync(path.join(bundle, 'live/config/workflow-config.json'), JSON.stringify({
                compile_gate: { command: 'node --check src/app.ts' }
            }));
        }
        seedTaskQueue(root, TASK_ID, 'TODO', 'balanced');
        seedInitAnswers(root, 'Codex');
        writeBalancedProfilesConfig(root);
        if (sourceCheckout) fs.writeFileSync(path.join(root, 'package.json'),
            JSON.stringify({ name: 'garda-agent-orchestrator', version: '2.0.0' }) + '\n');
        initializeGitRepo(root);
        if (realBundle) {
            const initial = runUpdate(verifiedUpdateOptions(root, bundle));
            assert.equal(initial.verifyStatus, 'PASS');
            seedTaskQueue(root, TASK_ID, 'TODO', 'balanced');
            fs.writeFileSync(path.join(root, 'TASK.md'), '# TASK.md\n\n## Active Queue\n\n'
                + fs.readFileSync(path.join(root, 'TASK.md'), 'utf8'));
            runGit(root, ['add', '.']);
            if (runGit(root, ['status', '--porcelain']).stdout.trim())
                runGit(root, ['-c', 'core.hooksPath=', 'commit', '-m', 'test: verified update fixture']);
        }
        if (versionBeforeEntry) {
            fs.writeFileSync(path.join(bundle, 'VERSION'), `${versionBeforeEntry}\n`);
            writeProtectedControlPlaneManifest(root);
        }
        const entered = runEnterTaskMode({ taskId: TASK_ID, entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: '2',
            taskSummary: 'Update the app', plannedChangedFiles: ['src/app.ts'], repoRoot: root,
            ...(sourceCheckout ? { orchestratorWork: true, operatorConfirmed: 'yes',
                operatorConfirmedAtUtc: new Date().toISOString() } : {}) });
        assert.equal(entered.exitCode, 0);
        const mode = fs.readFileSync(path.join(bundle, 'runtime/reviews', `${TASK_ID}-task-mode.json`));
        const sourceRoot = path.join(root, 'acquired');
        if (realBundle) copyPackage(sourceRoot);
        fs.mkdirSync(path.join(sourceRoot, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(sourceRoot, 'dist', 'fixture.js'), 'module.exports = 2;\n');
        if (!realBundle) fs.writeFileSync(path.join(sourceRoot, 'package.json'), JSON.stringify({
            name: 'garda-agent-orchestrator', version: '2.0.0', files: ['dist']
        }));
        await withReceiptRegistry(sourceRoot, async registry => {
            const source = await acquireUpdateSource({ deployedBundleRoot: bundle, packageSpec: registry.packageSpec });
            try { await run(root, bundle, source, updateReceiptDigest(mode), registry); } finally { source.cleanup(); }
        }, registryOptions);
    } finally {
        const ownedRelative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(root));
        assert.ok(ownedRelative && !path.isAbsolute(ownedRelative)
            && !ownedRelative.split(path.sep).includes('..'), 'The owned fixture must stay inside the temporary directory.');
        fs.rmSync(root, { recursive: true, force: true });
    }
}

function verifiedUpdateOptions(root: string, bundle: string): Parameters<typeof runUpdate>[0] {
    return { targetRoot: root, bundleRoot: bundle, contractMigrationRunner: runContractMigrations,
        verifyRunner(options) {
            const result = runVerify(options);
            if (!result.passed) throw new Error(formatVerifyResult(result));
            return result;
        },
        manifestRunner(options) {
            const result = validateManifest(path.join(bundle, 'MANIFEST.md'), options.targetRoot);
            if (!result.passed) throw new Error(formatManifestResult(result));
            return result;
        } };
}

function verifiedCheckUpdateOptions(root: string, bundle: string): Parameters<typeof runCheckUpdate>[0] {
    return {
        targetRoot: root, bundleRoot: bundle, apply: true, noPrompt: true,
        initAnswersPath: path.join(bundle, 'runtime/init-answers.json'),
        packageSpec: 'garda-agent-orchestrator@latest',
        updateRunner(options) {
            const update = runUpdate({ ...verifiedUpdateOptions(root, bundle),
                lifecycleLockAlreadyHeld: options.lifecycleLockAlreadyHeld,
                trustContext: {
                    policy: options.trustPolicy, overrideUsed: options.trustOverrideUsed,
                    overrideSource: options.trustOverrideSource, sourceType: options.sourceType,
                    sourceReference: options.sourceReference, exactPackageSpec: options.exactPackageSpec,
                    requestedPackageSpec: options.requestedPackageSpec,
                    resolvedPackageVersion: options.resolvedPackageVersion,
                    resolvedPackageIntegrity: options.resolvedPackageIntegrity,
                    releaseProvenanceStatus: options.releaseProvenanceStatus
                }
            });
            assert.equal(update.verifyStatus, 'PASS');
            assert.equal(update.manifestValidationStatus, 'PASS');
        }
    };
}

function runVerifiedFixtureUpdate(root: string, bundle: string, capture: Parameters<typeof withTaskUpdateVerification>[0]): void {
    fs.copyFileSync(path.join(root, 'acquired/dist/fixture.js'), path.join(bundle, 'dist/fixture.js'));
    const result = withTaskUpdateVerification(capture, () => runUpdate(verifiedUpdateOptions(root, bundle)));
    assert.equal(result.verifyStatus, 'PASS');
    assert.equal(result.manifestValidationStatus, 'PASS');
}

const VERIFIED_STAGES = { installStatus: 'PASS', materializationStatus: 'PASS', verifyStatus: 'PASS',
    manifestStatus: 'PASS', invariantStatus: 'PASS' } as UpdatePipelineStageResult;

describe('current-entry update receipt capture', () => {
    it('refuses receipt authority when registry integrity changes between view and install', () => lifecycleFixture(
        (root, bundle, source, hash, registry) => {
            assert.notEqual(source.resolvedPackageIntegrity, registry.integrity);
            assert.equal(captureVerifiedTaskUpdate({ root, bundle, source }), null,
                'The installed tarball integrity must match the integrity signed in a task receipt.');
            assert.equal(readAuthenticatedUpdateTaskReceipt(root, TASK_ID, hash), null);
        }, false, false, undefined, { initialMetadataIntegrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` }));

    it('rejects receipt authority from injected npm acquisition callbacks', () => lifecycleFixture(async (root, bundle, source, hash) => {
        const forgedAcquisition = await acquireUpdateSource({ deployedBundleRoot: bundle,
            packageSpec: 'garda-agent-orchestrator@2.0.0',
            npmViewRunner: () => ({ status: 0, stdout: JSON.stringify({ version: '2.0.0',
                'dist.integrity': 'sha512-YWJjZA==' }) }),
            npmInstallRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
            installedPackageRootResolver: () => ({ packageName: 'garda-agent-orchestrator', packageRoot: source.sourceRoot }) });
        try {
            assert.equal(captureVerifiedTaskUpdate({ root, bundle, source: forgedAcquisition }), null,
                'Injected acquisition results must not confer verified npm receipt authority.');
            assert.equal(readAuthenticatedUpdateTaskReceipt(root, TASK_ID, hash), null);
        } finally { forgedAcquisition.cleanup(); }
    }));

    it('refuses receipt authority when any single npm acquisition port is injected', () => lifecycleFixture(
        async (root, bundle, source, hash, registry) => {
            const ports = {
                npmViewRunner: () => ({ status: 0, stdout: JSON.stringify({ version: registry.version,
                    'dist.integrity': 'sha512-YWJjZA==' }) }),
                npmInstallRunner: async (args: string[]) => {
                    const prefix = args[args.indexOf('--prefix') + 1];
                    assert.ok(path.resolve(prefix).startsWith(path.resolve(bundle, 'runtime') + path.sep));
                    fs.cpSync(registry.packageRoot, path.join(prefix, 'node_modules/garda-agent-orchestrator'), { recursive: true });
                    return { exitCode: 0, stdout: '', stderr: '' };
                },
                installedPackageRootResolver: () => ({ packageName: 'garda-agent-orchestrator', packageRoot: source.sourceRoot })
            };
            for (const port of Object.keys(ports) as (keyof typeof ports)[]) {
                const acquired = await acquireUpdateSource({ deployedBundleRoot: bundle,
                    packageSpec: registry.packageSpec, [port]: ports[port] });
                try {
                    assert.equal(acquired.sourceType, 'npm');
                    assert.equal(acquired.exactPackageSpec, registry.packageSpec);
                    assert.equal(captureVerifiedTaskUpdate({ root, bundle, source: acquired }), null, port);
                    assert.equal(readAuthenticatedUpdateTaskReceipt(root, TASK_ID, hash), null);
                } finally { acquired.cleanup(); }
            }
        }));

    it('publishes a task-bound receipt after a verified acquired-package update', () => lifecycleFixture(
        async (root, bundle, _source, hash, registry) => {
            const modePath = path.join(bundle, 'runtime/reviews', `${TASK_ID}-task-mode.json`);
            const originalMode = fs.readFileSync(modePath);
            const receiptPath = path.join(root, '.git/garda-private/update-task-receipts/entries', `${TASK_ID}-${hash}.json`);
            const updateOptions = verifiedCheckUpdateOptions(root, bundle);
            const dryRun = await runCheckUpdate({ ...updateOptions, dryRun: true,
                updateRunner() { assert.fail('Dry-run must not invoke the update pipeline.'); } });
            assert.equal(dryRun.checkUpdateResult, 'DRY_RUN_UPDATE_AVAILABLE');
            assert.equal(fs.existsSync(receiptPath), false, 'Dry-run must not publish task authority.');
            await assert.rejects(() => runCheckUpdate({ ...updateOptions,
                updateRunner() { assert.fail('A partial synchronization must not invoke the update pipeline.'); },
                _testHooks: { syncItemFaultInjector() { throw new Error('receipt-partial-update-test'); } }
            }), /receipt-partial-update-test/u);
            assert.equal(fs.existsSync(receiptPath), false, 'A failed and rolled-back update must not publish task authority.');
            assert.deepEqual(fs.readFileSync(modePath), originalMode);
            const result = await runCheckUpdate(updateOptions);
            assert.equal(result.updateApplied, true);
            assert.equal(result.releaseProvenanceStatus, 'NPM_REGISTRY_INTEGRITY_RECORDED');
            assert.ok(fs.existsSync(receiptPath),
                'A fully verified acquired-package update must publish its authenticated active-entry receipt.');
            const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
            assert.equal(receipt.schema_version, 1);
            assert.equal(receipt.active_entries.find((entry: { task_id: string }) => entry.task_id === TASK_ID)
                .task_mode_sha256, hash);
            assert.equal(receipt.source_provenance.exact_package_spec, result.exactPackageSpec);
            assert.equal(receipt.source_provenance.resolved_package_integrity, registry.integrity);
            assert.match(receipt.hmac_sha256, /^[a-f0-9]{64}$/u);
            assert.deepEqual(readAuthenticatedUpdateTaskReceipt(root, TASK_ID, hash), receipt);
            assert.deepEqual(fs.readFileSync(modePath), originalMode,
                'Receipt publication must not replace the active entry or rebind its frozen baseline.');
        }, false, true, '0.0.1'));

    it('does not publish when outer mutation settlement fails', () => lifecycleFixture(
        async (root, bundle, _source, hash) => {
            const originalWrite = mutableFilesystem.writeFileAtomically;
            const journalRoot = path.join(bundle, 'runtime/.runtime-mutation-generation');
            let settlementFailures = 0;
            try {
                await assert.rejects(() => runCheckUpdate({ ...verifiedCheckUpdateOptions(root, bundle),
                    _testHooks: { afterDeferredVersionSync() {
                        mutableFilesystem.writeFileAtomically = (filePath, content, options) => {
                            if (path.dirname(path.resolve(filePath)) === journalRoot
                                && /^state-[ab]\.json$/u.test(path.basename(filePath))) {
                                const record = JSON.parse(content.toString()) as {
                                    transition?: { type: string; mutation_kind: string };
                                };
                                if (record.transition?.type === 'COMMIT'
                                    && record.transition.mutation_kind === 'lifecycle-bundle-update-apply') {
                                    settlementFailures++;
                                    throw new Error('injected receipt settlement failure');
                                }
                            }
                            return originalWrite(filePath, content, options);
                        };
                    } }
                }), /generation settlement failed after one recovery retry/u);
            } finally {
                mutableFilesystem.writeFileAtomically = originalWrite;
            }
            assert.equal(settlementFailures, 2, 'Both outer settlement attempts must fail after real verification.');
            assert.throws(() => readRuntimeMutationGeneration(bundle),
                (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'BUSY');
            assert.equal(readAuthenticatedUpdateTaskReceipt(root, TASK_ID, hash), null,
                'An update that failed mutation settlement must not leave usable receipt authority.');
        }, false, true, '0.0.1'));

    it('rejects caller-created PASS stages inside a genuine capture', () => lifecycleFixture((root, bundle, source, hash) => {
        const capture = captureVerifiedTaskUpdate({ root, bundle, source });
        assert.ok(capture);
        fs.mkdirSync(path.join(bundle, 'dist'), { recursive: true });
        fs.copyFileSync(path.join(source.sourceRoot, 'dist/fixture.js'), path.join(bundle, 'dist/fixture.js'));
        assert.throws(() => withTaskUpdateVerification(capture,
            () => attestVerifiedTaskUpdate(root, bundle, VERIFIED_STAGES)), /native pipeline/u);
        publishVerifiedTaskUpdate(capture);
        assert.equal(readAuthenticatedUpdateTaskReceipt(root, TASK_ID, hash), null);
    }));

    it('rejects acquired package changed before capture', () => lifecycleFixture((root, bundle, source, hash) => {
        fs.appendFileSync(path.join(source.sourceRoot, 'dist/fixture.js'), '// replacement before capture\n');
        assert.throws(() => captureVerifiedTaskUpdate({ root, bundle, source }), /acquired.*payload.*changed/iu);
        assert.equal(readAuthenticatedUpdateTaskReceipt(root, TASK_ID, hash), null);
    }));

    it('rejects mutation of an opaque capture instead of trusting its verified flag', () => lifecycleFixture((root, bundle, source, hash) => {
        const capture = captureVerifiedTaskUpdate({ root, bundle, source });
        assert.ok(capture);
        assert.throws(() => Object.assign(capture, { verified: true }), TypeError);
        publishVerifiedTaskUpdate(capture);
        assert.equal(readAuthenticatedUpdateTaskReceipt(root, TASK_ID, hash), null);
    }));

    it('publishes an authenticated receipt for a native source-checkout entry', () => lifecycleFixture((root, bundle, source, hash) => {
        const capture = captureVerifiedTaskUpdate({ root, bundle, source });
        assert.ok(capture);
        runVerifiedFixtureUpdate(root, bundle, capture);
        publishVerifiedTaskUpdate(capture);
        const receipt = readAuthenticatedUpdateTaskReceipt(root, TASK_ID, hash)!;
        assert.ok(receipt);
        assert.ok(receipt.protected_roots.includes('src/gates/'));
        assert.equal(receipt.active_entries[0].task_mode_sha256, hash);
    }, true));

    it('does not publish without native verification and cannot reuse a finished capture', () => lifecycleFixture((root, bundle, source, hash) => {
        const capture = captureVerifiedTaskUpdate({ root, bundle, source });
        assert.ok(capture);
        publishVerifiedTaskUpdate(capture);
        assert.equal(readAuthenticatedUpdateTaskReceipt(root, TASK_ID, hash), null);
        assert.throws(() => publishVerifiedTaskUpdate(capture), /Unrecognized/u);
    }));

    it('rejects changed owners before publication', () => lifecycleFixture((root, bundle, source, hash) => {
        const capture = captureVerifiedTaskUpdate({ root, bundle, source });
        assert.ok(capture);
        runVerifiedFixtureUpdate(root, bundle, capture);
        const modePath = path.join(bundle, 'runtime/reviews', `${TASK_ID}-task-mode.json`);
        fs.appendFileSync(modePath, '\n');
        assert.throws(() => publishVerifiedTaskUpdate(capture), /active entry|owners/iu);
        assert.equal(readAuthenticatedUpdateTaskReceipt(root, TASK_ID, hash), null);
    }, false, true));

    it('rejects an acquired package or installed payload changed after capture', () => lifecycleFixture((root, bundle, source, hash) => {
        const capture = captureVerifiedTaskUpdate({ root, bundle, source });
        assert.ok(capture);
        runVerifiedFixtureUpdate(root, bundle, capture);
        fs.appendFileSync(path.join(source.sourceRoot, 'dist/fixture.js'), '// foreign\n');
        assert.throws(() => publishVerifiedTaskUpdate(capture), /acquired package changed/u);
        fs.writeFileSync(path.join(source.sourceRoot, 'dist/fixture.js'), 'module.exports = 2;\n');
        fs.mkdirSync(path.join(bundle, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(bundle, 'dist/fixture.js'), 'module.exports = "tampered";\n');
        assert.throws(() => publishVerifiedTaskUpdate(capture), /Installed update payload differs/u);
        assert.equal(readAuthenticatedUpdateTaskReceipt(root, TASK_ID, hash), null);
    }, false, true));

    it('rejects skipped verification stages and another workspace pipeline', () => lifecycleFixture((root, bundle, source, hash) => {
        const capture = captureVerifiedTaskUpdate({ root, bundle, source });
        assert.ok(capture);
        for (const stage of ['verifyStatus', 'manifestStatus', 'invariantStatus'] as const) {
            assert.throws(() => withTaskUpdateVerification(capture,
                () => attestVerifiedTaskUpdate(root, bundle, { ...VERIFIED_STAGES, [stage]: 'SKIPPED' })), /cannot attest/u);
        }
        assert.throws(() => withTaskUpdateVerification(capture,
            () => attestVerifiedTaskUpdate(path.join(root, 'other'), bundle, VERIFIED_STAGES)), /cannot attest/u);
        publishVerifiedTaskUpdate(capture);
        assert.equal(readAuthenticatedUpdateTaskReceipt(root, TASK_ID, hash), null);
    }));

    it('rejects protected state changed after native verification', () => lifecycleFixture((root, bundle, source, hash) => {
        const capture = captureVerifiedTaskUpdate({ root, bundle, source });
        assert.ok(capture);
        runVerifiedFixtureUpdate(root, bundle, capture);
        fs.appendFileSync(path.join(root, 'AGENTS.md'), '\nForeign edit after verification.\n');
        assert.throws(() => publishVerifiedTaskUpdate(capture), /changed after native verification/u);
        assert.equal(readAuthenticatedUpdateTaskReceipt(root, TASK_ID, hash), null);
    }, false, true));
});
