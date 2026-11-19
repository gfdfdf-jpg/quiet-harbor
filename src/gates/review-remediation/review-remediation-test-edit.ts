import { createHash } from 'node:crypto';
import type { ReviewRemediationReadableDiffLine } from './review-remediation-readable-diff';

/** A narrow proof, never an assertion from impact-analysis prose. Unknown syntax fails closed. */
function structure(filePath: string, source: string): string | null {
    const python = /\.py$/iu.test(filePath);
    if (!python && !/\.(?:[cm]?[jt]sx?|java|kt|kts|cs|go|c|cc|cpp|h|hpp|swift|dart)$/iu.test(filePath)) return null;
    if (/\\\r?\n/u.test(source) || (/\.java$/iu.test(filePath) && /\\u+[a-f\d]{4}/iu.test(source))) return null;
    const lines: Array<{ code: string; syntax: string }> = [{ code: '', syntax: '' }];
    let blockComment = false;
    for (let i = 0; i < source.length;) {
        const c = source[i], next = source[i + 1];
        const line = lines[lines.length - 1];
        if (c === '\n') { lines.push({ code: '', syntax: '' }); i++; continue; }
        if (blockComment) {
            if (c === '/' && next === '*') return null;
            if (c === '*' && next === '/') { blockComment = false; i += 2; } else i++;
            continue;
        }
        if ((!python && c === '/' && next === '/') || (python && c === '#')) {
            const end = source.indexOf('\n', i);
            i = end === -1 ? source.length : end;
            continue;
        }
        if (!python && c === '/' && next === '*') {
            blockComment = true; line.code += ' '; line.syntax += ' '; i += 2; continue;
        }
        if (c === '"' || c === "'") {
            const start = i++;
            // Multiline, interpolated and language-specific literals need a native parser.
            if (source.slice(start, start + 3) === c.repeat(3)) return null;
            let closed = false;
            for (; i < source.length; i++) {
                if (source[i] === '\n' || source[i] === '\r') return null;
                if (source[i] === '\\') {
                    if (source[i + 1] === 'u' || source[i + 1] === '\n') return null;
                    i++; continue;
                }
                if (source[i] === c) { i++; closed = true; break; }
            }
            if (!closed) return null;
            const literal = source.slice(start, i);
            if (/[$#]\{/u.test(literal) || (python && /[fr]$/iu.test(line.syntax))) return null;
            line.code += literal; line.syntax += 'LITERAL';
            continue;
        }
        // Slash could open a JS regexp; backticks, escapes and preprocessor syntax
        // could hide delimiters. Do not guess a structure-preserving interpretation.
        if (c === '`' || c === '\\' || c === '/' || c === '#') return null;
        line.code += c; line.syntax += c; i++;
    }
    if (blockComment) return null;
    const kept: string[] = [];
    for (const { code, syntax } of lines) {
        const text = syntax.trim();
        if (!text) continue;
        const assertion = python ? /^assert\s+\S/u.test(text)
            : /^(?:(?:assert|Assert|Assertions)\.[A-Za-z_]\w*|assert[A-Z]\w*|expect)\s*\(/u.test(text);
        // Only complete simple assertion statements. Closures, assignments, control
        // flow and additional statements are structure, including inside assertions.
        const expression = text.replace(/;$/u, '');
        const delimiters: string[] = [];
        let balanced = true;
        for (const c of expression) {
            if (c === '(' || c === '[') delimiters.push(c);
            if (c === ')' || c === ']') balanced &&= delimiters.pop() === (c === ')' ? '(' : '[');
        }
        if (assertion && balanced && delimiters.length === 0 && !/[{};:]|=>|(?<![=!<>])=(?!=)|\+\+|--|\b(?:function|class|lambda|yield|await)\b/u.test(expression)) continue;
        kept.push(python ? code.trimEnd() : code.trim());
    }
    return JSON.stringify(kept);
}

/** Reconstruct both complete, unredacted sources, including paginated long lines. */
export function isAssertionOrCommentOnlyTestEdit(filePath: string, lines?: readonly ReviewRemediationReadableDiffLine[]): boolean {
    if (!lines?.length) return false;
    const before: string[] = [], after: string[] = [];
    for (let i = 0; i < lines.length;) {
        const first = lines[i++];
        if (first.segment_index !== 1) return false;
        let text = first.text;
        for (let segment = 2; segment <= first.segment_count; segment++) {
            const part = lines[i++];
            if (!part || part.segment_index !== segment || part.segment_count !== first.segment_count
                || part.operation !== first.operation || part.baseline_line !== first.baseline_line
                || part.current_line !== first.current_line || part.source_line_sha256 !== first.source_line_sha256) return false;
            text += part.text;
        }
        if (createHash('sha256').update(text).digest('hex') !== first.source_line_sha256) return false;
        if (first.operation !== 'addition') {
            if (first.baseline_line !== before.length + 1) return false;
            before.push(text);
        }
        if (first.operation !== 'deletion') {
            if (first.current_line !== after.length + 1) return false;
            after.push(text);
        }
    }
    const baselineStructure = structure(filePath, before.join('\n'));
    return baselineStructure !== null && baselineStructure === structure(filePath, after.join('\n'));
}
