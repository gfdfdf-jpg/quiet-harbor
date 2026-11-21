import { SKILL_REFERENCE_LIMITS } from './skill-content-inputs';
import { HIDDEN_SKILL_CHARACTERS, SKILL_CONTENT_PATTERNS } from './skill-content-scan-patterns';

export interface SkillContentFinding {
    rule_id: string;
    severity: 'HIGH' | 'MEDIUM';
    file: string;
    line: number;
    excerpt: string;
}
const EXCERPT_CONTEXT_CHARACTERS = 32;
const EXCERPT_MAX_CHARACTERS = 160;
const MAX_CONTENT_FINDINGS = 256;
const SCRIPT_PATH = /\.(?:[cm]?js|tsx?|py|sh|bash|ps1|bat|cmd)$/iu;
type ScanFile = { path: string; text: string };
type ContentSegment = { text: string; sourceOffset: number; decoded: boolean; sourceOffsets?: Uint32Array };

function escapedExcerpt(text: string, offset: number): string {
    const start = Math.max(0, offset - EXCERPT_CONTEXT_CHARACTERS);
    return Array.from(text.slice(start, start + EXCERPT_MAX_CHARACTERS * 2))
        .slice(0, EXCERPT_MAX_CHARACTERS)
        .map((character) => HIDDEN_SKILL_CHARACTERS.test(character) || /[\p{Cc}]/u.test(character)
            ? '\\u{' + character.codePointAt(0)!.toString(16) + '}' : character).join('');
}

function lineNumbers(text: string): Uint32Array {
    const lines = new Uint32Array(text.length + 1);
    lines[0] = 1;
    for (let offset = 0; offset < text.length; offset += 1) {
        lines[offset + 1] = lines[offset] + Number(text[offset] === '\n');
    }
    return lines;
}

function contentSegments(file: ScanFile) {
    const segments: ContentSegment[] = [{ text: file.text, sourceOffset: 0, decoded: false }];
    if (file.path !== 'skill.json') return segments;
    const parts: string[] = [];
    const offsets: number[] = [];
    let previous = 0;
    const append = (text: string, origin: number, verbatim: boolean) => {
        parts.push(text);
        for (let offset = 0; offset < text.length; offset += 1) offsets.push(origin + (verbatim ? offset : 0));
    };
    // Normalize escaped JSON spelling while retaining physical source positions.
    for (const token of file.text.matchAll(/"(?:[^"\\]|\\.)*"/gu)) {
        append(file.text.slice(previous, token.index), previous, true);
        const decoded = JSON.parse(token[0]) as string;
        append(JSON.stringify(decoded), token.index, false);
        segments.push({ text: decoded, sourceOffset: token.index, decoded: true });
        previous = token.index + token[0].length;
    }
    append(file.text.slice(previous), previous, true);
    segments.push({ text: parts.join(''), sourceOffset: 0, decoded: false, sourceOffsets: Uint32Array.from(offsets) });
    return segments;
}

function patternApplies(scope: (typeof SKILL_CONTENT_PATTERNS)[number]['scope'], file: string): boolean {
    return scope === 'all' || scope === 'metadata' && file === 'skill.json'
        || scope === 'script' && SCRIPT_PATH.test(file);
}

function collectFindings(file: ScanFile, findings: SkillContentFinding[], seen: Set<string>): void {
    const lineAt = lineNumbers(file.text);
    const segments = contentSegments(file);
    for (const rule of SKILL_CONTENT_PATTERNS) {
        if (!patternApplies(rule.scope, file.path)) continue;
        for (const segment of segments) {
            for (const match of segment.text.matchAll(new RegExp(rule.expression.source, 'giu'))) {
                const origin = segment.sourceOffsets?.[match.index]
                    ?? segment.sourceOffset + (segment.decoded ? 0 : match.index);
                const line = lineAt[origin];
                const key = JSON.stringify([file.path, rule.id, line]);
                if (seen.has(key)) continue;
                if (findings.length >= MAX_CONTENT_FINDINGS) throw new Error('Skill content findings exceed their bound.');
                seen.add(key);
                findings.push({ rule_id: rule.id, severity: rule.severity, file: file.path, line,
                    excerpt: escapedExcerpt(segment.text, match.index) });
            }
        }
    }
}

export function scanSkillContent(files: readonly ScanFile[]): SkillContentFinding[] {
    if (files.length > SKILL_REFERENCE_LIMITS.max_files) throw new Error('Skill content file count exceeds its bound.');
    const findings: SkillContentFinding[] = [];
    const seen = new Set<string>();
    let total = 0;
    for (const file of files) {
        const bytes = Buffer.byteLength(file.text, 'utf8');
        total += bytes;
        const maximum = file.path === 'skill.json'
            ? SKILL_REFERENCE_LIMITS.max_metadata_bytes : SKILL_REFERENCE_LIMITS.max_file_bytes;
        if (bytes > maximum || total > SKILL_REFERENCE_LIMITS.max_total_bytes) {
            throw new Error('Skill content exceeds its byte bound.');
        }
        collectFindings(file, findings, seen);
    }
    return findings;
}
