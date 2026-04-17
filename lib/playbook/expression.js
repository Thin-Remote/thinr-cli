// @ts-check

/**
 * Minimal boolean-expression evaluator for playbook `when:` clauses.
 * Deliberately a tiny subset — no Jinja, no filters, no arithmetic —
 * just enough to express "skip this step when X" reliably:
 *
 *   - literals: strings (single or double quoted), numbers, `true`,
 *     `false`, `null`
 *   - path access: `agent.version`, `result.data[0]` is NOT supported
 *     (only named dotted paths; index access is future work)
 *   - comparators: `==`, `!=`, `>`, `<`, `>=`, `<=`
 *   - logicals: `and`, `or`, `not`
 *   - parentheses
 *
 * The evaluator is deliberately strict: unknown identifiers throw so
 * typos don't silently turn into "falsy skip". Callers pre-seed every
 * expected variable (playbook `vars` + registered step results + the
 * implicit `device`) into the scope.
 *
 * @param {string} source   The `when` expression as written in YAML.
 * @param {Record<string, unknown>} scope
 * @returns {boolean}
 */
export function evaluateCondition(source, scope) {
    const value = evaluateExpression(source, scope);
    return !!value;
}

/**
 * Same as evaluateCondition but returns the raw value (useful for
 * tests and future `register` expressions).
 *
 * @param {string} source
 * @param {Record<string, unknown>} scope
 */
export function evaluateExpression(source, scope) {
    const parser = new Parser(source);
    const ast = parser.parseExpression();
    parser.expectEof();
    return evalNode(ast, scope);
}

// ── Tokeniser ───────────────────────────────────────────────────────

const KEYWORDS = new Set(['and', 'or', 'not', 'true', 'false', 'null']);

/**
 * @typedef {{ type: 'num', value: number }
 *   | { type: 'str', value: string }
 *   | { type: 'ident', value: string }
 *   | { type: 'op', value: string }} Token
 */

/**
 * @param {string} src
 * @returns {Token[]}
 */
function tokenize(src) {
    /** @type {Token[]} */
    const out = [];
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
            i++;
            continue;
        }
        if (c === '(' || c === ')') {
            out.push({ type: 'op', value: c });
            i++;
            continue;
        }
        if (c === '=' || c === '!' || c === '<' || c === '>') {
            if (src[i + 1] === '=') {
                out.push({ type: 'op', value: c + '=' });
                i += 2;
                continue;
            }
            if (c === '<' || c === '>') {
                out.push({ type: 'op', value: c });
                i++;
                continue;
            }
            throw new Error(`Unexpected character '${c}' at ${i}`);
        }
        if (c === '"' || c === "'") {
            const quote = c;
            let j = i + 1;
            let buf = '';
            while (j < src.length && src[j] !== quote) {
                if (src[j] === '\\' && j + 1 < src.length) {
                    buf += src[j + 1];
                    j += 2;
                } else {
                    buf += src[j];
                    j++;
                }
            }
            if (j >= src.length) throw new Error(`Unterminated string at ${i}`);
            out.push({ type: 'str', value: buf });
            i = j + 1;
            continue;
        }
        if ((c >= '0' && c <= '9') || (c === '-' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
            let j = i + 1;
            while (
                j < src.length &&
                ((src[j] >= '0' && src[j] <= '9') || src[j] === '.')
            ) {
                j++;
            }
            const n = Number(src.slice(i, j));
            if (Number.isNaN(n)) throw new Error(`Invalid number at ${i}`);
            out.push({ type: 'num', value: n });
            i = j;
            continue;
        }
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_') {
            let j = i + 1;
            while (
                j < src.length &&
                ((src[j] >= 'a' && src[j] <= 'z') ||
                    (src[j] >= 'A' && src[j] <= 'Z') ||
                    (src[j] >= '0' && src[j] <= '9') ||
                    src[j] === '_' ||
                    src[j] === '.')
            ) {
                j++;
            }
            const word = src.slice(i, j);
            out.push({ type: 'ident', value: word });
            i = j;
            continue;
        }
        throw new Error(`Unexpected character '${c}' at ${i}`);
    }
    return out;
}

// ── Parser (recursive descent) ──────────────────────────────────────

