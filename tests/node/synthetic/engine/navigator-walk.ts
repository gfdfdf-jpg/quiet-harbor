import NATIVE_COUNTER_SHAPES from '../native-counter-input-shapes.json';
import { hasPreservedDeltaCounterInputs, hasTwoSourceApiCounterInputs, PRESERVED_DELTA_COUNTER_STATE,
    TWO_SOURCE_API_INITIAL_STATE, TWO_SOURCE_API_REMEDIATION_STATE } from './walk-preserved-delta-counter-state';
import { WALK_CLOCK_OFFSET } from './walk-clock';
import { prepareEmptyWalkWindowsAcl } from './walk-windows-acl-fixture';
import { resolveWalkReviewFix, walkRemediationEdits, type WalkRemediationStep } from './walk-remediation-script';
import { isPlainRecord } from '../../../../src/core/records';
import { observeStandOracle } from './stand-check-observation';
import './walk-route-observer';
import { NODE_WALK_FIXTURE, seedWalkFixture, COMPILE_FAILURE_FLAG, FULL_SUITE_FAILURE_FLAG, type WalkFixtureDescriptor } from './walk-fixture';
import { STACK_COUNTER_STATE_IDS } from './walk-stack-fixtures';
import { NextStepEffectPlanStaleError } from '../../../../src/gates/next-step/next-step-effects';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Session } from 'node:inspector';
import { beginRouteObservation, reachedRoutePoints } from './walk-routes';
import { captureArtifactReads, disturbanceId, hasHumanRecovery, isActionableIntegrityRefusal, isCompletedSweepReset, isOutOfOrderRefusal, isUncaughtGateError, missingWalkMilestones,
    mutateSweepFile, resetPlannedFiles, resolveSweepArtifact, walkInjectionDue, walkRestarts, wrongGateArgv, type ArtifactRead, type SweepDisturbance, type SweepInjection } from './walk-sweep';
import { removeWalkDirectory, restoreWalkCheckpoint } from './walk-checkpoint';
import { walkWorkspaceFingerprint, walkNonGitWorkspaceFingerprint, WalkProgressGuard } from './walk-progress';
import { artifactLane, economyExcessByLane, economyRecoveryStep, judgeReviewEconomy, ECONOMY_RULES, SWEEP_EDITS, type EconomyFacts } from './walk-economy';
import { captureWalkOutput as hideConsole } from './walk-output';
import { walkFixtureByteNormalizer } from './walk-byte-normalization';
import { sampleTimingCheckpoint } from './step-timing-session';

import { DEFAULT_BUNDLE_NAME } from '../../../../src/core/constants';
import { PROJECT_MEMORY_REQUIRED_FILE_NAMES } from '../../../../src/core/project-memory';
import { handleSetup } from '../../../../src/cli/commands/setup';
import { handleGate } from '../../../../src/cli/commands/gate-command';
import { handleWorkflow } from '../../../../src/cli/commands/workflow-command';
import { splitCommandLine } from '../../../../src/core/command-line';
import { inspectValidationCommand } from '../../../../src/core/validation-command-contract';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../../src/core/next-step-measurement';
import { executeNextStepEffects, resolveNextStep } from '../../../../src/gates/next-step';
import { buildNextStepInstruction } from '../../../../src/gates/next-step/next-step-command-formatters';
import { TRUST_BOUNDARY_ANALYSIS_RULE_ID } from '../../../../src/core/trust-boundary-analysis';
import { runAgentInit } from '../../../../src/lifecycle/agent-init';
import { UPDATE_CHECK_OPT_OUT_ENV } from '../../../../src/lifecycle/update-availability/update-availability-types';
import { REVIEW_LANES, type StandFinding } from '../../../../scripts/node-foundation/synthetic/model';
import { runDiagnostics, type DiagnosticRecord } from '../../../../scripts/node-foundation/diagnose-next-step';
import { initializeGitRepo, runGit } from '../../cli/commands/gate-test-helpers';
import { validationDigest } from '../../../../src/core/project-validation-identity';
import { readProjectValidationAuthority } from '../../../../src/core/project-validation-authority';
import { retainedNativeCaseOutput } from '../../../../src/gates/review/native-case-semantics';
import type { ReviewCoverageContract } from '../../../../src/gates/review/review-coverage-ledger';
import {
    buildFailedJsonReviewReport,
    buildNoFindingsJsonReviewReport
} from '../../cli/commands/gates/review-result/gates-command-review-result-fixtures';

// Drives one synthetic task through the real navigator (tests/node/synthetic/README.md): the agent only runs
// the command next-step gives it, edits files and answers what a real agent would answer.
export const WALK_TASK_ID = 'T-WALK';
const MAX_WALK_STEPS = 800;
const MAX_SAME_COMMAND = 3;
const REVIEWER_WORK_MS = 11_000;
const WALK_PACKAGE_JSON = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
const REVIEW_SKILLS = ['testing-strategy', 'performance-review', 'api-contract-review', 'architecture-review', 'refactor-playbook'];

export interface WalkEdit {
    path: string;
    append: string;
    replace?: { before: string; after: string };
}

/** What goes wrong during a walk; each one happens once. */
export type WalkDisturbance =
    | { kind: 'fail-compile' }
    | { kind: 'fail-full-suite' }
    | { kind: 'repeat-command'; gate: string }
    | { kind: 'late-edit'; gate: string; edit: WalkEdit }
    | { kind: 'broken-report'; lane: string }
    | { kind: 'invalid-report-shape'; lane: string }
    | { kind: 'missing-report-semantics'; lane: string }
    | { kind: 'fast-reviewer'; lane: string }
    | { kind: 'after-done-edit'; edit: WalkEdit };

export interface WalkScenario {
    /** Observe the real navigator before the synthetic agent fills placeholders or chooses an action. */
    inspectNavigation?: (result: ReturnType<typeof resolveNextStep>, steps: readonly WalkStep[]) => void;
    /** Fixed inherited trusted ACL input for a separately calibrated Windows performance fixture. */
    windowsAclInput?: 'inherited-trusted';
    fixture?: WalkFixtureDescriptor;
    taskTitle?: string;
    taskNotes?: string;
    selectionTargets?: string[];
    /** Extra independent oracle, evaluated before the disposable repository is removed. */
    inspectResult?: (repoRoot: string, result: WalkResult) => void;
    preferredOutOfScopeRepair?: boolean;
    /** The agent knows its failed opaque command was broad and chooses the offered reselection. */
    reselectAfterFailure?: boolean;
    id: string;
    testSelectionCommand?: string;
    /** Named fixture state with separately measured budgets; never an exemption from growth checks. */
    counterState?: string;
    mode?: 'strict_sequential' | 'parallel_all' | 'test_after_code' | 'code_first_optional';
    requiredLanes?: string[];
    reviewOrder?: string[];
    edits: WalkEdit[];
    /** Failed attempts per lane: the first N reviews of that lane report a finding. */
    failures?: Partial<Record<string, number>>;
    findingSeverity?: 'high' | 'low';
    findingDescription?: string;
    failureAttempts?: Record<string, number[]>;
    customLane?: boolean;
    /** Native complete-reviewer-launch may leave invocation recording to the next command. */
    separateReviewInvocation?: boolean;
    /** The original reviewer cannot be reached after a rejected report. */
    unreachableReviewer?: boolean;
    reviewerAttestation?: 'provider' | 'controller' | 'provider-no-live-receipt';
    /** The fix written after each failed review. */
    fix?: WalkEdit[];
    /** Explicit repairs keyed by the failed lane and attempt, including mixed production/test sequences. */
    remediationSequence?: readonly WalkRemediationStep[];
    disturbances?: WalkDisturbance[];
    /** Fresh reviewer launches per lane the review contract requires. */
    expectedReviews: Record<string, number>;
    /** Launch order and mode derived from the review rule table. */
    expectedModes: string[];
    /** Scripted stack faults also check exact rule-derived counts/modes after the general injection checks. */
    enforceReviewExpectations?: boolean;
    /** A finite scripted fault phase; only fixture injection changes it, never navigator timestamps or commands. */
    progressBoundary?: () => string;
    expectedTaskReviews?: Record<string, string[]>;
    /** Routes the agent must actually visit while continuing to the declared terminal outcome. */
    expectedGates?: string[];
    /** Selected source points, including transient decisions between real native publications. */
    expectedRoutes?: string[];
    /** Gates whose command this scenario makes fail on purpose. */
    expectedFailingGates?: string[];
    profile?: 'fast' | 'balanced' | 'strict' | 'docs-only';
    fullSuitePlacement?: 'after_compile_before_reviews' | 'before_completion' | 'before_test_review';
    dependencyGraph?: { preparation_order: string[]; dependencies: Record<string, string[]> };
    /** Setup before entry, never a mutation of the source checkout. */
    setup?: (repoRoot: string) => void;
    /** Operator configuration before agent-init freezes the fixture's installation. */
    configure?: (repoRoot: string) => void;
    /** Family-specific agent actions. Gate evidence is created by the real commands, never fabricated. */
    prepare?: (repoRoot: string, steps: readonly WalkStep[], run: (argv: string[]) => Promise<void>) => Promise<void>;
    /** Inspect a linked child after native parent preparation; commands retain their printed task identity. */
    inspectTask?: (steps: readonly WalkStep[]) => string;
    act?: (repoRoot: string, gate: string | null, steps: readonly WalkStep[], run: (argv: string[]) => Promise<void>) => Promise<boolean>;
    /** The scenario executes one RED gate per declared invocation instead of the suggested single-command placeholder. */
    agentExecutesRed?: boolean;
    /** Run a printed command in an externally controlled native owner instead of awaiting it in-process. */
    execute?: (repoRoot: string, step: WalkStep) => Promise<boolean>;
    /** Always stop external owners before removing their disposable repository, including on failure. */
    cleanup?: (repoRoot: string) => Promise<void>;
    /** Explicit fault injection in a family scenario, reported separately from ordinary work calibration. */
    disturbanceReason?: string;
    expectedBlockedGate?: string | null;
    expectedTerminalStatus?: 'BLOCKED' | 'DECOMPOSED';
    expectedGuidance?: RegExp;
    expectedDoneGuidance?: RegExp;
    trackedFiles?: number;
    injection?: SweepInjection;
    /** Explicit number of distinct policy changes the modeled operator agrees to adopt. Default: one. */
    approvedPolicyAdoptions?: number;
    foreignTask?: boolean;
    qualityRework?: boolean;
    /** The user approves the new review cycle a write after REVIEW_GATE_PASSED needs; otherwise the agent reverts. */
    approveReviewRestart?: boolean;
    /** Before reverting, the agent runs that restart without the approval options (the gate must refuse). */
    tryRestartWithoutApproval?: boolean;
}

export interface WalkStep {
    index: number;
    taskId?: string;
    counterState?: string;
    gate: string | null;
    status: string;
    command: string | null;
    navigatorMs: number;
    commandMs: number;
    exitCode: number | null;
    output: string;
    reason: string;
    taskEvents: number;
    eventReadError?: string;
    effectReinspection?: true;
    workspaceSha256: string;
    measurement: NextStepMeasurement | null;
    diagnostic?: DiagnosticRecord;
    routes?: string[];
    route?: string;
    coreMs?: number;
    outsideCoreMs?: number;
    cpuProfile?: string;
    threw?: boolean;
    reads?: ArtifactRead[];
    disturbances?: string[];
    /** The agent reverted its write after REVIEW_GATE_PASSED, as next-step asked. */
    reverted?: boolean;
    /** The synthetic user approved a new review cycle after such a write. */
    userApproval?: boolean;
    /** The restart the agent tried without the user's approval, and the gate's answer. */
    unapprovedRestart?: { command: string; exitCode: number; output: string; threw?: boolean };
    reusedPrefix?: boolean;
    repeatedCommand?: { command: string; exitCode: number; output: string; threw?: boolean; ms: number; stateUnchanged?: boolean };
    /** The real gate the agent ran instead of this step's command, and its answer. */
    wrongGate?: { gate: string; command: string; exitCode: number; output: string; threw?: boolean; uncaught: boolean; ms: number };
    effectResult?: { gate: string | null; status: string; route: string; routes: string[]; reason: string };
    preparation?: Array<{ command: string; output: string }>;
}

export type WalkOutcome = 'done' | 'blocked' | 'dead_end' | 'loop' | 'step_limit' | 'agent_stuck' | 'exception';

export interface WalkReview {
    taskId?: string;
    lane: string;
    mode: string;
    /** Step that launched the reviewer. A launch at or after the injection step ran after the disturbance. */
    step?: number;
    /** Step when this reviewer returned; null while the launched reviewer is still open. */
    completed?: number | null;
}

export interface WalkResult {
    scenarioId: string;
    counterState?: string;
    outcome: WalkOutcome;
    detail: string;
    steps: WalkStep[];
    reviewsByLane: Record<string, number>;
    reviews: WalkReview[];
    events: Array<{ type: string; details: Record<string, unknown> }>;
    eventReadError?: string;
    elapsedMs?: number;
    trackedFiles?: number;
    sweep?: { seed: number; baseline: string; step: number; disturbances: string[]; applied: string[]; economy?: EconomyFacts;
        requiredAtDone?: string[] };
    checkpointControl?: { baseline: string; step: number };
    disturbances?: string[];
}

interface WalkContext {
    repoRoot: string;
    scenario: WalkScenario;
    steps: WalkStep[];
    reviewsByLane: Record<string, number>;
    reviewerLaunchCommands: Record<string, string>;
    reviews: WalkReview[];
    disturbances: WalkDisturbance[];
    implemented: boolean;
    preservedImplementation?: boolean;
    fixPending: boolean;
    pendingReviewFailure?: { reviewType: string; attempt: number };
    injected: boolean;
    approveInjectedRestart?: boolean;
    policyAdoptionsApproved?: number;
    applied: string[];
    qualityReworkApplied: boolean;
    /** Content before the agent's late edits, so it can revert them when next-step asks. null = the file did not exist. */
    lateEditOriginals: Map<string, string | null>;
}

function writeTextFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

// The reviewer timing guard needs a real work window; the stand moves the clock instead of sleeping.
let clockOffsetMs = 0;
const RealDate = Date;
class ShiftedDate extends RealDate {
    static get [WALK_CLOCK_OFFSET](): number { return clockOffsetMs; }
    constructor(...values: unknown[]) {
        if (values.length === 0) super(RealDate.now() + clockOffsetMs);
        else super(...values as [number]);
    }
    static override now(): number {
        return RealDate.now() + clockOffsetMs;
    }
}

