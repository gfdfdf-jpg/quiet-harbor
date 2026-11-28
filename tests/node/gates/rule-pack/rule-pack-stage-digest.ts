import { createHash } from 'node:crypto';
import * as fs from 'node:fs';

/**
 * The stage_sha256 that load-rule-pack records in RULE_PACK_LOADED for a stage of the rule-pack artifact
 * as it is stored at rulePackPath, so fixtures that seed the event by hand carry the same stage provenance.
 */
export function readRulePackStageSha256(rulePackPath: string, stage: string): string {
    const artifact = JSON.parse(fs.readFileSync(rulePackPath, 'utf8')) as { stages?: Record<string, unknown> };
    const stageArtifact = artifact.stages?.[String(stage).trim().toLowerCase()];
    if (!stageArtifact) throw new Error(`Rule-pack fixture '${rulePackPath}' has no ${stage} stage.`);
    return createHash('sha256').update(JSON.stringify(stageArtifact), 'utf8').digest('hex');
}