class Parser {
    /** @param {string} source */
    constructor(source) {
        this.tokens = tokenize(source);
        this.pos = 0;
    }

    peek() {
        return this.tokens[this.pos];
    }

    advance() {
        return this.tokens[this.pos++];
    }

    expectEof() {
        if (this.pos < this.tokens.length) {
            const t = this.tokens[this.pos];
            throw new Error(`Unexpected trailing token: ${formatToken(t)}`);
        }
    }

    parseExpression() {
        return this.parseOr();
    }

    parseOr() {
        let left = this.parseAnd();
        while (this.matchKeyword('or')) {
            const right = this.parseAnd();
            left = { type: 'or', left, right };
        }
        return left;
    }

    parseAnd() {
        let left = this.parseNot();
        while (this.matchKeyword('and')) {
            const right = this.parseNot();
            left = { type: 'and', left, right };
        }
        return left;
    }

    parseNot() {
        if (this.matchKeyword('not')) {
            return { type: 'not', value: this.parseNot() };
        }
        return this.parseCompare();
    }

    parseCompare() {
        const left = this.parsePrimary();
        const t = this.peek();
        if (t && t.type === 'op' && ['==', '!=', '>', '<', '>=', '<='].includes(t.value)) {
            this.advance();
            const right = this.parsePrimary();
            return { type: 'cmp', op: t.value, left, right };
        }
        return left;
    }

    parsePrimary() {
        const t = this.peek();
        if (!t) throw new Error('Unexpected end of expression');
        if (t.type === 'op' && t.value === '(') {
            this.advance();
            const inner = this.parseExpression();
            const close = this.advance();
            if (!close || close.type !== 'op' || close.value !== ')') {
                throw new Error('Missing closing parenthesis');
            }
            return inner;
        }
        if (t.type === 'str') {
            this.advance();
            return { type: 'lit', value: t.value };
        }
        if (t.type === 'num') {
            this.advance();
            return { type: 'lit', value: t.value };
        }
        if (t.type === 'ident') {
            this.advance();
            if (t.value === 'true') return { type: 'lit', value: true };
            if (t.value === 'false') return { type: 'lit', value: false };
            if (t.value === 'null') return { type: 'lit', value: null };
            if (KEYWORDS.has(t.value)) {
                throw new Error(`Unexpected keyword '${t.value}' in expression`);
            }
            return { type: 'path', parts: t.value.split('.') };
        }
        throw new Error(`Unexpected token: ${formatToken(t)}`);
    }

    matchKeyword(kw) {
        const t = this.peek();
        if (t && t.type === 'ident' && t.value === kw) {
            this.advance();
            return true;
        }
        return false;
    }
}

function formatToken(t) {
    if (!t) return '<eof>';
    return `${t.type}:${t.value}`;
}

// ── Evaluator ───────────────────────────────────────────────────────

function evalNode(node, scope) {
    switch (node.type) {
        case 'lit':
            return node.value;
        case 'not':
            return !evalNode(node.value, scope);
        case 'and':
            return !!(evalNode(node.left, scope) && evalNode(node.right, scope));
        case 'or':
            return !!(evalNode(node.left, scope) || evalNode(node.right, scope));
        case 'cmp': {
            const l = evalNode(node.left, scope);
            const r = evalNode(node.right, scope);
            switch (node.op) {
                case '==':
                    return l === r || (l != null && r != null && String(l) === String(r));
                case '!=':
                    return !(l === r || (l != null && r != null && String(l) === String(r)));
                case '>':
                    return Number(l) > Number(r);
                case '<':
                    return Number(l) < Number(r);
                case '>=':
                    return Number(l) >= Number(r);
                case '<=':
                    return Number(l) <= Number(r);
                default:
                    throw new Error(`Unknown comparator: ${node.op}`);
            }
        }
        case 'path':
            return resolvePath(node.parts, scope);
        default:
            throw new Error(`Unknown expression node: ${node.type}`);
    }
}

function resolvePath(parts, scope) {
    if (!(parts[0] in scope)) {
        throw new Error(`Undefined playbook variable: ${parts[0]}`);
    }
    let cur = scope[parts[0]];
    for (let i = 1; i < parts.length; i++) {
        if (cur == null) return undefined;
        cur = cur[parts[i]];
    }
    return cur;
}
