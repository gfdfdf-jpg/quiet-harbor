import type { WalkResult } from './navigator-walk';
import { verdictResult } from './walk-metrics';
import type { WalkRunStore } from './walk-run-store';

/** Replayable views retain metadata, and at most one authenticated raw scenario.
 * Reducers must not retain raw steps across scenarios (metrics retain their numeric evidence instead).
 * Every cache miss checks the original content digest again, including native paired traces. */
export class MergeWalkRecords {
    private current?: { store: WalkRunStore; id: string; digest: string; result: WalkResult };

    private load(store: WalkRunStore, id: string, digest: string): WalkResult {
        if (this.current?.store === store && this.current.id === id && this.current.digest === digest) return this.current.result;
        // Release the preceding payload before parsing its successor.
        this.current = undefined;
        const sealed = store.readSealed(id);
        if (!sealed || sealed.digest !== digest) throw new Error('Tampered scenario during merge: ' + id);
        const result = verdictResult(sealed.record.result);
        this.current = { store, id, digest, result };
        return result;
    }

    view(store: WalkRunStore, id: string, digest: string, result: WalkResult): WalkResult {
        return this.project(result, () => this.load(store, id, digest));
    }

    private project(result: WalkResult, read: () => WalkResult): WalkResult {
        const view = { ...result };
        Reflect.deleteProperty(view, 'steps');
        Reflect.deleteProperty(view, 'events');
        Reflect.deleteProperty(view, 'nativeBudget');
        Object.defineProperties(view, {
            steps: { enumerable: true, get: () => read().steps },
            events: { enumerable: true, get: () => read().events }
        });
        if (result.nativeBudget) view.nativeBudget = this.project(result.nativeBudget, () => read().nativeBudget!);
        return view;
    }
}
