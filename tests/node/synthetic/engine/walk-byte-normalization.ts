// The old Windows calibration used a fixture root of this length and separator shape.
// Preserve that scale so the existing limits do not gain a path-length allowance.
const CALIBRATION_ROOT = 'C:/Users/user0/AppData/Local/Temp/garda-walk-XXXXXX';

/** Normalize only the disposable fixture root, leaving the rest of every payload byte intact. */
export function walkFixtureByteNormalizer(repoRoot: string): (content: Buffer) => number {
    const forward = repoRoot.replace(/\\/gu, '/');
    const variants = [[forward, CALIBRATION_ROOT],
        [forward.replace(/\//gu, '\\'), CALIBRATION_ROOT.replace(/\//gu, '\\')]];
    const replacements = new Map<string, string>();
    for (let [actual, canonical] of variants) {
        for (let depth = 0; depth < 3; depth += 1) {
            if (actual !== canonical) replacements.set(actual, canonical);
            // A path can also be inside JSON or inside a JSON-encoded JSON string.
            actual = JSON.stringify(actual).slice(1, -1);
            canonical = JSON.stringify(canonical).slice(1, -1);
        }
    }
    const pairs = [...replacements].map(([actual, canonical]) => ({
        actual: Buffer.from(actual), canonicalBytes: Buffer.byteLength(canonical)
    })).sort((a, b) => b.actual.length - a.actual.length);
    return content => {
        const matches = pairs.map(pair => {
            const positions: number[] = [];
            let offset = 0;
            while (offset < content.length) {
                const position = content.indexOf(pair.actual, offset);
                if (position < 0) break;
                positions.push(position);
                offset = position + 1;
            }
            return { pair, positions, cursor: 0 };
        });
        let offset = 0, bytes = content.length;
        while (true) {
            let selected: typeof matches[number] | undefined, first = content.length;
            for (const entry of matches) {
                while (entry.cursor < entry.positions.length && entry.positions[entry.cursor] < offset) entry.cursor += 1;
                const position = entry.positions[entry.cursor];
                if (position !== undefined && (position < first
                    || (position === first && entry.pair.actual.length > (selected?.pair.actual.length ?? 0)))) {
                    selected = entry; first = position;
                }
            }
            if (!selected) break;
            bytes += selected.pair.canonicalBytes - selected.pair.actual.length;
            offset = first + selected.pair.actual.length;
        }
        return bytes;
    };
}
