import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveNextStepFullSuiteValidationRoute,
    buildTaskTestSelectionCommand,
    resolveTestSelectionRoute,
    resolveOutOfScopeFullSuiteRoute
} from '../../../../src/gates/next-step/next-step-full-suite-routing';
import { resolvePostReviewCloseoutRoute } from '../../../../src/gates/next-step/next-step-closeout-routing';

const BASE_OPTIONS = Object.freeze({
    enabled: true,
    placement: 'before_test_review' as const,
    notRequiredForCurrentScope: false,
    gateStatus: null,
    gatePassed: false,
    timeoutBlockerExhausted: false,
    timeoutRepairTaskProposal: null,
    timedOutRetryAvailable: false,
    transientRetryEvidenceAvailable: false,
    transientRetryEvidenceReason: null,
    configPath: 'garda-agent-orchestrator/live/config/workflow-config.json',
    commandText: 'npm test',
    testSelectionCommand: buildTaskTestSelectionCommand('node bin/garda.js', 'T-123', ['tests/current.test.ts'], false),
    testSelectionRequiresConfirmation: false,
    timeoutForecastLine: 'Recommended full-suite command timeout: 240s.',
    command: 'node bin/garda.js gate full-suite-validation --task-id "T-123" --preflight-path "runtime/reviews/T-123-preflight.json" --repo-root "."',
    runMarkerRecoveryCommand: 'node bin/garda.js gate full-suite-run-marker-recovery --task-id "T-123" --preflight-path "runtime/reviews/T-123-preflight.json" --repo-root "."',
    runMarkerCleanupCommand: 'node bin/garda.js gate full-suite-run-marker-recovery --task-id "T-123" --preflight-path "runtime/reviews/T-123-preflight.json" --clear-dead-marker --operator-confirmed yes --repo-root "."',
    timeoutRepairTaskCommand: 'node bin/garda.js gate materialize-full-suite-repair-task --task-id "T-123" --preflight-path "runtime/reviews/T-123-preflight.json" --full-suite-artifact-path "runtime/reviews/T-123-full-suite-validation.json" --repo-root "."',
    navigatorCommand: 'node bin/garda.js next-step "T-123" --repo-root "."',
    nextReviewType: 'test'
});

