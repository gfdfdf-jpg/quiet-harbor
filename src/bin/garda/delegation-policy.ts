import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    isPackageInstalledUnderNodeModules,
    isRecognizedPackageName,
    looksLikeDeployedBundleRoot,
    looksLikeSourceCheckout,
    readPackageMetadata,
    resolvePreferredCliPath
} from './root-discovery';

const GARDA_NO_DELEGATE_ENV = 'GARDA_NO_DELEGATE' as const;
const TRUE_TOKENS = new Set(['1', 'true', 'yes', 'y', 'on']);

export type DelegationRuntimeKind = 'source_checkout' | 'deployed_bundle' | 'packaged_npm' | 'unknown';
export type DelegationTrustLevel = 'trusted_self_hosted' | 'trusted_local_workspace' | 'packaged_runtime' | 'unknown';
export type DelegationDecision = 'not_required' | 'allowed' | 'blocked';
export type DelegationTargetReason =
    | 'target_root_source_checkout'
    | 'target_root_deployed_bundle'
    | 'cwd_source_checkout'
    | 'cwd_deployed_bundle';

export interface DelegatedRuntimeEvidence {
    cli_path: string;
    root: string;
    runtime_kind: Extract<DelegationRuntimeKind, 'source_checkout' | 'deployed_bundle'>;
    reason: DelegationTargetReason;
    package_name: string;
    package_version: string | null;
    path_containment: 'validated';
}

export interface CurrentRuntimeEvidence {
    package_root: string;
    runtime_kind: DelegationRuntimeKind;
    package_installed_under_node_modules: boolean;
    recognized_package_name: boolean;
    package_name: string | null;
    package_version: string | null;
}

export interface DelegationTrustDecision {
    decision: DelegationDecision;
    trust_level: DelegationTrustLevel;
    reason: string;
}

export interface DelegationTrustEvidence {
    current_runtime: CurrentRuntimeEvidence;
    delegated_runtime: DelegatedRuntimeEvidence | null;
    no_delegate_mode?: {
        active: boolean;
        source: 'env';
        env_var: typeof GARDA_NO_DELEGATE_ENV;
        reason: string;
    };
    implementation_delegation: DelegationTrustDecision;
    mandatory_review_delegation: DelegationTrustDecision & {
        requires_provider_launch_attestation: boolean;
    };
}

function isTruthyNoDelegateEnvValue(value: unknown): boolean {
    return TRUE_TOKENS.has(String(value ?? '').trim().toLowerCase());
}

function buildMandatoryReviewDelegation(
    decision: DelegationDecision,
    trustLevel: DelegationTrustLevel,
    reason: string
): DelegationTrustEvidence['mandatory_review_delegation'] {
    return {
        decision,
        trust_level: trustLevel,
        reason,
        requires_provider_launch_attestation: true
    };
}

