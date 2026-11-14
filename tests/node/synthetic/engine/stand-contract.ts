import * as ts from 'typescript';

function escapePattern(text: string): string { return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }
/** Positive selections cannot accidentally match Node's file/ancestor test and run its entire subtree. */
export function contractSelections(source: string): Array<{ id: string; pattern: string }> {
    const file = ts.createSourceFile('contract.ts', source, ts.ScriptTarget.Latest, true);
    const ordinary: string[] = [];
    let tours = 0;
    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'test') {
            const name = node.arguments[0];
            if (name && ts.isStringLiteralLike(name)) ordinary.push(escapePattern(name.text));
            else if (name && ts.isTemplateExpression(name) && name.head.text.trim()) {
                if (name.head.text === 'universal-fallbacks dependency: complete opaque gate tour (rename=') tours++;
                else ordinary.push(escapePattern(name.head.text) + '.*');
            } else throw new Error('Contract test name cannot be selected safely; declare a literal name/prefix');
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    if (!ordinary.length || tours !== 1) throw new Error('Contract selection requires ordinary cases and the two rename tours');
    return [
        { id: 'contract-selection', pattern: '^(?:' + ordinary.join('|') + ')$' },
        { id: 'contract-tour', pattern: '^universal-fallbacks dependency: complete opaque gate tour \\(rename=false\\)$' },
        { id: 'contract-rename', pattern: '^universal-fallbacks dependency: complete opaque gate tour \\(rename=true\\)$' }
    ];
}