describe('next-step full-suite route helper', () => {
    it('revalidates the original command after authenticated repair restore without rematerializing terminal children', () => {
        const failure = { refs: ['ModuleBoundaryTest'], repairCommand: BASE_OPTIONS.timeoutRepairTaskCommand,
            widenScopeCommand: 'garda gate enter-task-mode', restoredRepairValidationCommand: BASE_OPTIONS.command };
        for (const placement of ['after_compile_before_reviews', 'before_test_review'] as const) {
            const route = resolveNextStepFullSuiteValidationRoute({ ...BASE_OPTIONS, placement,
                gateStatus: 'FAIL', outOfScopeFailure: failure });
            assert.equal(route?.nextGate, 'full-suite-validation');
            assert.equal(route?.commands[0].command, BASE_OPTIONS.command);
            assert.match(route?.reason || '', /AUDIT_AND_BLOCK still blocks DONE until passing validation/u);
        }
        assert.equal(resolveOutOfScopeFullSuiteRoute(failure)?.nextGate, 'full-suite-validation',
            'The before-completion closeout uses the same restored-repair route');
    });
    it('routes a blocking out-of-scope failure to repair even when retries are available', () => {
        for (const placement of ['after_compile_before_reviews', 'before_test_review'] as const) {
            const route = resolveNextStepFullSuiteValidationRoute({ ...BASE_OPTIONS, placement,
                gateStatus: 'FAIL', timedOutRetryAvailable: true, transientRetryEvidenceAvailable: true,
                outOfScopeFailure: { refs: ['com.onlinestore.architecture.ModuleBoundaryTest'],
                    repairCommand: BASE_OPTIONS.timeoutRepairTaskCommand,
                    widenScopeCommand: 'garda gate enter-task-mode --upgrade-existing-task-mode --operator-confirmed yes' } });
            assert.equal(route?.nextGate, 'materialize-full-suite-repair-task');
            assert.equal(route?.commands[0].command, BASE_OPTIONS.timeoutRepairTaskCommand);
            assert.match(route?.reason || '', /ModuleBoundaryTest.*entire failed run.*grouped follow-up/su);
            assert.match(route?.reason || '', /gate enter-task-mode/u);
        }
    });
    it('routes after-compile placement before any reviewer launch', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            placement: 'after_compile_before_reviews',
            nextReviewType: 'code'
        });

        assert.equal(route?.nextGate, 'full-suite-validation');
        assert.equal(route?.title, 'Run full-suite validation after compile before reviews.');
        assert.match(route?.reason || '', /after compile-gate and before launching independent reviewers/);
        assert.equal(route?.commands[0]?.command, BASE_OPTIONS.command);
    });
    it('offers selecting only the task tests when the recorded selection is the project-wide command', () => {
        const reselect = 'garda workflow set --full-suite-command "<command that runs only this task\'s tests and required regressions>" --task-id "T-1"';
        for (const [placement, nextReviewType] of [['after_compile_before_reviews', 'code'], ['before_test_review', 'test']] as const) {
            const route = resolveNextStepFullSuiteValidationRoute({ ...BASE_OPTIONS, placement, nextReviewType,
                testSelectionReselectCommand: reselect });
            assert.equal(route?.nextGate, 'full-suite-validation');
            assert.equal(route?.commands[0]?.command, BASE_OPTIONS.command);
            assert.equal(route?.commands[1]?.command, reselect);
            assert.match(route?.reason || '', /current task selection is the configured project-wide command/u);
        }
        const plain = resolveNextStepFullSuiteValidationRoute({ ...BASE_OPTIONS, placement: 'after_compile_before_reviews', nextReviewType: 'code' });
        assert.equal(plain?.commands.length, 1);
    });

    it('routes before-test placement only when test is the next review lane', () => {
        const route = resolveNextStepFullSuiteValidationRoute(BASE_OPTIONS);

        assert.equal(route?.nextGate, 'full-suite-validation');
        assert.equal(route?.title, 'Run full-suite validation before test review.');
        assert.match(route?.reason || '', /before launching the mandatory test reviewer/);
    });

    it('suppresses before-test full-suite routing while non-test review lanes remain launchable', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            nextReviewType: 'code'
        });

        assert.equal(route, null);
    });

    it('routes timed-out failures to a retry instead of implementation remediation', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            gateStatus: 'FAIL',
            timedOutRetryAvailable: true
        });

        assert.equal(route?.nextGate, 'full-suite-validation');
        assert.equal(route?.title, 'Retry full-suite validation with updated timeout forecast.');
        assert.match(route?.reason || '', /recommends a longer timeout/);
        assert.equal(route?.commands[0]?.command, BASE_OPTIONS.command);
    });

    it('routes exhausted timeout blockers to repair-task materialization before reviewers', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            gateStatus: 'FAIL',
            timeoutBlockerExhausted: true,
            timeoutRepairTaskProposal: 'id=T-123-F1; title=Fix full-suite timeout blocker'
        });

        assert.equal(route?.nextGate, 'full-suite-timeout-repair-task');
        assert.match(route?.title || '', /repair task/i);
        assert.match(route?.reason || '', /exhausting the configured retry policy/);
        assert.match(route?.reason || '', /T-123-F1/);
        assert.equal(route?.commands[0]?.command, BASE_OPTIONS.timeoutRepairTaskCommand);
    });

    it('routes exhausted WARNED timeout blockers to repair-task materialization before reviewers', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            placement: 'after_compile_before_reviews',
            nextReviewType: 'code',
            gateStatus: null,
            gatePassed: false,
            timeoutBlockerExhausted: true,
            timeoutRepairTaskProposal: 'id=T-123-F1; title=Fix full-suite timeout blocker'
        });

        assert.equal(route?.nextGate, 'full-suite-timeout-repair-task');
        assert.match(route?.reason || '', /T-123-F1/);
        assert.equal(route?.commands[0]?.command, BASE_OPTIONS.timeoutRepairTaskCommand);
    });

    it('blocks stale repeated blocker routing instead of silently routing another nested repair child', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            placement: 'after_compile_before_reviews',
            nextReviewType: 'code',
            gateStatus: 'FAIL',
            timeoutBlockerExhausted: true,
            timeoutRepairTaskProposal: 'id=T-123-F1-F1; title=Fix full-suite timeout blocker',
            repeatedTimeoutBlockerAnalysis:
                'source_task_id=T-123; observed_task_id=T-123-F1; matched_ancestor_task_id=T-123; '
                + `fingerprint=${'a'.repeat(64)}; gate=full-suite-validation; failure_class=timeout_retry_exhausted; `
                + 'required_resolution=TRUE_DECOMPOSITION_OR_EXPLICIT_RECOVERY_DECISION'
        });

        assert.match(route?.title || '', /Analyze repeated full-suite blocker/);
        assert.match(route?.reason || '', /same blocker fingerprint must not create another automatic nested repair child/);
        assert.match(route?.reason || '', /TRUE_DECOMPOSITION_OR_EXPLICIT_RECOVERY_DECISION/);
        assert.match(route?.reason || '', /declare one meaningful linked repair task with independent Repair scope paths/);
        assert.equal(route?.commands[0]?.command, BASE_OPTIONS.timeoutRepairTaskCommand);
    });

    it('prints a cleanup command only for dead interrupted markers without live descendants', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            placement: 'after_compile_before_reviews',
            nextReviewType: 'code',
            interruptedRun: {
                markerPath: 'garda-agent-orchestrator/runtime/reviews/T-123-full-suite-run-marker.json',
                startedAtUtc: '2026-06-07T01:02:03.000Z',
                command: 'npm test',
                timeoutMs: 600000,
                gatePid: 12345,
                gateProcessAlive: false,
                childPid: 12346,
                childProcessAlive: false,
                childCommand: 'npm',
                descendantProcessCandidates: [],
                processScanWarning: null
            }
        });

        assert.equal(route?.commands[0]?.label, 'Clear dead full-suite run marker after preserving recovery evidence');
        assert.equal(route?.commands[0]?.command, BASE_OPTIONS.runMarkerCleanupCommand);
    });

    it('routes interrupted missing evidence to recovery instead of a fresh not-yet-run prompt', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            placement: 'after_compile_before_reviews',
            nextReviewType: 'code',
            interruptedRun: {
                markerPath: 'garda-agent-orchestrator/runtime/reviews/T-123-full-suite-run-marker.json',
                startedAtUtc: '2026-06-07T01:02:03.000Z',
                command: 'npm test',
                timeoutMs: 600000,
                gatePid: 12345,
                gateProcessAlive: false,
                childPid: 12346,
                childProcessAlive: true,
                childCommand: 'node',
                descendantProcessCandidates: [
                    {
                        pid: 12347,
                        parentPid: 12346,
                        commandLine: 'node --test .node-build/tests/node/full-suite-child.test.js'
                    }
                ],
                processScanWarning: null
            }
        });

        assert.equal(route?.nextGate, 'full-suite-validation');
        assert.equal(route?.title, 'Recover interrupted full-suite validation run.');
        assert.match(route?.reason || '', /no terminal full-suite artifact was materialized/);
        assert.match(route?.reason || '', /child pid 12346 is still alive/);
        assert.match(route?.reason || '', /Live descendant candidates/);
        assert.match(route?.reason || '', /pid=12347/);
        assert.match(route?.reason || '', /Interrupted command: npm test/);
        assert.match(route?.reason || '', /Retry command: npm test/);
        assert.match(route?.reason || '', /terminate only task-owned processes/);
        assert.equal(route?.commands[0]?.command, BASE_OPTIONS.runMarkerRecoveryCommand);
    });

    it('routes unresolved marker files to recovery instead of starting a fresh run', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            placement: 'after_compile_before_reviews',
            nextReviewType: 'code',
            unresolvedRunMarkerPath: 'garda-agent-orchestrator/runtime/reviews/T-123-full-suite-run-marker.json'
        });

        assert.equal(route?.nextGate, 'full-suite-validation');
        assert.equal(route?.title, 'Inspect unresolved full-suite run marker state.');
        assert.match(route?.reason || '', /stale, invalid, malformed, or not bound/);
        assert.match(route?.reason || '', /would overwrite the diagnostic marker/);
        assert.equal(route?.commands[0]?.command, BASE_OPTIONS.runMarkerRecoveryCommand);
    });

    it('keeps stale markers without a recorded child pid in recovery', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            placement: 'after_compile_before_reviews',
            nextReviewType: 'code',
            interruptedRun: {
                markerPath: 'garda-agent-orchestrator/runtime/reviews/T-123-full-suite-run-marker.json',
                startedAtUtc: '2026-06-07T01:02:03.000Z',
                command: 'npm test',
                timeoutMs: 600000,
                gatePid: 12345,
                gateProcessAlive: false,
                childPid: null,
                childProcessAlive: null,
                childCommand: null,
                descendantProcessCandidates: [],
                processScanWarning: null,
                markerState: 'STALE',
                markerStateReason: 'preflight_sha256 mismatch'
            }
        });

        assert.match(route?.reason || '', /marker is stale for the current cycle: preflight_sha256 mismatch/u);
        assert.match(route?.reason || '', /no child PID was recorded/u);
        assert.equal(route?.commands[0]?.command, BASE_OPTIONS.runMarkerRecoveryCommand);
    });

    it('routes active interrupted markers to wait instead of starting a duplicate full-suite run', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            placement: 'after_compile_before_reviews',
            nextReviewType: 'code',
            interruptedRun: {
                markerPath: 'garda-agent-orchestrator/runtime/reviews/T-123-full-suite-run-marker.json',
                startedAtUtc: '2026-06-07T01:02:03.000Z',
                command: 'npm test',
                timeoutMs: 600000,
                gatePid: 12345,
                gateProcessAlive: true,
                childPid: 12346,
                childProcessAlive: true,
                childCommand: 'npm',
                descendantProcessCandidates: [],
                processScanWarning: null
            }
        });

        assert.equal(route?.nextGate, 'full-suite-validation');
        assert.equal(route?.title, 'Wait for active full-suite validation run.');
        assert.match(route?.reason || '', /Do not start a second full-suite run/);
        assert.equal(route?.commands[0]?.command, BASE_OPTIONS.navigatorCommand);
    });

    it('blocks cleanup when the recorded gate process cannot be verified', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            placement: 'after_compile_before_reviews',
            nextReviewType: 'code',
            interruptedRun: {
                markerPath: 'garda-agent-orchestrator/runtime/reviews/T-123-full-suite-run-marker.json',
                startedAtUtc: '2026-06-07T01:02:03.000Z',
                command: 'npm test',
                timeoutMs: 600000,
                gatePid: 12345,
                gateProcessAlive: null,
                childPid: null,
                childProcessAlive: null,
                childCommand: null,
                descendantProcessCandidates: [],
                processScanWarning: null,
                processCheckWarning: 'Unable to verify one or more recorded process identifiers'
            }
        });

        assert.match(route?.title || '', /unverifiable full-suite validation process state/u);
        assert.match(route?.reason || '', /Do not start a second full-suite run or clear this marker/u);
        assert.equal(route?.commands[0]?.command, BASE_OPTIONS.runMarkerRecoveryCommand);
    });

    it('redacts secret-looking process and command text in interrupted recovery output', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            placement: 'after_compile_before_reviews',
            nextReviewType: 'code',
            commandText: 'API_TOKEN=super-secret npm test',
            interruptedRun: {
                markerPath: 'garda-agent-orchestrator/runtime/reviews/T-123-full-suite-run-marker.json',
                startedAtUtc: '2026-06-07T01:02:03.000Z',
                command: 'AUTH_TOKEN=interrupted-secret npm test',
                timeoutMs: 600000,
                gatePid: 12345,
                gateProcessAlive: false,
                childPid: 12346,
                childProcessAlive: true,
                childCommand: 'API_TOKEN=child-secret node',
                descendantProcessCandidates: [
                    {
                        pid: 12347,
                        parentPid: 12346,
                        commandLine: 'PASSWORD=worker-secret node --test'
                    }
                ],
                processScanWarning: null
            }
        });

        const reason = route?.reason || '';
        assert.doesNotMatch(reason, /super-secret|interrupted-secret|child-secret|worker-secret/);
        assert.match(reason, /<redacted>/);
    });

    it('keeps recovery conservative when no descendant process evidence is available', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            placement: 'after_compile_before_reviews',
            nextReviewType: 'code',
            interruptedRun: {
                markerPath: 'garda-agent-orchestrator/runtime/reviews/T-123-full-suite-run-marker.json',
                startedAtUtc: '2026-06-07T01:02:03.000Z',
                command: 'npm test',
                timeoutMs: 600000,
                gatePid: 12345,
                gateProcessAlive: false,
                childPid: 12346,
                childProcessAlive: false,
                childCommand: 'npm',
                descendantProcessCandidates: [],
                processScanWarning: null
            }
        });

        assert.equal(route?.nextGate, 'full-suite-validation');
        assert.match(route?.reason || '', /No live descendant process candidates/);
        assert.match(route?.reason || '', /do not kill generic node\.exe/);
        assert.equal(route?.commands[0]?.command, BASE_OPTIONS.runMarkerCleanupCommand);
    });

    it('keeps non-timeout failures in implementation while printing the post-fix full-suite retry', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            gateStatus: 'FAIL'
        });

        assert.equal(route?.nextGate, 'implementation');
        assert.match(route?.title || '', /Fix full-suite failures/);
        assert.equal(route?.commands[0]?.command, BASE_OPTIONS.command);
        assert.match(route?.commands[0]?.label || '', /after fixing implementation/);
    });

    it('prints the post-fix full-suite retry for before-test non-timeout failures', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            placement: 'before_test_review',
            gateStatus: 'FAIL',
            nextReviewType: 'test'
        });

        assert.equal(route?.nextGate, 'implementation');
        assert.match(route?.title || '', /before launching test review/);
        assert.equal(route?.commands[0]?.command, BASE_OPTIONS.command);
        assert.match(route?.commands[0]?.label || '', /after fixing implementation/);
    });

    it('routes non-timeout failures to full-suite retry when focused transient evidence is present', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            gateStatus: 'FAIL',
            transientRetryEvidenceAvailable: true,
            transientRetryEvidenceReason: 'Evidence: runtime/manual-validation/T-123/full-suite-retry-evidence.json; reason_kind=transient.'
        });

        assert.equal(route?.nextGate, 'full-suite-validation');
        assert.match(route?.title || '', /focused transient evidence/);
        assert.match(route?.reason || '', /does not replace mandatory full-suite evidence/);
        assert.equal(route?.commands[0]?.command, BASE_OPTIONS.command);
    });

    it('routes non-timeout failures to full-suite retry when targeted diagnostics passed afterward', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            gateStatus: 'FAIL',
            targetedDiagnosticRetryAvailable: true,
            targetedDiagnosticRetryReason: 'Evidence: artifact=runtime/reviews/T-123-intermediate-command-targeted-test.json.'
        });

        assert.equal(route?.nextGate, 'full-suite-validation');
        assert.match(route?.title || '', /targeted diagnostics/);
        assert.match(route?.reason || '', /do not replace mandatory full-suite evidence/);
        assert.match(route?.reason || '', /full-suite-retry-evidence\.json/);
        assert.equal(route?.commands[0]?.command, BASE_OPTIONS.command);
    });
});