export function buildDelegationTrustEvidence(
    currentRuntime: CurrentRuntimeEvidence,
    delegatedRuntime: DelegatedRuntimeEvidence | null
): DelegationTrustEvidence {
    const installedUnderNodeModules = currentRuntime.package_installed_under_node_modules;
    if (isTruthyNoDelegateEnvValue(process.env[GARDA_NO_DELEGATE_ENV])) {
        const noDelegateMode = {
            active: true,
            source: 'env' as const,
            env_var: GARDA_NO_DELEGATE_ENV as typeof GARDA_NO_DELEGATE_ENV,
            reason: `${GARDA_NO_DELEGATE_ENV} is active; workspace and mandatory-review delegation are disabled for this process.`
        };
        return {
            current_runtime: currentRuntime,
            delegated_runtime: delegatedRuntime,
            no_delegate_mode: noDelegateMode,
            implementation_delegation: {
                decision: 'blocked',
                trust_level: 'unknown',
                reason: noDelegateMode.reason
            },
            mandatory_review_delegation: buildMandatoryReviewDelegation(
                'blocked',
                'unknown',
                noDelegateMode.reason
            )
        };
    }

    if (!currentRuntime.recognized_package_name) {
        return {
            current_runtime: currentRuntime,
            delegated_runtime: null,
            implementation_delegation: {
                decision: installedUnderNodeModules ? 'blocked' : 'not_required',
                trust_level: 'unknown',
                reason: 'Current runtime package name is not recognized; it cannot be trusted as a Garda runtime.'
            },
            mandatory_review_delegation: buildMandatoryReviewDelegation(
                'blocked',
                'unknown',
                'Mandatory reviewer delegation cannot rely on an unrecognized current runtime identity.'
            )
        };
    }

    if (currentRuntime.runtime_kind === 'unknown') {
        return {
            current_runtime: currentRuntime,
            delegated_runtime: null,
            implementation_delegation: {
                decision: 'blocked',
                trust_level: 'unknown',
                reason: 'Current runtime kind is unknown; workspace delegation must fail closed.'
            },
            mandatory_review_delegation: buildMandatoryReviewDelegation(
                'blocked',
                'unknown',
                'Mandatory reviewer delegation cannot rely on an unknown current runtime kind.'
            )
        };
    }

    if (!installedUnderNodeModules && currentRuntime.runtime_kind === 'source_checkout') {
        return {
            current_runtime: currentRuntime,
            delegated_runtime: null,
            implementation_delegation: {
                decision: 'not_required',
                trust_level: 'trusted_self_hosted',
                reason: 'Current runtime is the self-hosted source checkout; implementation delegation to another workspace runtime is not required.'
            },
            mandatory_review_delegation: buildMandatoryReviewDelegation(
                'allowed',
                'trusted_self_hosted',
                'Self-hosted source checkout is trusted, but reviewer launch still requires provider-native delegated reviewer attestation.'
            )
        };
    }

    if (delegatedRuntime) {
        return {
            current_runtime: currentRuntime,
            delegated_runtime: delegatedRuntime,
            implementation_delegation: {
                decision: 'blocked',
                trust_level: 'unknown',
                reason: 'Discovered workspace runtime metadata does not authorize code execution. Invoke the known runtime CLI path explicitly.'
            },
            mandatory_review_delegation: buildMandatoryReviewDelegation(
                'allowed',
                'packaged_runtime',
                'Only the explicitly invoked current runtime is selected; discovered metadata supplies no reviewer attestation. Provider-native delegated reviewer attestation remains required.'
            )
        };
    }

    return {
        current_runtime: currentRuntime,
        delegated_runtime: null,
        implementation_delegation: {
            decision: 'not_required',
            trust_level: 'packaged_runtime',
            reason: installedUnderNodeModules
                ? 'The explicitly invoked installed runtime continues locally; cwd and target-root select data, not executable code.'
                : 'Current runtime is not installed under node_modules; launcher delegation is not required.'
        },
        mandatory_review_delegation: buildMandatoryReviewDelegation(
            'allowed',
            'packaged_runtime',
            installedUnderNodeModules
                ? 'The explicitly invoked installed runtime still requires provider-native delegated reviewer attestation.'
                : 'Packaged runtime may continue only with provider-native delegated reviewer attestation.'
        )
    };
}

function hasLauncherOwnershipEvidence(packageRoot: string, currentScriptPath: string): boolean {
    try {
        const expectedCliPath = resolvePreferredCliPath(path.resolve(packageRoot));
        if (!expectedCliPath) {
            return false;
        }
        return fs.realpathSync.native(expectedCliPath) === fs.realpathSync.native(currentScriptPath);
    } catch {
        return false;
    }
}

function resolveCurrentRuntimeKind(packageRoot: string, currentScriptPath: string): DelegationRuntimeKind {
    if (!hasLauncherOwnershipEvidence(packageRoot, currentScriptPath)) {
        return 'unknown';
    }
    if (isPackageInstalledUnderNodeModules(packageRoot)) {
        return 'packaged_npm';
    }
    if (looksLikeSourceCheckout(packageRoot)) {
        return 'source_checkout';
    }
    if (looksLikeDeployedBundleRoot(packageRoot)) {
        return 'deployed_bundle';
    }
    return 'unknown';
}

/** The invoked launcher selects code; command arguments and cwd select data only. */
export function resolveDelegatedLauncherTrustEvidence(
    _argv: string[],
    _cwd: string,
    currentScriptPath: string,
    packageRoot: string
): DelegationTrustEvidence {
    const normalizedPackageRoot = path.resolve(packageRoot);
    const currentRuntimeKind = resolveCurrentRuntimeKind(normalizedPackageRoot, currentScriptPath);
    const installedUnderNodeModules = isPackageInstalledUnderNodeModules(normalizedPackageRoot);
    const packageMetadata = readPackageMetadata(normalizedPackageRoot);
    const currentRuntime: CurrentRuntimeEvidence = {
        package_root: normalizedPackageRoot,
        runtime_kind: currentRuntimeKind,
        package_installed_under_node_modules: installedUnderNodeModules,
        recognized_package_name: isRecognizedPackageName(packageMetadata.name),
        package_name: packageMetadata.name,
        package_version: packageMetadata.version
    };

    return buildDelegationTrustEvidence(currentRuntime, null);
}

export function resolveDelegatedLauncherTarget(
    argv: string[],
    cwd: string,
    currentScriptPath: string,
    packageRoot: string
): string | null {
    const evidence = resolveDelegatedLauncherTrustEvidence(argv, cwd, currentScriptPath, packageRoot);
    return evidence.implementation_delegation.decision === 'allowed'
        ? evidence.delegated_runtime?.cli_path ?? null
        : null;
}