function withShiftedClock<T>(action: () => Promise<T>): Promise<T> {
    globalThis.Date = ShiftedDate as unknown as DateConstructor;
    return action().finally(() => {
        globalThis.Date = RealDate;
        clockOffsetMs = 0;
    });
}

function configureBundle(bundleRoot: string, sourceRoot: string, fixture: WalkFixtureDescriptor): void {
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, Record<string, unknown>>;
    Object.assign(config.full_suite_validation, { enabled: true, command: fixture.projectTestCommand, timeout_ms: 120_000 });
    config.compile_gate.command = fixture.configuredCompileCommand ?? fixture.compileCommand;
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    writeTextFile(path.join(bundleRoot, 'live', 'config', 'review-capabilities.json'), `${JSON.stringify({
        code: true, db: true, security: true, refactor: true, api: true, test: true, performance: true, infra: true, dependency: true
    }, null, 2)}\n`);
    for (const skill of REVIEW_SKILLS) {
        writeTextFile(path.join(bundleRoot, 'live', 'skills', skill, 'SKILL.md'), fs.readFileSync(
            path.join(sourceRoot, 'template', 'skill-packs', 'quality-architecture', 'skills', skill, 'SKILL.md'), 'utf8'));
    }
    writeTextFile(path.join(bundleRoot, 'live/skills/devops-k8s/SKILL.md'), fs.readFileSync(
        path.join(sourceRoot, 'template/skill-packs/devops-k8s/skills/devops-k8s/SKILL.md'), 'utf8'));
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')) as {
        built_in_profiles: Record<string, { task_decomposition?: { enabled?: boolean } }>;
    };
    profiles.built_in_profiles.balanced.task_decomposition = { enabled: false };
    fs.writeFileSync(profilesPath, `${JSON.stringify(profiles, null, 2)}\n`, 'utf8');
    const commandsPath = path.join(bundleRoot, 'live', 'docs', 'agent-rules', '40-commands.md');
    fs.writeFileSync(commandsPath, fs.readFileSync(commandsPath, 'utf8').replace(/<[a-z][a-z -]* command>/gu, fixture.compileCommand), 'utf8');
    for (const fileName of PROJECT_MEMORY_REQUIRED_FILE_NAMES) {
        writeTextFile(path.join(bundleRoot, 'live', 'docs', 'project-memory', fileName),
            `# ${fileName}\n\nSynthetic walk fixture memory for ${fileName}.\n`);
    }
}

