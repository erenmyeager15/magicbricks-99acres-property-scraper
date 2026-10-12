// A complete Next.js primary snapshot can establish the end of listing state.
// Without it, the caller keeps the existing full-response/legacy-state path.
export interface Canonical99State {
    end: number;
    byPath: Map<string, string>;
    kind?: 'next-data' | 'initial-data';
    complete?: boolean;
    sourceStart?: number;
}

export function readCanonical99State(html: string): Canonical99State | null {
    const openings = /<!--|<(script|style)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
    let opening: RegExpExecArray | null;
    while ((opening = openings.exec(html)) !== null) {
        if (opening[0] === '<!--') {
            const end = html.indexOf('-->', openings.lastIndex);
            if (end < 0) return null;
            openings.lastIndex = end + 3;
            continue;
        }
        const tag = opening[1].toLowerCase();
        const closing = new RegExp(`</${tag}\\s*>`, 'gi');
        closing.lastIndex = openings.lastIndex;
        const end = closing.exec(html);
        if (!end) return null;
        const bodyStart = openings.lastIndex;
        openings.lastIndex = closing.lastIndex;
        if (tag !== 'script') continue;
        const attributes = [...opening[0].matchAll(/\s([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)];
        const value = (name: string) => {
            const matches = attributes.filter(attribute => attribute[1].toLowerCase() === name);
            return matches.length === 1 ? matches[0][2] ?? matches[0][3] ?? matches[0][4] : null;
        };
        if (value('id') !== '__NEXT_DATA__' || value('type')?.toLowerCase() !== 'application/json') continue;
        let payload: unknown;
        try { payload = JSON.parse(html.slice(bodyStart, end.index)); } catch { return null; }
        if (!object(payload) || !object(payload.props) || typeof payload.page !== 'string' || !payload.page.startsWith('/')) return null;
        const byPath = new Map<string, string>();
        const identities = new Set<string>();
        let visited = 0;
        let ambiguous = false;
        const visit = (node: unknown, depth: number): void => {
            if (ambiguous || !node || typeof node !== 'object') return;
            if (++visited > 50_000 || depth > 64) { ambiguous = true; return; }
            if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return; }
            const item = node as Record<string, unknown>;
            if (typeof item.PD_URL === 'string') {
                try {
                    const url = new URL(item.PD_URL, 'https://www.99acres.com');
                    const identity = url.pathname.match(/(?:spid|npxid)-([^/?#]+)/i)?.[0].toLowerCase();
                    if (!identity || url.protocol !== 'https:' || url.username || url.password || url.port
                        || !['www.99acres.com', '99acres.com'].includes(url.hostname)) { ambiguous = true; return; }
                    if (identities.has(identity)) { ambiguous = true; return; }
                    identities.add(identity);
                    // Serialize only this listing, never its neighbours. Numeric state fields
                    // use the same string representation accepted by the legacy extractor.
                    const own = Object.fromEntries(Object.entries(item).map(([key, value]) =>
                        [key, typeof value === 'number' ? String(value) : value]));
                    byPath.set(url.pathname.toLowerCase(), JSON.stringify(own));
                } catch { ambiguous = true; return; }
            }
            for (const child of Object.values(item)) visit(child, depth + 1);
        };
        visit(payload.props, 0);
        return !ambiguous && byPath.size ? { end: closing.lastIndex, byPath, kind: 'next-data', complete: true, sourceStart: opening.index } : null;
    }
    return null;
}

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
