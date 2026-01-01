import { prepareBoundarySourceEvidenceModules } from './trust-boundary-source-evidence';
import { prepareDeclaredBoundarySourceModules } from './trust-boundary-analysis';
import { prepareClosedObservationPlanModules } from './derivation-observation-recorder';
import { prepareRuntimeMutationGenerationCode } from '../gate-runtime/runtime-mutation-generation';
import { prepareTaskEventSummaryCode } from '../gate-runtime/timeline/task-events-io-summary';

/** Share the native owners' fixed code preparation, including both boundary-reader edges.
 * This reads no project evidence and replaces no source, graph or freshness checks.
 */
export function prepareLoadedCodeLazyEdges(): void {
    prepareClosedObservationPlanModules();
    prepareBoundarySourceEvidenceModules();
    prepareDeclaredBoundarySourceModules();
    prepareRuntimeMutationGenerationCode();
    prepareTaskEventSummaryCode();
}