describe('test selection at the test boundary', () => {
    it('routes an excluded current test to selection before executing the test gate', () => {
        const route = resolveNextStepFullSuiteValidationRoute({ ...BASE_OPTIONS,
            testSelectionViolations: ['Configured selector excludes tests/current.test.ts'] });
        assert.equal(route?.nextGate, 'task-test-selection');
        assert.match(route?.reason || '', /selection applies to this task only/);
        assert.equal(route?.commands.length, 1);
        assert.match(route!.commands[0].command, /workflow set .*--task-id "T-123"/u);
        assert.match(route!.commands[0].command, /--focused-required-test-path "tests\/current\.test\.ts"/u);
        assert.match(route!.commands[0].command, /--target-root "\."/u);
        assert.match(route!.reason, /do not manually change the project-wide test command/iu);
        assert.match(route!.reason, /selection is bound to this task/iu);
        assert.equal(resolveNextStepFullSuiteValidationRoute({ ...BASE_OPTIONS, nextReviewType: 'code',
            testSelectionViolations: ['excluded'] }), null);
    });

    it('quotes every excluded target and requests confirmation only when policy requires it', () => {
        const command = buildTaskTestSelectionCommand('node bin/garda.js', 'T-123',
            ['tests/one test.js', 'tests/two.test.js'], true);
        assert.match(command, /--focused-required-test-path "tests\/one test\.js" --focused-required-test-path "tests\/two\.test\.js"/u);
        assert.match(command, /--operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp of operator approval>"/u);
        assert.match(command, /--full-suite-command "<command that runs only this task's tests and required regressions>"/u);
        assert.doesNotMatch(BASE_OPTIONS.testSelectionCommand, /--operator-confirmed/u);
    });

    it('shows the project command only as a reference and accepts unattributed broad failure routing', () => {
        const projectCommand = 'mvn -pl application -am verify';
        const selection = resolveTestSelectionRoute({ ...BASE_OPTIONS,
            testSelectionViolations: ['Select task tests'], testSelectionReferenceCommand: projectCommand });
        assert.ok(selection!.reason.includes(`reference to narrow from): ${projectCommand}`));
        assert.ok(!selection!.commands[0].command.includes(projectCommand));
        const route = resolveOutOfScopeFullSuiteRoute({ refs: [], referenceCommand: projectCommand,
            narrowCommand: BASE_OPTIONS.testSelectionCommand, followUpCommand: 'materialize-follow-up',
            repairCommand: 'repair', widenScopeCommand: 'widen' });
        assert.equal(route!.nextGate, 'task-test-selection');
        assert.match(route!.reason, /not attributed.*no per-test attribution or rerun/u);
        assert.deepEqual(route!.commands.slice(0, 2).map(item => item.command), [BASE_OPTIONS.testSelectionCommand, 'materialize-follow-up']);
        assert.equal(resolveOutOfScopeFullSuiteRoute({ refs: [], followUpCommand: 'materialize-follow-up',
            repairCommand: 'repair', widenScopeCommand: 'widen' })!.nextGate, 'materialize-review-follow-up-tasks');
    });

    it('routes before-completion exclusions through the same executable selector', () => {
        for (const selection of [resolveTestSelectionRoute({ ...BASE_OPTIONS, testSelectionViolations: ['excluded test'] }),
            resolveOutOfScopeFullSuiteRoute({ refs: ['ModuleBoundaryTest'], repairCommand: 'garda gate materialize-full-suite-repair-task',
                widenScopeCommand: 'garda gate enter-task-mode --upgrade-existing-task-mode --operator-confirmed yes' })]) {
        const route = resolvePostReviewCloseoutRoute({
            requiredReviews: { requiredReviewsGatePassed: true, zeroDiffNoReviewCloseout: false,
                command: { label: 'Review', command: 'review' } },
            docImpact: { docImpactGatePassed: true, compatibilityHint: '', command: { label: 'Docs', command: 'docs' } },
            fullSuite: { enabled: true, gatePassed: false, notRequiredForDocsOnly: false, placement: 'before_completion',
                configPath: 'workflow-config.json', commandText: 'node --test tests/old.test.js', timeoutForecastLine: null,
                command: { label: 'Suite', command: 'suite' }, testSelectionRoute: selection },
            projectMemory: { required: false, evidenceCurrent: true, visibleSummaryLine: '', affectedMemoryFiles: [],
                violations: [], command: { label: 'Memory', command: 'memory' } },
            completion: { completionGatePassed: false, command: { label: 'Complete', command: 'complete' } }
        });
        assert.equal(route.nextGate, selection!.nextGate);
        assert.equal(route.commands[0].command, selection!.commands[0].command);
        }
    });

    it('instructs one out-of-scope repair row without operator approval, then the printed command', () => {
        const route = resolveOutOfScopeFullSuiteRoute({ refs: ['ModuleBoundaryTest'],
            repairCommand: 'garda gate materialize-full-suite-repair-task', widenScopeCommand: 'garda gate enter-task-mode' });
        assert.match(route!.reason, /Declare one meaningful linked repair task.*more only when the repairs are independent/u);
        assert.match(route!.reason, /create them without asking the operator.*Then run the printed materialization command/u);
        assert.match(route!.reason, /current changed tests must remain selected/u);
        assert.equal(route!.commands[0].command, 'garda gate materialize-full-suite-repair-task');
    });
});