export async function createWalkTemplate(sourceRoot: string, fixture = NODE_WALK_FIXTURE): Promise<string> {
    const packageJson = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')) as { name: string; version: string };
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-walk-template-'));
    const bundleRoot = path.join(workspaceRoot, DEFAULT_BUNDLE_NAME);
    runGit(workspaceRoot, ['init']);
    writeTextFile(path.join(bundleRoot, 'runtime', 'init-answers.json'), `${JSON.stringify({
        AssistantLanguage: 'English', AssistantBrevity: 'concise', SourceOfTruth: 'Codex', EnforceNoAutoCommit: 'false',
        ClaudeOrchestratorFullAccess: 'false', TokenEconomyEnabled: 'true', ProviderMinimalism: 'false',
        CollectedVia: 'CLI_NONINTERACTIVE', ActiveAgentFiles: 'AGENTS.md'
    }, null, 2)}\n`);
    if (fixture.id !== NODE_WALK_FIXTURE.id) seedWalkFixture(workspaceRoot, fixture);
    await hideConsole([], () => handleSetup(
        ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--source-of-truth', 'Codex'],
        packageJson, sourceRoot));
    if (fixture.id === NODE_WALK_FIXTURE.id) seedWalkFixture(workspaceRoot, fixture);
    configureBundle(bundleRoot, sourceRoot, fixture);
    runAgentInit({
        targetRoot: workspaceRoot, activeAgentFiles: 'AGENTS.md', projectRulesUpdated: 'yes', skillsPrompted: 'yes',
        ordinaryDocPaths: 'CHANGELOG.md', verifyRunner: () => ({ passed: true }), manifestRunner: () => ({ passed: true })
    });
    fs.writeFileSync(path.join(workspaceRoot, 'TASK.md'), [
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${WALK_TASK_ID} | 🟦 TODO | P1 | testing/synthetic-walk | ${fixture.taskTitle} | fixture | 2026-10-30 | balanced | Synthetic navigator walk. |`,
        ''
    ].join('\n'), 'utf8');
    initializeGitRepo(workspaceRoot);
    return workspaceRoot;
}

function hashWorkspace(repoRoot: string): string {
    if (!fs.existsSync(path.join(repoRoot, '.git'))) return walkNonGitWorkspaceFingerprint(repoRoot);
    return walkWorkspaceFingerprint(repoRoot,
        runGit(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).stdout,
        runGit(repoRoot, ['diff']).stdout);
}

/** Workspace plus every runtime artifact and event: what a refusal that claims "Nothing was changed" must leave intact. */
function hashWalkState(repoRoot: string): string {
    const hash = createHash('sha256').update(hashWorkspace(repoRoot));
    const visit = (directory: string): void => {
        if (!fs.existsSync(directory)) return;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const file = path.join(directory, entry.name);
            hash.update(JSON.stringify([path.relative(repoRoot, file), entry.isDirectory() ? 'directory' : 'file']));
            if (entry.isDirectory()) visit(file);
            else if (entry.isFile()) hash.update(fs.readFileSync(file));
        }
    };
    visit(path.join(repoRoot, DEFAULT_BUNDLE_NAME, 'runtime'));
    return hash.digest('hex');
}

function applyEdits(repoRoot: string, edits: readonly WalkEdit[]): void {
    for (const edit of edits) {
        const filePath = path.join(repoRoot, edit.path);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        if (edit.replace) {
            const content = fs.readFileSync(filePath, 'utf8');
            if (!content.includes(edit.replace.before)) throw new Error('Missing task edit input: ' + edit.path);
            fs.writeFileSync(filePath, content.replace(edit.replace.before, edit.replace.after), 'utf8');
        }
        fs.appendFileSync(filePath, edit.append, 'utf8');
    }
}

async function runCommand(command: string): Promise<{ exitCode: number; output: string; threw?: boolean }> {
    const argv = splitCommandLine(command);
    if (argv.includes('workflow')) {
        const output: string[] = [];
        try {
            await hideConsole(output, async () => handleWorkflow(argv.slice(argv.indexOf('workflow') + 1), WALK_PACKAGE_JSON));
            return { exitCode: 0, output: output.join('\n') };
        } catch (error) { return { exitCode: 1, threw: true, output: String(error) }; }
    }
    const gateIndex = argv.indexOf('gate');
    if (gateIndex >= 0) return runGate(argv.slice(gateIndex + 1));
    if (argv.includes('next-step') && argumentValue(command, '--effect-plan-sha256')) {
        try {
            const result = executeNextStepEffects({ taskId: argv[argv.indexOf('next-step') + 1],
                repoRoot: argumentValue(command, '--repo-root') || '.' }, argumentValue(command, '--effect-plan-sha256'));
            return { exitCode: 0, output: JSON.stringify(result) };
        } catch (error) {
            return { exitCode: 1, threw: true, output: error instanceof Error ? error.stack || error.message : String(error) };
        }
    }
    throw new Error('The stand cannot execute this command: ' + command);
}

async function runGate(gateArgv: string[]): Promise<{ exitCode: number; output: string; threw?: boolean }> {
    const output: string[] = [];
    const previousExitCode = process.exitCode;
    try {
        process.exitCode = 0;
        await hideConsole(output, () => handleGate(gateArgv));
        return { exitCode: Number(process.exitCode ?? 0), output: output.join('\n') };
    } catch (error: unknown) {
        return { exitCode: 1, threw: true, output: [...output, error instanceof Error ? error.stack || error.message : String(error)].join('\n') };
    } finally {
        process.exitCode = previousExitCode;
    }
}

/** Bind each target to the corresponding selected invocation, including a deliberate broad attempt. */
export function walkTaskSelectionPlan(selected: string, targets: readonly string[], fixture: WalkFixtureDescriptor, taskId: string) {
    const descriptor = inspectValidationCommand(selected, 'test', { allowConjunction: true }).descriptor;
    if (!descriptor) throw new Error('Agent selected an invalid task command: ' + selected);
    return { targets: targets.map(target => {
        const own = fixture.taskTestInvocations?.findIndex(run => run.targets.includes(target)) ?? 0;
        const invocation = own >= 0 && own < descriptor.invocations.length ? own : 0;
        return { path: target, invocation, entrypoint: descriptor.invocations[invocation].executable,
            reason: `${taskId}: this entrypoint verifies the declared task behavior for ${target}.` };
    }), ...(fixture.taskTestSupport ? { support: fixture.taskTestSupport } : {}) };
}

function navigate(repoRoot: string, scenarioId: string, taskId = WALK_TASK_ID, prior: WalkStep[] = []): { result: ReturnType<typeof resolveNextStep>; ms: number; measurement: NextStepMeasurement | null; diagnostic?: DiagnosticRecord } {
    const outputDir = process.env.GARDA_SYNTHETIC_WALK_DIAGNOSTICS;
    if (outputDir) {
        const run = runDiagnostics({ repoRoot, taskId, outputDir, label: scenarioId,
            cpuProfile: process.env.GARDA_SYNTHETIC_WALK_DIAGNOSTICS_CPU === '1' });
        const diagnostic = run.records[0];
        if (run.exitCode || diagnostic.issues.length) throw new Error('Navigator diagnostics failed: ' + JSON.stringify(diagnostic.issues));
        return {
            result: JSON.parse(fs.readFileSync(diagnostic.stdout_file, 'utf8')) as ReturnType<typeof resolveNextStep>,
            ms: diagnostic.wall_ms, measurement: diagnostic.timing as unknown as NextStepMeasurement, diagnostic
        };
    }
    let measurement: NextStepMeasurement | null = null;
    const started = performance.now();
    const result = withNextStepMeasurement(() => resolveNextStep({ taskId, repoRoot }), (value) => { measurement = value; },
        { normalizeTimelineBytes: walkFixtureByteNormalizer(repoRoot) });
    const elapsed = performance.now() - started;
    // Counters above are a separate pass. Each direct call below creates its own native read observation.
    if (process.env.GARDA_SYNTHETIC_STEP_TIMING === '1') sampleTimingCheckpoint(repoRoot, scenarioId, result,
        () => resolveNextStep({ taskId, repoRoot }), measurement, taskId, () => {
            let measured: NextStepMeasurement | null = null;
            const observed = withNextStepMeasurement(() => resolveNextStep({ taskId, repoRoot }), value => { measured = value; },
                { normalizeTimelineBytes: walkFixtureByteNormalizer(repoRoot) });
            return { result: observed, measurement: measured };
        }, prior);
    return { result, ms: elapsed, measurement };
}

function fillQualityAnswers(answersPath: string, changedFiles: readonly string[], fixture = NODE_WALK_FIXTURE): void {
    const template = JSON.parse(fs.readFileSync(answersPath, 'utf8')) as { answers: Array<Record<string, unknown>> };
    template.answers = template.answers.map((answer) => ({
        ...answer,
        status: 'PASS',
        answer: `The synthetic change stays small, so ${String(answer.rule_id)} adds no risk beyond the focused edit.`,
        evidence_files: [...changedFiles],
        actions_taken: [],
        actions_required: [],
        ...(answer.rule_id === TRUST_BOUNDARY_ANALYSIS_RULE_ID ? { trust_boundary_matrix: fixture.trustBoundaryMatrix } : {})
    }));
    fs.writeFileSync(answersPath, `${JSON.stringify(template, null, 2)}\n`, 'utf8');
}

function argumentValue(command: string, name: string): string {
    const argv = splitCommandLine(command);
    const index = argv.indexOf(name);
    return index >= 0 ? String(argv[index + 1] || '') : '';
}

/** The selected provider is also installed as the runtime detection marker by the stand. */
export const WALK_PROVIDER = process.env.GARDA_SYNTHETIC_WALK_PROVIDER || 'Codex';

/**
 * Without a detected provider, next-step prints the environment reference the agent's shell expands:
 * `"$env:GARDA_EXECUTION_PROVIDER"` in PowerShell, `"$GARDA_EXECUTION_PROVIDER"` in POSIX shells
 * (Linux, macOS, Git Bash). The stand executes commands in-process, so it expands both forms itself.
 */
export function fillProviderValues(command: string, reviewer: string, fixedFiles: readonly string[]): string {
    return command
        .replace(/\$(?:env:)?GARDA_EXECUTION_PROVIDER\b/gu, WALK_PROVIDER)
        .replace(/<agent:resolved-provider-reviewer-id-from-delegated-agent>/gu, 'agent:' + reviewer)
        .replace(/<provider-owned invocation id from delegated reviewer launch result>/gu, 'provider-' + reviewer)
        .replace(/<provider-owned attestation source from delegated reviewer launch result>/gu, 'test_provider_invocation')
        .replace(/<analysis>/gu, 'the synthetic fix stays inside ' + fixedFiles.join(', ') + ' and needs the reviewed lanes only');
}

/**
 * A reviewer cites only its evidence location domain, the context's FILE obligations, as its prompt contract
 * says. A DELTA domain holds only the fix's files of that lane, so a citation of another task file moves to the
 * first domain file (a non-document one first). Citations already in the domain stay as they are.
 */
function citeEvidenceDomain(report: Record<string, unknown>, contextPath: string): void {
    const context = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as { coverage_contract: { obligations: Array<{ kind: string; target: string }> } };
    const domain = context.coverage_contract.obligations.filter(obligation => obligation.kind === 'file').map(obligation => obligation.target);
    const cited = domain.find(target => !/\.md$/u.test(target)) ?? domain[0];
    if (!cited) return;
    const findings = report.findings as Record<string, Array<{ evidence?: Array<{ location: string }> }>>;
    const notes = report.validation_notes as Array<{ evidence: Array<{ location: string }> }>;
    const ledger = report.coverage_ledger as { entries: Array<{ evidence: Array<{ location: string }> }> };
    for (const evidence of [...notes, ...ledger.entries, ...Object.values(findings).flat()].flatMap(item => item.evidence ?? [])) {
        if (!domain.includes(evidence.location.replace(/:\d+$/u, ''))) evidence.location = cited + ':1';
    }
}

/** A reviewer confirms the focused test run itself: the ledger entry cites the test and quotes its output. */
function resolveValidationCases(repoRoot: string, report: Record<string, unknown>, contextPath: string, fixture: WalkFixtureDescriptor): void {
    const ledger = report.coverage_ledger as { entries: Array<{ obligation_id: string; evidence: Array<{ location: string }>; case_resolution?: unknown }> };
    const context = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as { coverage_contract: ReviewCoverageContract };
    for (const obligation of context.coverage_contract.obligations) {
        const binding = obligation.validation_binding;
        if (!binding) continue;
        const execution = binding.case_execution;
        if (binding.execution !== 'OBSERVED' || !execution) throw new Error('No genuine current execution for ' + obligation.id);
        // Native task commands retain UTF-8; recipes retain authenticated base64 stream envelopes.
        // Both must quote their actual selected case, never infer PASS from process exit alone.
        const output = retainedNativeCaseOutput(repoRoot, execution).text;
        const quote = (execution.expected_failure ? fixture.failedCaseQuote : fixture.passedCaseQuote)?.(
            repoRoot, binding.source_identity.path, binding.selector, output);
        if (!quote) throw new Error('No retained assertion quotation for ' + binding.selector);
        const entry = ledger.entries.find(item => item.obligation_id === obligation.id);
        if (!entry) throw new Error('Modeled reviewer omitted ' + obligation.id);
        entry.case_resolution = { binding_sha256: validationDigest(binding), execution_sha256: execution.record_sha256,
            output_sha256: execution.output_sha256,
            ...(execution.expected_failure ? { outcome: 'FAILED', failure_kind: 'ASSERTION' } : { outcome: 'PASSED' }), evidence_quote: quote,
            reasoning: fixture.caseReasoning ?? 'The fixture source and retained execution establish the selected case result: ' + fixture.id + '.' };
        entry.evidence[0].location = binding.source_identity.path + ':1';
    }
}

function writeReviewerReport(repoRoot: string, command: string, lane: string, content: 'failed' | 'clean' | 'broken', scenario?: WalkScenario): void {
    const launchPath = path.resolve(repoRoot, argumentValue(command, '--reviewer-launch-artifact-path'));
    const launch = JSON.parse(fs.readFileSync(launchPath, 'utf8')) as { review_output_path?: string };
    const taskId = argumentValue(command, '--task-id') || WALK_TASK_ID;
    const contextPath = reviewContextPath(repoRoot, lane, taskId);
    const fixtureObservations = scenario?.fixture?.inspectReviewEvidence?.(repoRoot, taskId, lane) ?? [];
    const build = content === 'failed' ? buildFailedJsonReviewReport : buildNoFindingsJsonReviewReport;
    const report = build(contextPath, taskId, lane);
    if (fixtureObservations.length) (report.validation_notes as Array<{ note: string }>)[0].note += ' ' + fixtureObservations.join('; ');
    if (content === 'failed') {
        const findings = report.findings as { high: Array<Record<string, unknown>>; low: Array<Record<string, unknown>> };
        if (scenario?.findingDescription) {
            findings.high[0].title = scenario.findingDescription;
            findings.high[0].description = scenario.findingDescription;
            const evidence = findings.high[0].evidence as Array<{ observation: string }>;
            evidence[0].observation = scenario.findingDescription;
        }
        if (scenario?.findingSeverity === 'low') { findings.low = findings.high; findings.high = []; }
    }
    citeEvidenceDomain(report, contextPath);
    resolveValidationCases(repoRoot, report, contextPath, scenario?.fixture ?? NODE_WALK_FIXTURE);
    const outputPath = path.resolve(repoRoot, String(launch.review_output_path || ''));
    // Preserve the context's file obligations, including document targets in a mixed review domain.
    writeTextFile(outputPath, content === 'broken' ? 'not a review report\n' : JSON.stringify(report, null, 2) + '\n');
    // The file is written on the stand's clock, not on the machine's.
    const now = new Date();
    fs.utimesSync(outputPath, now, now);
}

function reviewContextPath(repoRoot: string, lane: string, taskId = WALK_TASK_ID): string {
    return path.join(repoRoot, DEFAULT_BUNDLE_NAME, 'runtime', 'reviews', taskId + '-' + lane + '-review-context.json');
}

function readTaskEvents(repoRoot: string, taskId = WALK_TASK_ID): WalkResult['events'] {
    const eventsPath = path.join(repoRoot, DEFAULT_BUNDLE_NAME, 'runtime', 'task-events', taskId + '.jsonl');
    if (!fs.existsSync(eventsPath)) return [];
    return fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((line) => {
        const event = JSON.parse(line) as { event_type: string; details?: Record<string, unknown> };
        return { type: event.event_type, details: event.details ?? {} };
    });
}

/** Diagnostic bookkeeping must preserve the native integrity refusal, never turn it into a stand parser exception. */
export function inspectWalkTaskEvents(repoRoot: string, taskId = WALK_TASK_ID): { events: WalkResult['events']; error?: string } {
    try { return { events: readTaskEvents(repoRoot, taskId) }; }
    catch (error) { return { events: [], error: 'Cannot inspect task events for ' + taskId + ': ' + String(error) }; }
}

export function scenarioDisturbanceLabels(scenario: WalkScenario): string[] {
    return [...scenario.disturbances?.map(entry => JSON.stringify(entry)) ?? [],
        ...scenario.disturbanceReason ? [scenario.disturbanceReason] : []];
}

export function isWalkEffectReinspection(error: unknown): boolean {
    return error instanceof NextStepEffectPlanStaleError;
}

/** Native v4 selectors/receipts add measured proof inputs. Existing budgets stay as the strict unadmitted fallback. */
export function measuredNativeCounterState(admitted: string | undefined, events: WalkResult['events'], nativeBundlePrepared = false, taskId = WALK_TASK_ID): string | undefined {
    if (admitted === 'native-api-selected-remediation' && hasPreservedDeltaCounterInputs(events, taskId)) return PRESERVED_DELTA_COUNTER_STATE;
    if (admitted?.startsWith('native-api-selected-') && hasTwoSourceApiCounterInputs(events, taskId))
        return admitted === 'native-api-selected-initial' ? TWO_SOURCE_API_INITIAL_STATE : TWO_SOURCE_API_REMEDIATION_STATE;
    if (admitted?.startsWith('native-api-selected-')) return admitted;
    const currentEntry = events.some(event => event.type === 'TASK_MODE_ENTERED'
        && event.details.profile_policy_snapshot_required === true
        && typeof event.details.profile_policy_snapshot_hash === 'string'
        && /^[a-f0-9]{64}$/u.test(event.details.profile_policy_snapshot_hash));
    let id: string;
    if (admitted) id = 'native-v4-' + admitted;
    else if (currentEntry) {
        const preflight = [...events].reverse().find(event => event.type === 'PREFLIGHT_CLASSIFIED'
            && isPlainRecord(event.details.required_reviews));
        const lanes = preflight ? Object.entries(preflight.details.required_reviews as Record<string, unknown>)
            .filter(([, value]) => value === true).map(([name]) => name).sort() : null;
        id = 'native-v4-task--' + (lanes === null ? 'preflight-pending' : lanes.join('+') || 'no-reviews');
    } else if (nativeBundlePrepared && !events.some(event => event.type === 'TASK_MODE_ENTERED')) id = 'native-v4-pre-entry';
    else return admitted;
    // The manifest lists independently measured input sets, never thresholds selected from observed work.
    return NATIVE_COUNTER_SHAPES.shapes.some(shape => shape.id === id) ? id : admitted;
}

/** A fixture's calibration applies only after native admission, never from its scenario label alone. */
export function admittedCounterState(state: string | undefined, events: WalkResult['events'], taskId = WALK_TASK_ID,
    parentEvents: WalkResult['events'] = [], declaredRecipeAdmitted = false): string | undefined {
    if (state === 'native-api-selected-initial' || state === 'native-api-selected-remediation') {
        const admitted = events.some(event => {
            const required = event.details.required_reviews;
            return event.type === 'PREFLIGHT_CLASSIFIED' && Number(event.details.changed_files_count) > 0
                && isPlainRecord(required) && ['code', 'api', 'test'].every(lane => required[lane] === true)
                && Object.values(required).filter(value => value === true).length === 3;
        });
        const restarted = events.some(event => event.type === 'REVIEW_CYCLE_RESTARTED');
        return admitted ? restarted ? 'native-api-selected-remediation' : 'native-api-selected-initial' : undefined;
    }
    if (state === 'stack-decomposition-planning') return taskId === WALK_TASK_ID && events.some(event =>
        event.type === 'TASK_MODE_ENTERED' && event.details.task_profile === 'strict'
        && typeof event.details.planned_source_visibility_sha256 === 'string'
        && /^[a-f0-9]{64}$/u.test(event.details.planned_source_visibility_sha256)) ? state : undefined;
    if (state === 'matrix-test-review-reuse' && !events.some(event =>
        event.type === 'PREFLIGHT_CLASSIFIED' && event.details.changed_files_count !== 0))
        return events.some(event => event.type === 'TASK_MODE_ENTERED' && event.details.task_profile === 'balanced'
            && event.details.profile_policy_snapshot_required === true
            && typeof event.details.profile_policy_snapshot_hash === 'string'
            && /^[a-f0-9]{64}$/u.test(event.details.profile_policy_snapshot_hash)
            && typeof event.details.planned_source_visibility_sha256 === 'string'
            && /^[a-f0-9]{64}$/u.test(event.details.planned_source_visibility_sha256)) ? state : undefined;
    if (state === 'leaf-test-review-reuse' || state === 'matrix-test-review-reuse'
        || state === 'stack-four-lane-task' || state === 'stack-four-lane-cmake-task') {
        const admitted = events.some(event => {
        const required = event.details.required_reviews;
        return event.type === 'PREFLIGHT_CLASSIFIED' && isPlainRecord(required)
            && ['code', 'security', 'refactor', 'test'].every(lane => required[lane] === true);
        });
        return admitted ? state === 'stack-four-lane-cmake-task' ? 'stack-four-lane-task' : state
            : state === 'stack-four-lane-cmake-task' && events.some(event => event.type === 'TASK_MODE_ENTERED')
                ? 'stack-fixture-cmake-planning' : undefined;
    }
    if (state === 'task-test-failure-repair') {
        const failure = events.findIndex(event => event.type === 'FULL_SUITE_VALIDATION_FAILED'
            && event.details.status === 'FAILED' && typeof event.details.exit_code === 'number'
            && event.details.exit_code !== 0);
        return failure >= 0 && events.slice(0, failure).some(event => event.type === 'COMPILE_GATE_PASSED')
            ? state : undefined;
    }
    if (state === 'stack-retained-broad-failure' || state === 'full-suite-out-of-scope-narrow') {
        const failure = events.findIndex(event => event.type === 'FULL_SUITE_VALIDATION_FAILED'
            && event.details.status === 'FAILED' && typeof event.details.output_artifact_path === 'string');
        return failure >= 0 && events.slice(failure + 1).some(event => event.type === 'TASK_TEST_SELECTION_RECORDED')
            ? 'stack-retained-broad-failure' : undefined;
    }
    if (state === 'stack-fixture-unknown-quartz-gate-tour'
        && events.some(event => event.type === 'FULL_SUITE_VALIDATION_FAILED'
            && event.details.status === 'FAILED' && typeof event.details.output_artifact_path === 'string')
        && events.some(event => event.type === 'OUT_OF_SCOPE_FOLLOW_UP_MATERIALIZED'
            && Array.isArray(event.details.bindings) && event.details.bindings.length > 0)) {
        return 'retained-task-test-failure';
    }
    if (state === 'task-local-expected-red') return events.some(event =>
        event.type === 'TEST_FIRST_EXPECTED_FAILURE_RECORDED'
        || event.type === 'PREFLIGHT_CLASSIFIED' && Number(event.details.changed_files_count) > 0
            && isPlainRecord(event.details.required_reviews) && event.details.required_reviews.test === true
            && event.details.required_reviews.code === false
            && typeof event.details.scope_sha256 === 'string' && /^[a-f0-9]{64}$/u.test(event.details.scope_sha256))
        ? state : undefined;
    const stackChild = state === 'stack-four-lane-native-child-tree' || state === 'stack-five-lane-native-child-tree';
    const taskRepairChild = state === 'task-local-full-suite-child-tree';
    if (taskRepairChild && taskId === WALK_TASK_ID
        && events.some(event => event.type === 'FULL_SUITE_VALIDATION_FAILED' && event.details.status === 'FAILED')
        && events.some(event => event.type === 'TASK_TEST_SELECTION_RECORDED'
            && isPlainRecord(event.details.task_test_selection_authority)
            && isPlainRecord(event.details.task_test_selection_authority.validation_plan))) return state;
    const authorityState = stackChild ? 'native-child-tree' : taskRepairChild ? 'full-suite-child-tree'
        : state === 'task-local-expected-red' ? 'test-first-recorded-red' : state;
    if (state && STACK_COUNTER_STATE_IDS.has(state)) return events.some(event => event.type === 'TASK_MODE_ENTERED') ? state : undefined;
    // A recipe is admitted by workflow set before task entry, rather than by a task timeline event.
    if (state === 'declared-recipe-reviewed' || state === 'declared-recipe-docs-only'
        || state === 'declared-recipe-task-local-reviewed' || state === 'declared-recipe-task-local-docs-only')
        return declaredRecipeAdmitted ? state : undefined;
    // Inspecting a not-yet-entered child already authenticates its admitted parent's evidence.
    // Its own TASK_MODE_ENTERED is later; it is not the boundary that introduces these inputs.
    const parentAdmission = authorityState === 'native-child-tree' ? 'STRICT_DECOMPOSITION_DECISION_RECORDED'
        : authorityState === 'full-suite-child-tree' ? 'FULL_SUITE_REPAIR_TASK_MATERIALIZED' : undefined;
    if (taskId !== WALK_TASK_ID && parentAdmission && parentEvents.some(event => event.type === parentAdmission)) return state;
    if ((stackChild || taskRepairChild) && taskId !== WALK_TASK_ID) return undefined; // A real parent handoff is mandatory.
    const admission: Record<string, string> = {
        'test-selection-module': 'TASK_MODE_ENTERED',
        'test-first-recorded-red': 'TEST_FIRST_EXPECTED_FAILURE_RECORDED',
        'optional-skill-activation': 'SKILL_SELECTED',
        'strict-split-decision': 'STRICT_DECOMPOSITION_DECISION_RECORDED',
        'failed-review-path-candidate': 'REVIEW_RECORDED',
        'native-child-tree': taskId === WALK_TASK_ID ? 'STRICT_DECOMPOSITION_DECISION_RECORDED' : 'TASK_MODE_ENTERED',
        'full-suite-child-tree': taskId === WALK_TASK_ID ? 'FULL_SUITE_REPAIR_TASK_MATERIALIZED' : 'TASK_MODE_ENTERED'
    };
    return state && authorityState && admission[authorityState] && events.some(event => event.type === admission[authorityState]) ? state : undefined;
}

function takeDisturbance<K extends WalkDisturbance['kind']>(
    context: WalkContext, kind: K, key: string
): Extract<WalkDisturbance, { kind: K }> | null {
    const index = context.disturbances.findIndex((entry) => entry.kind === kind
        && (('gate' in entry && entry.gate === key) || ('lane' in entry && entry.lane === key) || (!('gate' in entry) && !('lane' in entry))));
    return index < 0 ? null : context.disturbances.splice(index, 1)[0] as Extract<WalkDisturbance, { kind: K }>;
}

/** Capture the review mode at delegation start, even if the reviewer never returns. */
export function observeReviewerLaunch(repoRoot: string, taskId: string, lane: string, step: number): WalkReview {
    let mode = 'unknown';
    try {
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath(repoRoot, lane, taskId), 'utf8')) as {
            review_execution?: { mode?: unknown };
        };
        if (typeof reviewContext.review_execution?.mode === 'string') mode = reviewContext.review_execution.mode;
    } catch { /* Missing or unreadable context leaves the launch mode unknown. */ }
    return { lane, mode, step, completed: null };
}

function beginReviewer(context: WalkContext, command: string, lane: string, step: number): void {
    const taskId = argumentValue(command, '--task-id') || WALK_TASK_ID;
    context.reviewsByLane[lane] = (context.reviewsByLane[lane] ?? 0) + 1;
    const review = observeReviewerLaunch(context.repoRoot, taskId, lane, step);
    if (context.scenario.expectedTaskReviews) review.taskId = taskId;
    context.reviews.push(review);
}

function completeReviewer(context: WalkContext, command: string, lane: string): void {
    context.reviewerLaunchCommands[lane] = command;
    const review = [...context.reviews].reverse().find(entry => entry.lane === lane && entry.completed === null);
    if (!review) throw new Error('Reviewer completed without a recorded launch: ' + lane);
    const attempt = context.reviews.filter(entry => entry.lane === lane && entry.completed !== null).length + 1;
    const failed = context.scenario.failureAttempts?.[lane]?.includes(attempt)
        ?? attempt <= (context.scenario.failures?.[lane] ?? 0);
    if (!takeDisturbance(context, 'fast-reviewer', lane)) clockOffsetMs += REVIEWER_WORK_MS;
    writeReviewerReport(context.repoRoot, command, lane,
        takeDisturbance(context, 'broken-report', lane) ? 'broken' : failed ? 'failed' : 'clean', context.scenario);
    const invalidShape = takeDisturbance(context, 'invalid-report-shape', lane);
    const missingSemantics = takeDisturbance(context, 'missing-report-semantics', lane);
    if (invalidShape || missingSemantics) {
        const launchPath = path.resolve(context.repoRoot, argumentValue(command, '--reviewer-launch-artifact-path'));
        const launch = JSON.parse(fs.readFileSync(launchPath, 'utf8')) as { review_output_path: string };
        const report = JSON.parse(fs.readFileSync(launch.review_output_path, 'utf8')) as Record<string, unknown>;
        if (missingSemantics) report.findings = null;
        else report.unexpected = true;
        fs.writeFileSync(launch.review_output_path, JSON.stringify(report, null, 2) + '\n');
        const now = new Date(); fs.utimesSync(launch.review_output_path, now, now);
    }
    review.completed = context.steps.at(-1)?.index ?? null;
    context.fixPending = failed && context.scenario.findingSeverity !== 'low';
    context.pendingReviewFailure = context.fixPending ? { reviewType: lane, attempt } : undefined;
}

async function continueReviewer(context: WalkContext, command: string, lane: string, reason: string): Promise<string | null> {
    const taskId = argumentValue(command, '--task-id') || WALK_TASK_ID;
    const artifactPath = path.join(context.repoRoot, DEFAULT_BUNDLE_NAME, 'runtime/reviews', taskId + '-' + lane + '-output-correction.json');
    if (!fs.existsSync(artifactPath)) return null;
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as {
        binding: { reviewer_identity: string; reviewer_invocation_event_sha256: string };
        recovery: { selected_transport: string };
        transport_binding: { provider_invocation_id: string };
    };
    if (!['live_reviewer_continuation', 'api_conversation_continuation'].includes(artifact.recovery.selected_transport)) return null;
    const launchCommand = context.reviewerLaunchCommands[lane];
    if (!launchCommand) throw new Error('Correction lost the original open reviewer.');
    writeReviewerReport(context.repoRoot, launchCommand, lane, 'clean', context.scenario);
    const responseCommand = /First record the corrected response using: (.*?)\. If your reviewer cannot be reached/su.exec(reason)?.[1];
    if (!responseCommand) throw new Error('Navigator did not provide the correction response command.');
    if (responseCommand.includes('<paste exact delegated reviewer output here>')) throw new Error('Correction response command contains a placeholder.');
    const response = await runCommand(responseCommand);
    if (response.exitCode) throw new Error(response.output);
    return command;
}

/** Does what a real agent does for a step without a gate command; false when it has nothing left to do. */
async function actWithoutGate(context: WalkContext, result: ReturnType<typeof resolveNextStep>): Promise<boolean> {
    const taskId = result.task_id || WALK_TASK_ID;
    if (await context.scenario.act?.(context.repoRoot, result.next_gate, context.steps, async argv => {
        const response = await runGate(argv);
        (context.steps.at(-1)!.preparation ??= []).push({ command: argv.join(' '), output: response.output });
        if (response.exitCode) throw new Error('Agent action refused: ' + argv.join(' ') + '\n' + response.output);
    })) return true;
    if (!context.implemented && ['implementation', 'materialize-planned-scope'].includes(String(result.next_gate))) {
        if (!context.preservedImplementation) applyEdits(context.repoRoot, context.scenario.edits);
        context.preservedImplementation = false;
        context.implemented = true;
        return true;
    }
    const pendingFix = context.fixPending && context.pendingReviewFailure
        ? resolveWalkReviewFix(context.scenario, context.pendingReviewFailure.reviewType, context.pendingReviewFailure.attempt)
        : context.scenario.fix;
    if (context.fixPending && pendingFix) {
        applyEdits(context.repoRoot, pendingFix);
        context.fixPending = false;
        context.pendingReviewFailure = undefined;
        if (context.scenario.qualityRework && context.qualityReworkApplied) {
            const answers = path.join(context.repoRoot, DEFAULT_BUNDLE_NAME, 'runtime/tmp', taskId + '-quality-checklist-answers.json');
            fillQualityAnswers(answers, context.scenario.edits.map(edit => edit.path), context.scenario.fixture);
            const template = JSON.parse(fs.readFileSync(answers, 'utf8')) as { answers: Array<Record<string, unknown>> };
            template.answers[0].actions_taken = ['Documented the focused status change in ' + (context.scenario.fixture ?? NODE_WALK_FIXTURE).primarySource + '.'];
            fs.writeFileSync(answers, JSON.stringify(template, null, 2) + '\n');
        }
        return true;
    }
    if (result.next_gate === 'run-intermediate-command' || result.next_gate === 'project-validation-evidence') {
        const fixture = context.scenario.fixture ?? NODE_WALK_FIXTURE;
        const runs = fixture.taskTestInvocations ?? [{ command: fixture.caseCommand, targets: fixture.cases.map(item => item.source) }];
        for (const invocation of runs) {
            const argv = ['run-intermediate-command', '--task-id', taskId, '--command-source', 'targeted-test',
                '--command', invocation.command,
                ...fixture.cases.filter(item => invocation.targets.includes(item.source))
                    .flatMap(item => ['--selected-case', JSON.stringify(item)]),
                '--preflight-path', DEFAULT_BUNDLE_NAME + '/runtime/reviews/' + taskId + '-preflight.json', '--repo-root', '.'];
            const executed = await runGate(argv);
            (context.steps.at(-1)!.preparation ??= []).push({ command: argv.map(arg => JSON.stringify(arg)).join(' '), output: executed.output });
            if (executed.exitCode !== 0) { context.steps.at(-1)!.output = executed.output; return false; }
        }
        return true;
    }
    const answersPath = result.quality_checklist?.answers_template_path;
    if (result.next_gate === 'quality-checklist' && answersPath) {
        fillQualityAnswers(path.resolve(context.repoRoot, answersPath), context.scenario.edits.map((edit) => edit.path), context.scenario.fixture);
        if (context.scenario.qualityRework && !context.qualityReworkApplied) {
            const file = path.resolve(context.repoRoot, answersPath);
            const template = JSON.parse(fs.readFileSync(file, 'utf8')) as { answers: Array<Record<string, unknown>> };
            template.answers[0].status = 'ACTION_REQUIRED';
            template.answers[0].actions_required = ['Document why the focused status change needs no broader refactor before validation.'];
            fs.writeFileSync(file, JSON.stringify(template, null, 2) + '\n');
            context.qualityReworkApplied = true; context.fixPending = true;
        }
        return true;
    }
    return false;
}

async function runStep(context: WalkContext, step: WalkStep, command: string): Promise<void> {
    const started = performance.now();
    const { value: run, reads } = await captureArtifactReads(context.repoRoot, () => runCommand(command));
    step.reads = reads;
    step.commandMs = performance.now() - started;
    step.exitCode = run.exitCode;
    step.threw = run.threw;
    step.output = run.output.length > 8000 ? run.output.slice(0, 4000) + '\n[...truncated...]\n' + run.output.slice(-2000) : run.output;
    clockOffsetMs += 1;
    if (run.exitCode === 0 && takeDisturbance(context, 'repeat-command', String(step.gate))) {
        await runCommand(command);
        clockOffsetMs += 1;
    }
}

async function walkSteps(context: WalkContext, from = 0, stopAt = -1, checkpoint?: SweepInjection): Promise<{ outcome: WalkOutcome; detail: string }> {
    const { repoRoot, steps } = context;
    const seen = new Set<string>();
    const progress = new WalkProgressGuard(MAX_SAME_COMMAND);
    const pendingArtifacts: SweepDisturbance[] = [];
    let repeats = 0;
    for (let index = from; index < MAX_WALK_STEPS; index += 1) {
        if (index === stopAt) return { outcome: 'agent_stuck', detail: 'Synthetic checkpoint before step ' + index };
        const preparation: NonNullable<WalkStep['preparation']> = [];
        // A reset may recreate handshake before preflight. Apply the whole scheduled batch together so an early
        // corrupted input cannot stop the new cycle before the other scheduled disturbances have taken place.
        if (pendingArtifacts.length && pendingArtifacts.every(disturbance =>
            'artifact' in disturbance && resolveSweepArtifact(repoRoot, disturbance.artifact))) {
            for (const disturbance of pendingArtifacts.splice(0)) {
                mutateSweepFile(repoRoot, disturbance);
                context.applied.push(disturbanceId(disturbance));
                preparation.push({ command: 'apply deferred ' + disturbanceId(disturbance), output: 'Applied after reset recreated all inputs.' });
            }
        }
        await context.scenario.prepare?.(repoRoot, steps, async argv => {
            const run = await runGate(argv);
            preparation.push({ command: argv.join(' '), output: run.output });
            if (run.exitCode) throw new Error('Fixture preparation refused: ' + argv.join(' ') + '\n' + run.output);
        });
        beginRouteObservation();
        const profiler = process.env.GARDA_SYNTHETIC_WALK_DIAGNOSTICS_CPU === '1' && !process.env.GARDA_SYNTHETIC_WALK_DIAGNOSTICS ? new Session() : null;
        if (profiler) {
            profiler.connect();
            await new Promise<void>((resolve, reject) => profiler.post('Profiler.enable', error => error ? reject(error) : resolve()));
            await new Promise<void>((resolve, reject) => profiler.post('Profiler.start', error => error ? reject(error) : resolve()));
        }
        let cpuProfile: string | undefined;
        let navigation: ReturnType<typeof navigate>;
        let failedNavigation: WalkStep | undefined;
        const navigationStarted = performance.now();
        const taskId = context.scenario.inspectTask?.(steps) ?? WALK_TASK_ID;
        try { navigation = navigate(repoRoot, context.scenario.id, taskId, steps); }
        catch (error) {
            failedNavigation = { index, gate: null, status: 'EXCEPTION', route: 'EXCEPTION/navigator', command: null,
                navigatorMs: performance.now() - navigationStarted, commandMs: 0, exitCode: null, output: '',
                reason: error instanceof Error ? error.stack || error.message : String(error), taskEvents: 0,
                workspaceSha256: '', measurement: null, threw: true };
            steps.push(failedNavigation);
            throw error;
        }
        finally {
            if (profiler) {
                const directory = path.join(process.env.GARDA_SYNTHETIC_WALK_REPORT || os.tmpdir(), 'cpu-' + process.pid);
                fs.mkdirSync(directory, { recursive: true });
                cpuProfile = path.join(directory, context.scenario.id + '-' + index + '-' + randomUUID() + '.cpuprofile');
                await new Promise<void>((resolve, reject) => profiler.post('Profiler.stop', (error, value) => {
                    if (error) { reject(error); return; }
                    fs.writeFileSync(cpuProfile!, JSON.stringify(value.profile)); resolve();
                }));
                profiler.disconnect();
                if (failedNavigation) failedNavigation.cpuProfile = cpuProfile;
            }
        }
        const { result, ms, measurement, diagnostic } = navigation;
        context.scenario.inspectNavigation?.(result, steps);
        const launchCommand = result.commands.find((entry) => entry.command.includes('launch_artifact_path'))?.command;
        let command: string | null = launchCommand ?? result.commands[0]?.command ?? null;
        if (context.scenario.unreachableReviewer && result.next_gate === 'record-review-result'
            && result.reason.includes('If your reviewer cannot be reached')) {
            const restart = result.commands.find(entry => entry.command.includes('restart-review-cycle'));
            if (restart) { command = restart.command; result.next_gate = 'restart-review-cycle'; }
        }
        if (context.scenario.preferredOutOfScopeRepair && result.next_gate === 'task-test-selection'
            && result.commands.some(entry => entry.command.includes('materialize-full-suite-repair-task'))) {
            command = result.commands.find(entry => entry.command.includes('materialize-full-suite-repair-task'))?.command ?? command;
            result.next_gate = 'materialize-full-suite-repair-task';
        }
        if (context.scenario.reselectAfterFailure && result.next_gate === 'implementation'
            && context.steps.some(step => step.gate === 'full-suite-validation' && step.exitCode)) {
            const selection = result.commands.find(entry => entry.command.includes('workflow set') && (entry.command.includes('--task-test-command') || entry.command.includes('--full-suite-command')));
            if (selection) { command = selection.command; result.next_gate = 'task-test-selection'; }
        }
        // Intermediate gates accept one command. Multi-invocation test-first scenarios run
        // their RED cycle and later focused GREEN commands separately, recording every call.
        const separateTestFirstRuns = context.scenario.agentExecutesRed
            && ['test-first-expected-failure', 'run-intermediate-command', 'project-validation-evidence'].includes(String(result.next_gate));
        if (separateTestFirstRuns) command = null;
        const lane = command ? argumentValue(command, '--review-type') : '';
        if (command) {
            const fixture = context.scenario.fixture ?? NODE_WALK_FIXTURE;
            const taskCommand = fixture.taskTestInvocations?.map(run => run.command).join(' && ') ?? fixture.caseCommand;
            const substitutions: Record<string, string> = {
                '<task-compile-command>': fixture.compileCommand, '<task-test-command>': taskCommand
            };
            const filled = splitCommandLine(command);
            if (filled.some(arg => Object.hasOwn(substitutions, arg)))
                command = filled.map(arg => JSON.stringify(substitutions[arg] ?? arg)).join(' ');
            const execution = splitCommandLine(command);
            if (execution.includes('run-intermediate-command') && execution.includes('--command') && !execution.includes('--selected-case')) {
                execution.push(...fixture.cases.flatMap(claim => ['--selected-case', JSON.stringify(claim)]));
                command = execution.map(arg => JSON.stringify(arg)).join(' ');
            }
            if (result.next_gate === 'task-test-selection') {
                command = command.replace('<task behavior and regression relationships>',
                    context.scenario.taskTitle ?? (context.scenario.fixture ?? NODE_WALK_FIXTURE).selectionReason
                    ?? (context.scenario.fixture ?? NODE_WALK_FIXTURE).taskTitle);
                // The synthetic agent explicitly chooses its fixture command. Production guidance
                // supplies a placeholder, so the project command is never silently preselected.
                const args = splitCommandLine(command);
                const fixture = context.scenario.fixture ?? NODE_WALK_FIXTURE;
                const selected = context.scenario.testSelectionCommand
                    ?? fixture.taskTestCommand;
                args[args.findIndex(arg => arg === '--task-test-command' || arg === '--full-suite-command') + 1] = selected;
                if (context.scenario.selectionTargets) {
                    for (let i = args.length - 2; i >= 0; i--) if (args[i] === '--focused-required-test-path') args.splice(i, 2);
                    args.push(...context.scenario.selectionTargets.flatMap(target => ['--focused-required-test-path', target]));
                }
                const targets = args.flatMap((arg, index) => arg === '--focused-required-test-path' ? [args[index + 1]] : []);
                const declaration = walkTaskSelectionPlan(selected, targets, fixture, taskId);
                args.push('--task-test-plan', JSON.stringify(declaration));
                command = args.map(arg => JSON.stringify(arg)).join(' ');
            }
            command = fillProviderValues(command, 'walk-' + (lane || 'task') + '-' + String(context.reviewsByLane[lane] ?? 0),
                (context.scenario.remediationSequence ? walkRemediationEdits(context.scenario)
                    : context.scenario.fix ?? context.scenario.edits).map((edit) => edit.path));
            if (context.scenario.separateReviewInvocation && result.next_gate === 'complete-reviewer-launch') {
                command = command.replace(/\s+--record-invocation\b/gu, '');
            }
            if (context.scenario.reviewerAttestation === 'controller') {
                command = command.replaceAll('--provider-invocation-id', '--controller-invocation-id')
                    .replaceAll('test_provider_invocation', 'collaboration.spawn_agent');
            }
            if (context.scenario.reviewerAttestation === 'provider-no-live-receipt') {
                command = command.replaceAll('test_provider_invocation', 'collaboration.spawn_agent')
                    .replace('<provider-controller fail-closed availability: closed|stateless>', 'stateless');
            }
        }
        // A native Git refusal is the result under test. Stand bookkeeping must not ask the same
        // broken Git operation again and hide that returned refusal behind a fixture exception.
        const workspaceSha256 = result.next_gate === 'git-observation'
            ? walkNonGitWorkspaceFingerprint(repoRoot) : hashWorkspace(repoRoot);
        const eventInspection = inspectWalkTaskEvents(repoRoot, taskId);
        const taskEventRecords = eventInspection.events;
        const taskEvents = taskEventRecords.length;
        const step: WalkStep = {
            index, taskId, gate: result.next_gate, status: result.status, command, navigatorMs: ms, commandMs: 0,
            exitCode: null, output: '', reason: result.reason || '', taskEvents, workspaceSha256, measurement,
            counterState: measuredNativeCounterState(admittedCounterState(context.scenario.counterState, taskEventRecords, taskId,
                taskId !== WALK_TASK_ID && context.scenario.counterState?.endsWith('child-tree')
                    ? inspectWalkTaskEvents(repoRoot).events : [],
                context.scenario.counterState?.startsWith('declared-recipe-')
                    ? readProjectValidationAuthority(repoRoot) !== null : false), taskEventRecords, true, taskId),
            ...(eventInspection.error ? { eventReadError: eventInspection.error } : {}),
            ...(preparation.length ? { preparation } : {}),
            ...(diagnostic ? { diagnostic } : {})
        };
        step.routes = reachedRoutePoints(result);
        step.route = result.status + '/' + (result.next_gate ?? (result.status === 'DONE' ? '(done)' : '(none)')) + (lane ? '/' + lane : '');
        step.coreMs = diagnostic?.core_ms ?? measurement?.phases_ms.total ?? ms;
        step.outsideCoreMs = diagnostic?.outside_core_ms ?? Math.max(0, ms - step.coreMs);
        step.cpuProfile = cpuProfile;
        if (checkpoint && walkInjectionDue(checkpoint, index, step.gate, lane)) {
            checkpoint.step = index;
            return { outcome: 'agent_stuck', detail: 'Synthetic checkpoint before ' + step.gate + '/' + lane };
        }
        steps.push(step);
        if (result.status === 'DONE') {
            const afterDone = takeDisturbance(context, 'after-done-edit', '');
            if (afterDone) { applyEdits(repoRoot, [afterDone.edit]); continue; }
            return { outcome: 'done', detail: '' };
        }
        const injection = context.scenario.injection;
        if (injection && !context.injected && walkInjectionDue(injection, index, step.gate, lane)) {
            if (step.gate !== injection.gate) return { outcome: 'agent_stuck', detail: 'Replay diverged before injection: expected ' + injection.gate + ', got ' + step.gate };
            injection.step = index;
            context.injected = true;
            context.approveInjectedRestart = shouldApproveInjectedRestart(injection, taskEventRecords);
            step.disturbances = injection.disturbances.map(disturbanceId);
            // Keep manifest IDs stable, but reset first so subsequent disturbances are not erased by it.
            const ordered = [...injection.disturbances].sort((a, b) => Number(b.kind === 'reset-task') - Number(a.kind === 'reset-task'));
            for (const disturbance of ordered) {
                if (disturbance.kind === 'repeat-last') {
                    const previousCommand = steps.at(-2)?.command;
                    if (!previousCommand) throw new Error('No previous command for repeat disturbance');
                    const repeatedStarted = performance.now(), stateBefore = hashWalkState(repoRoot);
                    const repeat = await runCommand(previousCommand);
                    step.repeatedCommand = { command: previousCommand, ...repeat, ms: performance.now() - repeatedStarted,
                        stateUnchanged: hashWalkState(repoRoot) === stateBefore };
                } else if (disturbance.kind === 'wrong-gate') {
                    // Instead of this step's command the agent runs another real gate with valid arguments,
                    // then goes back to following next-step. Its refusal is not this step's outcome.
                    const argv = wrongGateArgv(disturbance.gate, { taskId,
                        preflightPath: DEFAULT_BUNDLE_NAME + '/runtime/reviews/' + taskId + '-preflight.json',
                        taskIntent: context.scenario.taskTitle ?? (context.scenario.fixture ?? NODE_WALK_FIXTURE).taskTitle,
                        changedFiles: [...context.scenario.edits, ...walkRemediationEdits(context.scenario)].map(edit => edit.path) });
                    const wrongStarted = performance.now();
                    const wrong = await runGate(argv);
                    clockOffsetMs += 1;
                    step.wrongGate = { gate: disturbance.gate, command: 'garda gate ' + argv.join(' '), ...wrong,
                        uncaught: !!wrong.threw && isUncaughtGateError(wrong.output),
                        output: wrong.output.length > 8000 ? wrong.output.slice(0, 4000) + '\n[...truncated...]\n' + wrong.output.slice(-2000) : wrong.output,
                        ms: performance.now() - wrongStarted };
                } else if (disturbance.kind === 'fail-gate') {
                    writeTextFile(path.join(repoRoot, step.gate === 'compile-gate' ? COMPILE_FAILURE_FLAG : FULL_SUITE_FAILURE_FLAG), '');
                } else if (disturbance.kind === 'reset-task') {
                    // The modeled operator grants this one action through Garda's real audited authority.
                    const argv = ['task-reset', '--task-id', taskId, '--to-status', 'TODO', '--confirm', '--one-action',
                        '--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString(), '--repo-root', '.'];
                    const reset = await runGate(argv);
                    (step.preparation ??= []).push({ command: argv.join(' '), output: reset.output });
                    if (reset.exitCode || !isCompletedSweepReset(reset.output)) throw new Error('Operator-authorized task reset failed: ' + reset.output);
                    context.preservedImplementation = context.implemented;
                    context.implemented = false; context.fixPending = false; context.pendingReviewFailure = undefined;
                    context.reviewerLaunchCommands = {};
                } else if ('artifact' in disturbance && ordered.some(entry => entry.kind === 'reset-task')) {
                    // Reset combinations are one batch, including inputs that survived the reset.
                    pendingArtifacts.push(disturbance);
                    continue;
                } else mutateSweepFile(repoRoot, disturbance);
                context.applied.push(disturbanceId(disturbance));
            }
            if (injection.disturbances.length && (!injection.disturbances.some(entry => entry.kind === 'fail-gate')
                || injection.disturbances.some(entry => entry.kind === 'reset-task'))) continue;
        }
        if (result.status === (context.scenario.expectedTerminalStatus ?? 'BLOCKED') && result.next_gate === context.scenario.expectedBlockedGate
            && context.scenario.expectedGuidance?.test(result.reason + ' ' + result.commands.map(entry => entry.command).join(' '))) {
            return { outcome: 'blocked', detail: result.reason };
        }
        const adoption = injection && command && (context.policyAdoptionsApproved ?? 0) < (context.scenario.approvedPolicyAdoptions ?? 1)
            ? approvePolicyAdoption(injection, result.next_gate, command) : null;
        if (adoption) {
            context.policyAdoptionsApproved = (context.policyAdoptionsApproved ?? 0) + 1;
            command = adoption;
            step.command = command;
            step.userApproval = true;
        }
        if (injection && context.injected && result.status === 'BLOCKED' && command
            && command.includes('--operator-confirmed') && /<[^>]+>/u.test(command) && /operator|confirmation/iu.test(result.reason)) {
            return { outcome: 'blocked', detail: result.reason + '\nHuman command after confirmation: ' + command };
        }
        const previous = steps[steps.length - 2];
        repeats = previous && previous.taskId === step.taskId && previous.gate === step.gate && previous.command === step.command ? repeats + 1 : 0;
        // A durable artifact can advance to telemetry recovery without changing workspace or events.
        // Selected source identity distinguishes that real transition; identical-route loops still fail.
        const stateKey = [taskId, result.status, result.next_gate, step.routes?.join(','), command, workspaceSha256, taskEvents].join('|');
        if (seen.has(stateKey) || repeats >= MAX_SAME_COMMAND) {
            return { outcome: 'loop', detail: result.next_gate + ': ' + (previous?.output || result.reason || '') };
        }
        seen.add(stateKey);
        const argv = command ? splitCommandLine(command) : [];
        const action = command ? (argv[argv.indexOf('gate') + 1] ?? 'command') + ':' + argumentValue(command, '--stage') : 'instruction';
        const classification = taskEventRecords.filter(event => event.type === 'PREFLIGHT_CLASSIFIED').at(-1)?.details;
        // Task-declared roles can refine code -> mixed without editing bytes. A stable semantic key permits that
        // one refinement; changing timestamps/hashes or toggling back to an earlier classification keeps its count.
        const classificationKey = JSON.stringify([context.applied, context.scenario.progressBoundary?.(), isPlainRecord(classification?.profile_guardrails)
            ? classification.profile_guardrails.scope_category : null, classification?.code_changed,
        isPlainRecord(classification?.required_reviews) ? Object.entries(classification.required_reviews).sort(([a], [b]) => a.localeCompare(b)) : []]);
        if (progress.observe(workspaceSha256, step.gate, lane, action, taskId, classificationKey)) {
            return { outcome: 'loop', detail: 'Repeated ' + step.gate + ' without a workspace change across recovery cycles. ' + step.reason };
        }
        const lateEdit = takeDisturbance(context, 'late-edit', String(result.next_gate));
        if (lateEdit) {
            const editedPath = path.join(repoRoot, lateEdit.edit.path);
            if (!context.lateEditOriginals.has(lateEdit.edit.path)) {
                context.lateEditOriginals.set(lateEdit.edit.path, fs.existsSync(editedPath) ? fs.readFileSync(editedPath, 'utf8') : null);
            }
            applyEdits(repoRoot, [lateEdit.edit]);
            // The agent edited instead of running this step's command, so the step was not taken.
            seen.delete(stateKey);
            continue;
        }
        if (command && isReviewRestartApprovalRequest(result, command)) {
            // Only an injected edit after the passed review gate gets the modeled user's approval (decision 5).
            if (context.scenario.approveReviewRestart || context.approveInjectedRestart) {
                // The user approved the new review cycle; the agent fills in the time of that approval.
                command = command.replace(REVIEW_RESTART_APPROVAL_PLACEHOLDER, new Date().toISOString());
                step.command = command;
                step.userApproval = true;
            } else if (context.lateEditOriginals.size > 0) {
                if (context.scenario.tryRestartWithoutApproval && !step.unapprovedRestart) {
                    // A careless agent drops the approval options. The gate must refuse before any state change.
                    const unapproved = command.replace(/\s--review-restart-approved(?:-at-utc)?\s+(?:"[^"]*"|'[^']*'|\S+)/gu, '');
                    step.unapprovedRestart = { command: unapproved, ...await runCommand(unapproved) };
                }
                // Follow the guidance: revert the change made after the reviews passed and keep closing.
                for (const [relative, original] of context.lateEditOriginals) {
                    if (original === null) fs.rmSync(path.join(repoRoot, relative), { force: true });
                    else writeTextFile(path.join(repoRoot, relative), original);
                }
                context.lateEditOriginals.clear();
                step.reverted = true;
                continue;
            } else {
                return { outcome: 'blocked', detail: result.next_gate + ': ' + result.reason };
            }
        }
        if (injection && needsInjectedImplementation(context.applied, context.implemented, result.next_gate)) {
            // An injected edit can make next-step advance before the scenario's planned implementation.
            // The agent still performs the task's planned work once; preserved implementation is not duplicated.
            const preserved = context.preservedImplementation;
            if (!preserved) applyEdits(repoRoot, context.scenario.edits);
            context.implemented = true; context.preservedImplementation = false;
            if (!preserved && context.scenario.edits.length) { seen.delete(stateKey); continue; }
        }
        if (!command || (!splitCommandLine(command).includes('gate') && result.next_gate !== 'task-test-selection')) {
            if (isDeadEnd(result)) return { outcome: 'dead_end', detail: result.next_gate + ': ' + result.reason };
            const action = await captureArtifactReads(repoRoot, () => actWithoutGate(context, result));
            step.reads = action.reads;
            if (action.value) {
                if (separateTestFirstRuns) {
                    step.exitCode = 0;
                    step.output = result.next_gate === 'test-first-expected-failure'
                        ? 'Executed each declared RED command separately.' : 'Executed each declared focused command separately.';
                }
                continue;
            }
            if (injection && context.injected && result.status === 'BLOCKED' && hasHumanRecovery(result.reason)) return { outcome: 'blocked', detail: result.reason };
            return { outcome: 'agent_stuck', detail: result.next_gate + ': ' + result.reason + (step.output ? '\n' + step.output : '') };
        }
        if (result.next_gate === 'next-step-effect') {
            const planSha256 = /--effect-plan-sha256\s+["']?([a-f0-9]{64})/u.exec(command)?.[1] || '';
            const started = performance.now();
            beginRouteObservation();
            try {
                const executed = await captureArtifactReads(repoRoot, async () => executeNextStepEffects({ taskId, repoRoot }, planSha256));
                const effect = executed.value;
                step.reads = executed.reads;
                step.effectResult = { gate: effect.next_gate, status: effect.status,
                    route: effect.status + '/' + (effect.next_gate ?? '(done)'), routes: reachedRoutePoints(effect), reason: effect.reason };
                step.exitCode = 0;
                if (effect.status === (context.scenario.expectedTerminalStatus ?? 'BLOCKED')
                    && effect.next_gate === context.scenario.expectedBlockedGate
                    && context.scenario.expectedGuidance?.test(effect.reason + ' ' + effect.commands.map(entry => entry.command).join(' '))) {
                    return { outcome: 'blocked', detail: effect.reason };
                }
            } catch (error) {
                step.threw = true; step.exitCode = 1; step.output = error instanceof Error ? error.stack || error.message : String(error);
                if (isWalkEffectReinspection(error)) { step.effectReinspection = true; continue; }
                if (injection && hasHumanRecovery(step.output, 'next-step-effect')) return { outcome: 'blocked', detail: step.output };
                throw error;
            } finally { step.commandMs = performance.now() - started; }
            continue;
        }
        // The calling agent obtains the corrected file from its original reviewer before recording it.
        if (command.includes('--review-output-stdin') ||
            (command.includes('--correction-producer-identity') && result.reason.includes('First record the corrected response using:'))) {
            const corrected = await continueReviewer(context, command, lane, result.reason);
            if (!corrected) return { outcome: 'agent_stuck', detail: result.next_gate + ': ' + result.reason + ' ' + (previous?.output ?? '') };
            command = corrected;
            step.command = command;
        }
        if (context.fixPending && result.next_gate === 'restart-review-cycle') await actWithoutGate(context, result);
        if (result.next_gate === 'complete-reviewer-launch'
            && !result.reason.includes('durable launched control artifact')) completeReviewer(context, command, lane);
        if (result.next_gate === 'enter-task-mode' && context.applied.includes('reset-task')) {
            // The modeled operator knows the task-owned files it is reopening, including the injected edits.
            command += resetPlannedFiles(context.scenario).map(file => ' --planned-changed-file ' + JSON.stringify(file)).join('');
            step.command = command;
        }
        if (context.scenario.execute) {
            const started = performance.now();
            if (await context.scenario.execute(repoRoot, step)) {
                step.commandMs = performance.now() - started;
                continue;
            }
        }
        await runStep(context, step, command);
        if (adoption && step.exitCode === 0) progress.adoptReviewPolicy(taskId,
            argumentValue(command, '--adopt-changed-review-policy'));
        if (step.gate === 'record-reviewer-delegation-started' && step.exitCode === 0) beginReviewer(context, command, lane, step.index);
        // A changed review policy is resolved through the navigator's adoption route, where the modeled user approves.
        if (injection && isReviewPolicyRefusal(injection, step)) continue;
        // A reset needs operator confirmation the synthetic agent does not have. The navigator's preview must
        // run cleanly; the walk then ends at that explicit operator handoff instead of re-reading the same step.
        if (injection && context.injected && isOperatorResetHandoff(result, command) && step.exitCode === 0) {
            return { outcome: 'blocked', detail: result.reason + '\nOperator reset preview: ' + command };
        }
        // Agent-executable recovery returns to next-step; only a human handoff ends the walk.
        const scopedResetPreflight = isScopedResetPreflight(context.scenario, context.applied, step);
        if (step.exitCode && !scopedResetPreflight && hasHumanRecovery(step.output, step.gate ?? undefined)
            && (injection || isExpectedWalkRefusal(context.scenario, step))) {
            return { outcome: 'blocked', detail: step.output };
        }
    }
    return { outcome: 'step_limit', detail: '' };
}

/** The POST_PREFLIGHT refusal of a changed review policy; the navigator then offers its adoption route. */
export function isReviewPolicyRefusal(injection: SweepInjection, step: WalkStep): boolean {
    return injection.disturbances.some(entry => entry.kind === 'change-policy') && step.gate === 'load-rule-pack'
        && !!step.exitCode && /Task profile policy inputs changed after preflight/u.test(step.output);
}

/**
 * The documented route of an approved review-policy change: the policy frozen at task entry refuses the change (C6.1.1),
 * and the operator-approved adoption re-enters task mode, keeping passed reviews (C6.2.4). Only that refusal, answered by
 * a successful adoption as the next executed command, belongs to the route; any other failure stays a finding.
 */
export function isAdoptedReviewPolicyRefusal(injection: SweepInjection | undefined, steps: readonly WalkStep[], step: WalkStep): boolean {
    if (!injection || !isReviewPolicyRefusal(injection, step)) return false;
    const next = steps.find(candidate => candidate.index > step.index && candidate.command);
    return next?.gate === 'enter-task-mode' && next.exitCode === 0 && /\s--adopt-changed-review-policy\s/u.test(next.command ?? '');
}

const OPERATOR_CONFIRMATION_TIME_PLACEHOLDER = '<ISO-8601 timestamp>';

/**
 * The modeled user made the policy change and approves adopting the lane changes the navigator shows, once.
 * The agent fills in the time of that approval in the navigator's own adoption command, digest included.
 */
export function approvePolicyAdoption(injection: SweepInjection, nextGate: string | null, command: string,
    approvedAtUtc = new Date().toISOString()): string | null {
    if (nextGate !== 'enter-task-mode' || !injection.disturbances.some(entry => entry.kind === 'change-policy')
        || !/\s--adopt-changed-review-policy\s+"?[a-f0-9]{64}"?\s/u.test(command)
        || !command.includes(OPERATOR_CONFIRMATION_TIME_PLACEHOLDER)) return null;
    return command.replace(OPERATOR_CONFIRMATION_TIME_PLACEHOLDER, approvedAtUtc);
}

/** Finish the task's planned work if an early injected edit made navigation skip the implementation prompt. */
export function needsInjectedImplementation(applied: readonly string[], implemented: boolean, nextGate: string | null): boolean {
    return !implemented && applied.some(id => id === 'reset-task' || id.split(':')[0] in SWEEP_EDITS)
        && ['quality-checklist', 'project-validation-evidence', 'run-intermediate-command', 'compile-gate',
            'full-suite-validation', 'build-review-context', 'required-reviews-check', 'project-memory-impact',
            'doc-impact-gate', 'completion-gate'].includes(String(nextGate));
}

/** A user approves only a workspace edit made after the current review gate passed. */
export function shouldApproveInjectedRestart(injection: SweepInjection, events: WalkResult['events']): boolean {
    if (injection.disturbances.some(entry => entry.kind === 'reset-task')
        || !injection.disturbances.some(entry => entry.kind in SWEEP_EDITS || entry.kind === 'change-criteria' || entry.kind === 'change-policy')) return false;
    const lastIndex = (types: readonly string[]) => events.reduce((index, event, current) => types.includes(event.type) ? current : index, -1);
    const passed = lastIndex(['REVIEW_GATE_PASSED', 'REVIEW_GATE_PASSED_WITH_OVERRIDE']);
    const restarted = lastIndex(['REVIEW_CYCLE_RESTARTED', 'COHERENT_CYCLE_RESTARTED', 'TASK_RESET', 'IMPLEMENTATION_STARTED']);
    return passed >= 0 && passed > restarted;
}

/** Damaged authority may require an operator to repair integrity; recoverable evidence must continue to DONE. */
export function isAllowedSweepHandoff(injection: SweepInjection, detail: string): boolean {
    if (injection.disturbances.length === 0) return hasHumanRecovery(detail);
    const damaged = injection.disturbances.filter(entry => 'artifact' in entry);
    const lanes = [...REVIEW_LANES, ...injection.economy?.reviews.map(review => review.lane) ?? []];
    const lostLaunchAuthority = damaged.some(entry => 'artifact' in entry && entry.artifact.kind === 'launch'
        && /\/runtime\/tmp\/reviews\/T-WALK\/[a-z][a-z0-9-]*\/reviewer-launch\.json(?:\.lane-reservation\.json)?$/u
            .test(entry.artifact.path.replace(/\\/gu, '/')));
    if (lostLaunchAuthority && /Ask the operator to reset this task with task-reset and enter it again\./u.test(detail)
        && /Do not reconstruct missing or corrupt launch-control or lane-reservation evidence\./u.test(detail)) return true;
    return damaged.some(entry => 'artifact' in entry && !artifactLane(entry.artifact.path, lanes)
        && /\/runtime\/(?:task-events\/|reviews\/T-WALK-(?:task-mode|task-history|cadence-head)(?:[.-]|$))/iu
            .test(entry.artifact.path.replace(/\\/gu, '/')))
        && /\b(?:evidence|artifact|integrity|history|task.events|receipt|report)\b/iu.test(detail)
        && /\b(?:restore|repair|preserve|reset|isolate)\b/iu.test(detail) && hasHumanRecovery(detail);
}

/** An inactive code-review lane is a safety floor; only reverting or an operator reset can lift it. */
function isSafetyFloorHandoff(scenario: WalkScenario, result: WalkResult): boolean {
    const last = result.steps.at(-1);
    if (result.outcome !== 'blocked' || last?.gate !== 'classify-change' || !last.exitCode || result.detail !== last.output) return false;
    const codeRoles: readonly string[] = ['production', 'new-production', 'protected'];
    const codeEdits = Object.entries(SWEEP_EDITS).filter(([, edit]) => codeRoles.includes(edit.role));
    const injectedCode = scenario.injection?.disturbances.some(entry => codeEdits.some(([kind]) => kind === entry.kind)
        && result.sweep?.applied.includes(disturbanceId(entry)));
    const plannedCode = result.steps.some(step => ['implementation', 'materialize-planned-scope'].includes(String(step.gate)))
        && scenario.edits.some(edit => codeEdits.some(([, code]) => code.path === edit.path));
    if (!injectedCode && !plannedCode) return false;
    return /The code-review safety floor cannot be satisfied because the configured code-review lane is inactive\./u.test(last.output)
        && /Revert the code edit so the task stays within its profile/u.test(last.output)
        && /ask the operator to reset the task \(garda gate task-reset\) and enter it again with a profile whose review policy includes the code review\./u
            .test(last.output);
}

/** The reset operator has already supplied the bounded scope needed to recover this preflight. */
function isScopedResetPreflight(scenario: WalkScenario, applied: readonly string[], step: WalkStep): boolean {
    return applied.includes('reset-task') && step.gate === 'classify-change'
        && /Workspace already contained modified files before task-mode entry:/u.test(step.output)
        && resetPlannedFiles(scenario).length > 0;
}

/** A declared fault must reach its exact refused gate and concrete recovery, not just any failure. */
export function isExpectedWalkRefusal(scenario: WalkScenario, step: WalkStep): boolean {
    return !!scenario.disturbanceReason && !!step.exitCode && step.status === 'BLOCKED'
        && scenario.expectedBlockedGate === step.gate && !!scenario.expectedGuidance?.test(step.output)
        && hasHumanRecovery(step.output, step.gate ?? undefined);
}

const REVIEW_RESTART_APPROVAL_PLACEHOLDER = '<ISO-8601 timestamp of the user approval>';

/** BLOCKED on a restart whose command waits for the user's approval of a new review cycle after the review gate. */
export function isReviewRestartApprovalRequest(result: Pick<ReturnType<typeof resolveNextStep>, 'status' | 'next_gate'>, command: string): boolean {
    return result.status === 'BLOCKED' && ['restart-coherent-cycle', 'restart-review-cycle'].includes(String(result.next_gate))
        && splitCommandLine(command).includes('--review-restart-approved') && command.includes(REVIEW_RESTART_APPROVAL_PLACEHOLDER);
}

/** BLOCKED on task-reset whose only command is a dry-run preview and whose reason asks the operator to reset. */
export function isOperatorResetHandoff(result: Pick<ReturnType<typeof resolveNextStep>, 'status' | 'next_gate' | 'reason'>, command: string): boolean {
    const argv = splitCommandLine(command);
    return result.status === 'BLOCKED' && result.next_gate === 'task-reset' && argv[argv.indexOf('gate') + 1] === 'task-reset'
        && argv.includes('--dry-run') && !argv.includes('--confirm') && hasHumanRecovery(result.reason, 'task-reset');
}

/** The T-403 dead end: blocked with neither a command nor an instruction. */
export function isDeadEnd(result: Pick<ReturnType<typeof resolveNextStep>,
    'status' | 'next_gate' | 'task_id' | 'navigator_command' | 'commands' | 'reason'>): boolean {
    const instruction = buildNextStepInstruction(result);
    return result.status === 'BLOCKED' && result.commands.length === 0
        && (!instruction || (!result.reason.trim() && instruction.startsWith('do what Reason says')));
}

export async function walkTask(templateRoot: string, scenario: WalkScenario): Promise<WalkResult> {
    return (await walkTaskFamily(templateRoot, scenario))[0];
}

/** A family shares one exact prefix and restores the same absolute fixture path for each variant. */
export async function walkTaskFamily(templateRoot: string, scenario: WalkScenario, variants: WalkScenario[] = [],
    onResult?: (result: WalkResult) => void): Promise<WalkResult[]> {
    // A standalone synthetic repository must not inherit the caller's Git config/index/worktree overrides.
    // This is fixture isolation: the real key-creation check stays enabled and runs against native Git metadata.
    const inherited = Object.entries(process.env).filter(([name]) => /^(?:GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_INDEX_FILE|GIT_CONFIG(?:_|$))/iu.test(name));
    for (const [name] of inherited) delete process.env[name];
    // enter-task-mode schedules the advisory update check in a detached process that renews its lease in the
    // fixture's runtime/update-availability while the walk copies, measures and removes that fixture. The stand
    // exercises no network transport, so the documented opt-out keeps that unrelated writer out of the fixture.
    const updateCheck = process.env[UPDATE_CHECK_OPT_OUT_ENV];
    process.env[UPDATE_CHECK_OPT_OUT_ENV] = '0';
    try { return await walkIsolatedTaskFamily(templateRoot, scenario, variants, onResult); }
    finally {
        for (const [name, value] of inherited) process.env[name] = value;
        if (updateCheck === undefined) delete process.env[UPDATE_CHECK_OPT_OUT_ENV];
        else process.env[UPDATE_CHECK_OPT_OUT_ENV] = updateCheck;
    }
}

async function walkIsolatedTaskFamily(templateRoot: string, scenario: WalkScenario, variants: WalkScenario[],
    onResult?: (result: WalkResult) => void): Promise<WalkResult[]> {
    const started = performance.now();
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-walk-'));
    if (scenario.windowsAclInput === 'inherited-trusted') prepareEmptyWalkWindowsAcl(repoRoot);
    fs.cpSync(templateRoot, repoRoot, { recursive: true });
    if (scenario.customLane) {
        writeTextFile(path.join(repoRoot, DEFAULT_BUNDLE_NAME, 'live/config/review-catalog.json'), JSON.stringify({
            version: 1, custom_review_types: [{ id: 'custom-quality', display_label: 'Custom quality', enabled_by_default: false,
                skill_id: 'code-review', trigger: { mode: 'signals', signal_ids: ['path:app'] },
                coverage_category_ids: ['maintainability'], reviewer_role: { role_id: 'quality-reviewer', focus_tags: ['maintainability'] } }]
        }) + '\n');
        const pathsConfigPath = path.join(repoRoot, DEFAULT_BUNDLE_NAME, 'live/config/paths.json');
        const pathsConfig = JSON.parse(fs.readFileSync(pathsConfigPath, 'utf8')) as { triggers: Record<string, string[]> };
        pathsConfig.triggers['custom-quality'] = ['^' + (scenario.fixture ?? NODE_WALK_FIXTURE).primarySource.replaceAll('.', '[.]') + '$'];
        writeTextFile(pathsConfigPath, JSON.stringify(pathsConfig) + '\n');
        const capabilitiesPath = path.join(repoRoot, DEFAULT_BUNDLE_NAME, 'live/config/review-capabilities.json');
        const capabilities = JSON.parse(fs.readFileSync(capabilitiesPath, 'utf8'));
        capabilities['custom-quality'] = true;
        writeTextFile(capabilitiesPath, JSON.stringify(capabilities) + '\n');
    }
    if (scenario.mode || scenario.fullSuitePlacement) {
        const configPath = path.join(repoRoot, DEFAULT_BUNDLE_NAME, 'live/config/workflow-config.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { review_execution_policy: { mode: string }; full_suite_validation: { placement: string } };
        if (scenario.mode) config.review_execution_policy.mode = scenario.mode;
        if (scenario.fullSuitePlacement) config.full_suite_validation.placement = scenario.fullSuitePlacement;
        writeTextFile(configPath, JSON.stringify(config, null, 2) + '\n');
    }
    if (scenario.requiredLanes || scenario.reviewOrder || scenario.dependencyGraph) {
        const profilesPath = path.join(repoRoot, DEFAULT_BUNDLE_NAME, 'live/config/profiles.json');
        const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')) as { built_in_profiles: { balanced: {
            review_policy: Record<string, unknown>;
            review_remediation_mode_policy: { delta_eligible_review_types: string[] };
            review_dependency_graph?: { preparation_order: string[]; dependencies: Record<string, string[]> };
        } } };
        for (const lane of scenario.requiredLanes ?? []) profiles.built_in_profiles.balanced.review_policy[lane] = true;
        if (scenario.customLane) {
            profiles.built_in_profiles.balanced.review_remediation_mode_policy.delta_eligible_review_types.push('custom-quality');
            profiles.built_in_profiles.balanced.review_remediation_mode_policy.delta_eligible_review_types.sort();
        }
        if (scenario.reviewOrder) profiles.built_in_profiles.balanced.review_dependency_graph = {
            preparation_order: scenario.reviewOrder,
            dependencies: Object.fromEntries(scenario.reviewOrder.map((lane) => [lane, []]))
        };
        if (scenario.dependencyGraph) profiles.built_in_profiles.balanced.review_dependency_graph = scenario.dependencyGraph;
        writeTextFile(profilesPath, JSON.stringify(profiles, null, 2) + '\n');
    }
    if (scenario.profile) {
        const queuePath = path.join(repoRoot, 'TASK.md');
        writeTextFile(queuePath, fs.readFileSync(queuePath, 'utf8').replace('| balanced |', '| ' + scenario.profile + ' |'));
    }
    if (scenario.trackedFiles !== undefined) {
        const scaffold = runGit(repoRoot, ['ls-files']).stdout.trim().split(/\r?\n/u).filter(file => ![(scenario.fixture ?? NODE_WALK_FIXTURE).primarySource, (scenario.fixture ?? NODE_WALK_FIXTURE).primaryTest].includes(file));
        fs.appendFileSync(path.join(repoRoot, '.git/info/exclude'), '\n' + scaffold.map(file => '/' + file).join('\n') + '\n');
        runGit(repoRoot, ['rm', '--cached', '--', ...scaffold]);
        for (let index = 2; index < scenario.trackedFiles; index++) writeTextFile(path.join(repoRoot, 'size-fixture', String(index) + '.ts'), 'export {};\n');
        if (scenario.trackedFiles > 2) runGit(repoRoot, ['add', 'size-fixture']);
        runGit(repoRoot, ['commit', '-qm', 'Seed project size fixture']);
        if (runGit(repoRoot, ['ls-files']).stdout.trim().split(/\r?\n/u).length !== scenario.trackedFiles) throw new Error('Project-size fixture tracked-file count is wrong');
    }
    if (scenario.taskTitle || scenario.taskNotes) {
        const file = path.join(repoRoot, 'TASK.md');
        writeTextFile(file, fs.readFileSync(file, 'utf8')
            .replace((scenario.fixture ?? NODE_WALK_FIXTURE).taskTitle, scenario.taskTitle ?? (scenario.fixture ?? NODE_WALK_FIXTURE).taskTitle)
            .replace('Synthetic navigator walk.', scenario.taskNotes ?? 'Synthetic navigator walk.'));
    }
    scenario.configure?.(repoRoot);
    if (scenario.configure || scenario.mode || scenario.requiredLanes || scenario.reviewOrder || scenario.dependencyGraph || scenario.fullSuitePlacement || scenario.profile) {
        const taskQueue = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        runAgentInit({
            targetRoot: repoRoot, activeAgentFiles: 'AGENTS.md', projectRulesUpdated: 'yes', skillsPrompted: 'yes',
            ordinaryDocPaths: 'CHANGELOG.md', verifyRunner: () => ({ passed: true }), manifestRunner: () => ({ passed: true })
        });
        writeTextFile(path.join(repoRoot, 'TASK.md'), taskQueue);
    }
    scenario.setup?.(repoRoot);
    const originalCwd = process.cwd();
    const context: WalkContext = {
        repoRoot, scenario, steps: [], reviewsByLane: {}, reviewerLaunchCommands: {}, reviews: [],
        disturbances: [...scenario.disturbances ?? []], implemented: false, fixPending: false, injected: false, applied: [], qualityReworkApplied: false,
        lateEditOriginals: new Map()
    };
    if (context.disturbances.some((entry) => entry.kind === 'fail-compile')) writeTextFile(path.join(repoRoot, COMPILE_FAILURE_FLAG), '');
    if (context.disturbances.some((entry) => entry.kind === 'fail-full-suite')) writeTextFile(path.join(repoRoot, FULL_SUITE_FAILURE_FLAG), '');
    // The project's own tests run as plain child processes, not as children of this test.
    const testContext = process.env.NODE_TEST_CONTEXT;
    delete process.env.NODE_TEST_CONTEXT;
    process.chdir(repoRoot);
    try {
        return await withShiftedClock(async () => {
            if (scenario.foreignTask) {
                const foreign = await runGate(['enter-task-mode', '--task-id', 'T-FOREIGN', '--provider', 'Codex', '--entry-mode', 'EXPLICIT_TASK_EXECUTION',
                    '--requested-depth', '2', '--task-summary', 'Other work', '--planned-changed-file', 'src/other.ts', '--repo-root', '.']);
                if (foreign.exitCode) throw new Error('Foreign task fixture failed: ' + foreign.output);
            }
            const finish = async (active: WalkContext, from = 0): Promise<WalkResult> => {
                const continuationStarted = performance.now();
                let outcome: WalkOutcome, detail: string;
                try { ({ outcome, detail } = await walkSteps(active, from)); }
                catch (error) { outcome = 'exception'; detail = error instanceof Error ? error.stack || error.message : String(error); }
                const eventInspection = inspectWalkTaskEvents(repoRoot, active.scenario.inspectTask?.(active.steps) ?? WALK_TASK_ID);
                const events = eventInspection.events;
                const disturbances = scenarioDisturbanceLabels(active.scenario);
                const injection = active.scenario.injection;
                return { scenarioId: active.scenario.id, counterState: active.scenario.counterState, outcome, detail, steps: active.steps, reviewsByLane: active.reviewsByLane, reviews: active.reviews, events,
                    ...(disturbances.length ? { disturbances } : {}),
                    ...(eventInspection.error ? { eventReadError: eventInspection.error } : {}),
                    elapsedMs: performance.now() - (variants.length ? continuationStarted : started), trackedFiles: active.scenario.trackedFiles,
                    ...(injection ? { sweep: { ...injection, disturbances: injection.disturbances.map(disturbanceId), applied: active.applied } } : {}) };
            };
            if (!variants.length) {
                const result = await finish(context);
                try { scenario.inspectResult?.(repoRoot, result); }
                catch (error) { result.outcome = 'exception'; result.detail = [result.detail, 'Fixture oracle: ' + String(error)].filter(Boolean).join('\n'); }
                onResult?.(result);
                return [result];
            }
            const selected = variants[0].injection!;
            if (selected.checkpoint) {
                if (variants.some(entry => entry.injection?.gate !== selected.gate
                    || JSON.stringify(entry.injection.checkpoint) !== JSON.stringify(selected.checkpoint))) throw new Error('A named checkpoint family must use the same gate/lane');
                selected.step = -1;
            }
            const prefix = await walkSteps(context, 0, selected.checkpoint ? -1 : selected.step, selected.checkpoint ? selected : undefined);
            const target = selected.step;
            if (target < 0 || context.steps.length !== target) throw new Error('Baseline stopped before checkpoint: ' + prefix.detail);
            if (selected.checkpoint) for (const variant of variants) variant.injection!.step = target;
            const checkpoint = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-walk-checkpoint-'));
            const checkpointClock = clockOffsetMs;
            fs.cpSync(repoRoot, checkpoint, { recursive: true, preserveTimestamps: true });
            const results: WalkResult[] = [];
            try {
                restoreWalkCheckpoint(checkpoint, repoRoot);
                const control: WalkContext = { ...context,
                    scenario: { ...scenario, id: 'checkpoint-control-' + scenario.id + '-s' + target, injection: undefined },
                    steps: structuredClone(context.steps), reviewsByLane: { ...context.reviewsByLane },
                    reviewerLaunchCommands: { ...context.reviewerLaunchCommands }, reviews: structuredClone(context.reviews),
                    disturbances: structuredClone(context.disturbances), injected: false, applied: [] };
                const controlResult = await finish(control, target);
                controlResult.checkpointControl = { baseline: scenario.id, step: target };
                onResult?.(controlResult);
                if (controlResult.outcome !== 'done') throw new Error('Checkpoint control failed before disturbances at ' + target + ': ' + controlResult.detail);
                results.push(controlResult);
                for (const variant of variants) {
                    if (variant.injection?.step !== target) throw new Error('A checkpoint family must use the same step');
                    // Preserve the fixture root's native identity: authenticated history binds to its inode as
                    // well as its absolute path. Only restore children of this mkdtemp-created root.
                    if (!path.basename(repoRoot).startsWith('garda-walk-') || path.dirname(repoRoot) !== os.tmpdir()) throw new Error('Unsafe fixture restore path');
                    restoreWalkCheckpoint(checkpoint, repoRoot);
                    clockOffsetMs = checkpointClock;
                    const active: WalkContext = { ...context, scenario: variant,
                        steps: structuredClone(context.steps), reviewsByLane: { ...context.reviewsByLane },
                        reviewerLaunchCommands: { ...context.reviewerLaunchCommands }, reviews: structuredClone(context.reviews),
                        disturbances: structuredClone(context.disturbances), injected: false, applied: [] };
                    if (results.length) for (const step of active.steps) step.reusedPrefix = true;
                    const result = await finish(active, target);
                    onResult?.(result);
                    results.push(result);
                }
                return results;
            } finally { removeWalkDirectory(checkpoint); }
        });
    } finally {
        if (testContext !== undefined) process.env.NODE_TEST_CONTEXT = testContext;
        process.chdir(originalCwd);
        try { await scenario.cleanup?.(repoRoot); }
        finally { removeWalkDirectory(repoRoot); }
    }
}

/** What the walk did against what the scenario expects; every finding is a stable id. */
export function compareWalk(scenario: WalkScenario, result: WalkResult): StandFinding[] {
    observeStandOracle('navigator-oracle');
    const findings: StandFinding[] = [];
    const add = (kind: StandFinding['kind'], id: string, summary: string, step = result.steps.at(-1), extra: Record<string, unknown> = {}) => findings.push({ layer: 'walk', kind, id, summary, detail: {
        route: step?.route ?? '(setup)', step: step?.index ?? -1,
        replay: (scenario.injection ? 'GARDA_SYNTHETIC_SEED=' + scenario.injection.seed + ' ' : '')
            + 'GARDA_SYNTHETIC_WALK_ONLY=' + scenario.id,
        ...extra
    } });
    if (result.outcome === 'done' && scenario.expectedDoneGuidance
        && !scenario.expectedDoneGuidance.test(result.steps.at(-1)?.reason || '')) {
        add('contract', 'walk:done-guidance:' + scenario.id, 'DONE must disclose the recorded out-of-scope failures.');
    }
    if (result.eventReadError && result.outcome === 'done' || result.steps.some(step => step.eventReadError && step.status === 'DONE')) {
        add('safety', 'walk:accepted-corrupt-events:' + scenario.id, 'Native DONE cannot be accepted with unreadable task events: ' + (result.eventReadError ?? 'see step diagnostics'));
    }
    const physicalStep = result.steps.at(-1);
    const last = physicalStep?.effectResult ?? physicalStep;
    const expectedHandoff = scenario.expectedBlockedGate !== undefined;
    const reachedHandoff = !!last && result.outcome === 'blocked' && last.gate === scenario.expectedBlockedGate
        && last.status === (scenario.expectedTerminalStatus ?? 'BLOCKED')
        && scenario.expectedGuidance?.test(result.detail + ' ' + (physicalStep?.command ?? ''));
    const safetyFloorHandoff = !!scenario.injection && isSafetyFloorHandoff(scenario, result);
    const acceptedBlock = result.outcome === 'blocked' && (safetyFloorHandoff || expectedHandoff && reachedHandoff
        || scenario.injection && isAllowedSweepHandoff(scenario.injection, result.detail));
    if (expectedHandoff && !reachedHandoff) add('contract', 'walk:missing-handoff:' + scenario.id,
        'Expected ' + (scenario.expectedTerminalStatus ?? 'BLOCKED') + '/' + scenario.expectedBlockedGate + ' with its specific recovery guidance.');
    for (const gate of scenario.expectedGates ?? []) {
        if (!result.steps.some(step => step.gate === gate || step.effectResult?.gate === gate)) {
            add('contract', 'walk:missing-route:' + scenario.id + ':' + gate, 'Expected to visit ' + gate + ' before the terminal outcome.');
        }
    }
    for (const route of scenario.expectedRoutes ?? []) {
        if (!result.steps.some(step => step.routes?.includes(route) || step.effectResult?.routes.includes(route))) {
            add('contract', 'walk:missing-source-route:' + scenario.id + ':' + route,
                'Expected the selected navigator decision to reach ' + route + '.');
        }
    }
    const injection = scenario.injection;
    const ignoredRefusal = injection && ['loop', 'agent_stuck', 'step_limit'].includes(result.outcome)
        ? result.steps.find(step => !step.reusedPrefix && step.index >= injection.step && step.exitCode
            && hasHumanRecovery(step.output, step.gate ?? undefined)
            && !isScopedResetPreflight(scenario, result.sweep?.applied ?? [], step)) : undefined;
    const terminal = result.steps.at(-1);
    const ignoredInstruction = injection && result.outcome === 'agent_stuck' && terminal?.status === 'BLOCKED'
        && !terminal.command && hasHumanRecovery(terminal.reason) ? terminal : undefined;
    const routineMustFinish = injection?.disturbances.length && result.outcome !== 'done' && !safetyFloorHandoff
        && injection.disturbances.every(entry => entry.kind in SWEEP_EDITS || entry.kind.startsWith('edit-')
            || ['repeat-last', 'fail-gate', 'wrong-gate', 'change-criteria', 'change-policy', 'reset-task', 'stale-lock'].includes(entry.kind));
    const addOperatorStop = () => {
        const kinds = [...new Set(injection!.disturbances.map(entry => entry.kind))].sort().join('+');
        add('safety', 'walk:operator-stop:' + kinds + ':' + scenario.id, 'Disturbed walk did not reach DONE: ' + result.detail,
            undefined, { disturbances: injection!.disturbances.map(disturbanceId), stopText: result.detail });
    };
    // Routine disturbances must reach DONE, except at the explicit code-review safety floor.
    if (routineMustFinish) addOperatorStop();
    if (ignoredRefusal) {
        add('contract', 'walk:ignored-refusal:' + scenario.id, 'The stand continued after an actionable integrity refusal.', ignoredRefusal,
            { classification: 'stand', refusalOutput: ignoredRefusal.output });
    } else if (ignoredInstruction) {
        add('contract', 'walk:ignored-instruction:' + scenario.id, 'The stand did not recognize an actionable human handoff.', ignoredInstruction,
            { classification: 'stand', instruction: ignoredInstruction.reason });
    } else if (result.outcome === 'blocked' && injection?.disturbances.length && !acceptedBlock) {
        if (!routineMustFinish) addOperatorStop();
    } else if (result.outcome !== 'done' && !acceptedBlock) add('safety', 'walk:outcome:' + result.outcome + ':' + scenario.id, result.detail.slice(0, 400));
    if (scenario.injection) {
        const expected = scenario.injection.disturbances.map(disturbanceId);
        if (expected.some(id => !result.sweep?.applied.includes(id))) add('contract', 'walk:unapplied:' + scenario.id, 'Not every scheduled disturbance was applied: ' + expected.join(', '));
        for (const step of result.steps) {
            // An error's vocabulary is not a recovery contract. Only an explicit actionable refusal
            // can be accepted; "invalid" or "missing" alone must never hide a thrown recovery command.
            if (step.threw && !step.effectReinspection && (isUncaughtGateError(step.output)
                || !hasHumanRecovery(step.output, step.gate ?? undefined) && !isActionableIntegrityRefusal(step.output, step.gate ?? undefined))) {
                add('safety', 'walk:command-threw:' + scenario.id + ':' + step.index, step.output.slice(0, 400), step);
            }
            const repeatedArgv = step.repeatedCommand ? splitCommandLine(step.repeatedCommand.command) : [];
            const repeatedGate = repeatedArgv[repeatedArgv.indexOf('gate') + 1];
            const rejectedAction = repeatedGate === 'next-step' && repeatedArgv.includes('--execute-effects')
                && /Next-step effect plan is stale:[\s\S]*\bRerun next-step inspection\./u.test(step.repeatedCommand?.output ?? '')
                ? 'next-step-effect' : repeatedGate;
            // The guard's out-of-order refusal is a correct end of a repeated command only if it really changed nothing.
            const outOfOrderRefusal = !!step.repeatedCommand?.stateUnchanged && isOutOfOrderRefusal(step.repeatedCommand.output, repeatedGate);
            if (step.repeatedCommand?.exitCode && !outOfOrderRefusal && !isActionableIntegrityRefusal(step.repeatedCommand.output, rejectedAction)) {
                add('safety', 'walk:repeated-command-failed:' + scenario.id + ':' + step.index,
                    'Repeated ' + repeatedGate + ' failed: ' + step.repeatedCommand.output.slice(0, 400), step);
            }
            // A wrong gate may refuse or do harmless work; a programming error is never a refusal.
            if (step.wrongGate?.uncaught) {
                add('safety', 'walk:wrong-gate-crashed:' + step.wrongGate.gate + ':' + scenario.id + ':' + step.index,
                    'Wrong gate ' + step.wrongGate.gate + ' threw an uncaught error: ' + step.wrongGate.output.slice(0, 400), step,
                    { wrongGate: step.wrongGate });
            }
        }
        // Reaching DONE after a wrong gate must not cost less than the undisturbed baseline: no fewer fresh
        // reviews, and the baseline's compile, full-suite, review and completion evidence in the final cycle.
        const undisturbed = scenario.injection.undisturbed;
        const wrong = result.steps.find(step => step.wrongGate)?.wrongGate;
        if (undisturbed) {
            // The agent's mistake must never cost a new review cycle, whatever the terminal outcome.
            for (const lane of Object.keys(result.reviewsByLane)) {
                const observed = result.reviewsByLane[lane] ?? 0, expected = undisturbed.reviews[lane] ?? 0;
                if (observed > expected) add('economy', 'walk:wrong-gate-extra-reviews:' + lane + ':' + scenario.id,
                    'Wrong gate ' + wrong?.gate + ' led to ' + observed + ' fresh ' + lane + ' reviews; the undisturbed task needs ' + expected + '.',
                    undefined, { wrongGate: wrong });
            }
            const restarts = walkRestarts(result.events);
            const added = Object.keys(restarts).filter(type => restarts[type] > (undisturbed.restarts[type] ?? 0));
            if (added.length) add('economy', 'walk:wrong-gate-restart:' + added.join('+') + ':' + scenario.id,
                'Wrong gate ' + wrong?.gate + ' led to ' + added.join(', ') + ' that the undisturbed task does not have.',
                undefined, { wrongGate: wrong, events: result.events.map(event => event.type) });
            const next = result.steps.find(step => !step.reusedPrefix && step.index === scenario.injection!.step + 1);
            if (!next?.route || !undisturbed.returnRoutes.includes(next.route)) add('contract', 'walk:wrong-gate-not-returned:' + scenario.id,
                'After wrong gate ' + wrong?.gate + ' next-step named ' + (next?.route ?? '(nothing)') + ', expected ' + undisturbed.returnRoutes.join(' or ') + '.',
                next, { wrongGate: wrong, reason: next?.reason });
        }
        // A disturbed variant may repeat only what the operator's rules allow; undecided cases stay unjudged.
        // A single wrong gate is already judged above against the whole undisturbed run.
        const economy = judgeReviewEconomy(result);
        for (const { key, entries: [first, ...more] } of economy ? economyExcessByLane(economy) : []) {
            if (undisturbed && first.kind === 'extra-launch') continue;
            add(first.kind === 'delta-where-full' || first.kind === 'unknown-mode' ? 'safety' : 'economy', 'walk:economy:' + key + ':' + scenario.id,
                'After ' + economy!.disturbances.join(' + ') + ' lane ' + first.lane + ' launched ' + [first, ...more].map(entry => entry.review.mode).join(', ')
                    + ' (' + first.kind + '); the rules allow ' + first.allowed + '. ' + ECONOMY_RULES[first.rule],
                economyRecoveryStep(result, scenario.injection.step, first.review),
                { rule: first.rule, disturbances: economy!.disturbances, launchSteps: [first, ...more].map(entry => entry.review.step),
                    observed: economy!.observed.map(review => review.lane + ':' + review.mode) });
        }
        // The other side of the bound: a review the rules require to repeat must not be kept.
        for (const missed of undisturbed ? [] : economy?.missed ?? []) {
            add('safety', 'walk:economy:missed-review:' + missed.lane + ':' + scenario.id,
                'After ' + economy!.disturbances.join(' + ') + ' lane ' + missed.lane + ' launched ' + missed.launched
                    + (missed.requiredMode ? ' qualifying ' + missed.requiredMode : '') + ' time(s) '
                    + (missed.rule === 'not-run' || missed.rule === 'first-review' ? 'as planned' : 'beyond the planned reviews')
                    + '; the rules require ' + missed.required + '. ' + ECONOMY_RULES[missed.rule],
                economyRecoveryStep(result, scenario.injection.step),
                { rule: missed.rule, requiredMode: missed.requiredMode, disturbances: economy!.disturbances,
                    observed: economy!.observed.map(review => review.lane + ':' + review.mode) });
        }
        if (undisturbed && result.outcome === 'done') {
            for (const [lane, expected] of Object.entries(undisturbed.reviews)) {
                const observed = result.reviewsByLane[lane] ?? 0;
                if (observed < expected) add('safety', 'walk:wrong-gate-fewer-reviews:' + lane + ':' + scenario.id,
                    'DONE after wrong gate ' + wrong?.gate + ' with ' + observed + ' ' + lane + ' reviews; the undisturbed task needs ' + expected + '.',
                    undefined, { wrongGate: wrong });
            }
            const missing = missingWalkMilestones(result.events, undisturbed.milestones);
            if (missing.length) add('safety', 'walk:wrong-gate-skipped:' + missing.join('+') + ':' + scenario.id,
                'DONE after wrong gate ' + wrong?.gate + ' without ' + missing.join(', ') + ' in the final cycle.', undefined,
                { wrongGate: wrong, events: result.events.map(event => event.type) });
        }
        if (!scenario.enforceReviewExpectations) return findings;
    }
    for (const [taskId, expected] of Object.entries(scenario.expectedTaskReviews ?? {})) {
        const actual = result.reviews.filter(review => review.taskId === taskId).map(review => review.lane + ':' + review.mode);
        if (actual.join(' ') !== expected.join(' ')) add('contract', 'walk:task-review-modes:' + scenario.id + ':' + taskId,
            'Expected ' + taskId + ': ' + expected.join(' ') + ', observed ' + actual.join(' ') + '.');
    }
    for (const lane of new Set([...Object.keys(scenario.expectedReviews), ...Object.keys(result.reviewsByLane)])) {
        const expected = scenario.expectedReviews[lane] ?? 0;
        const observed = result.reviewsByLane[lane] ?? 0;
        if (expected !== observed) {
            add(observed < expected ? 'safety' : 'economy', 'walk:reviews:' + expected + '->' + observed + ':' + lane + ':' + scenario.id,
                'Lane ' + lane + ' launched ' + observed + ' fresh reviewers, the contract expects ' + expected + '.');
        }
    }
    const modes = result.reviews.map((review) => review.lane + ':' + review.mode).join(' ');
    if (scenario.expectedModes.length !== result.reviews.length || scenario.expectedModes.some((expected, index) =>
        !expected.split('|').includes(result.reviews[index]?.lane + ':' + result.reviews[index]?.mode))) {
        add('contract', 'walk:modes:' + scenario.id, 'Expected ' + scenario.expectedModes.join(' ') + ', observed ' + modes + '.');
    }
    for (const step of result.steps) {
        if (step.exitCode && !step.effectReinspection && !(scenario.expectedFailingGates ?? []).includes(String(step.gate))
            && !isAdoptedReviewPolicyRefusal(scenario.injection, result.steps, step)) {
            add('safety', 'walk:gate-failed:' + step.gate + ':' + scenario.id, step.output.slice(0, 400), step);
        }
    }
    return findings;
}
