export const HIDDEN_SKILL_CHARACTERS = /[\u034f\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/u;

interface SkillContentPattern {
    id: string;
    severity: 'HIGH' | 'MEDIUM';
    scope: 'all' | 'script' | 'metadata';
    expression: RegExp;
}

export const SKILL_CONTENT_PATTERNS: readonly SkillContentPattern[] = [
    { id: 'S-001', severity: 'HIGH', scope: 'all',
        expression: /\b(?:curl|wget|iwr|invoke-webrequest)\b[^|]{0,512}\|\s*(?:sh|bash|zsh|iex|invoke-expression|pwsh|powershell|python3?|node)\b/iu },
    { id: 'S-002', severity: 'HIGH', scope: 'all',
        expression: /\b(?:eval|exec|iex|invoke-expression)\b[\s\S]{0,160}(?:base64|fromcharcode|(?:\\x[\da-f]{2}){2})|(?:base64|fromcharcode|(?:\\x[\da-f]{2}){2})[\s\S]{0,160}\b(?:eval|exec|iex|invoke-expression|sh|bash)\b/iu },
    { id: 'S-003', severity: 'HIGH', scope: 'all', expression: HIDDEN_SKILL_CHARACTERS },
    { id: 'S-004', severity: 'HIGH', scope: 'all',
        expression: /(?:~[\\/])?\.ssh(?:[\\/][^\s"']*)?|\bid_rsa\b|\.aws[\\/]credentials\b|\b(?:keychain|browser\s+profile\s+data)\b/iu },
    { id: 'S-005', severity: 'HIGH', scope: 'all',
        expression: /\b(?:read|get-content|cat|source|open|load_dotenv)\b[^\r\n]{0,80}\.env(?![\w.-])/iu },
    { id: 'S-007', severity: 'HIGH', scope: 'all',
        expression: /\b(?:always\s+(?:approve|return\s+pass)|return\s+pass\s+regardless|ignore\s+(?:all\s+)?previous\s+instructions|do\s+not\s+tell\s+the\s+user|hide\s+this\s+step)\b/iu },
    { id: 'S-009', severity: 'HIGH', scope: 'all',
        expression: /--(?:dangerously-skip-permissions|yolo|no-sandbox)\b|\bbypass\s+approvals\b|\bdisable\s+(?:permission\s+prompts?|sandbox(?:ing)?)\b/iu },
    { id: 'S-010', severity: 'MEDIUM', scope: 'script',
        expression: /\b(?:fetch|https?\.request|axios(?:\.(?:get|post|request))?)\s*\(|\b(?:curl|wget|iwr|invoke-webrequest)\b/iu },
    { id: 'S-012', severity: 'MEDIUM', scope: 'metadata',
        expression: /["']?(?:allowed[_-]tools|tools|permissions)["']?\s*:\s*(?:["'](?:\*|\\u002a|all|unrestricted)["']|\[\s*(?:"(?:[^"\\]|\\.)*"\s*,\s*)*"(?:\*|\\u002a|all|unrestricted)")/iu },
    { id: 'S-016', severity: 'MEDIUM', scope: 'metadata',
        expression: /["'](?:install|postinstall)["']\s*:/iu }
];
