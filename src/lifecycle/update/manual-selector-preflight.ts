import * as fs from 'node:fs';
import * as path from 'node:path';
import { bindContainedDestination } from '../../core/contained-filesystem';
import {
    planManualValidationSelector, SELECTOR_HEADING, SELECTOR_INSERTION_HEADING
} from '../../materialization/manual-validation-selector-migration';

export function assertManualSelectorMigrationReady(targetRoot: string, bundleRoot: string, sourceBundleRoot: string): void {
    const templateRelative = 'template/docs/agent-rules/40-commands.md';
    const sourceTemplate = path.join(sourceBundleRoot, templateRelative);
    const template = fs.existsSync(sourceTemplate) ? sourceTemplate : path.join(bundleRoot, templateRelative);
    if (!fs.existsSync(template)) return;
    const live = path.join(bundleRoot, 'live/docs/agent-rules/40-commands.md');
    const legacy = path.join(targetRoot, 'docs/agent-rules/40-commands.md');
    const source = fs.existsSync(live) ? live : fs.existsSync(legacy) ? legacy : null;
    if (!source) return;
    bindContainedDestination(targetRoot, source);
    const plan = planManualValidationSelector(fs.readFileSync(source), fs.readFileSync(template, 'utf8'));
    if (plan.status === 'blocked') {
        throw new Error(`${source}: cannot safely update 40-commands.md. Add or repair '${SELECTOR_HEADING}' `
            + `from the update template immediately before '${SELECTOR_INSERTION_HEADING}'. `
            + `Reason: ${plan.reason}. Update stopped before applying changes.`);
    }
}
