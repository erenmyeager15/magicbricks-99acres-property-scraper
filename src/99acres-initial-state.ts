import type { Canonical99State } from './99acres-state.js';

interface Frame {
    kind: 'object' | 'array';
    start: number;
    phase: 'key-or-end' | 'key' | 'colon' | 'value-or-end' | 'value' | 'comma-or-end';
    keys: Set<string>;
}

// The observed portal embeds a JSON literal in window.__initialData__, rather
// than __NEXT_DATA__. Only complete own property objects may end a one-row read.
// No JavaScript is executed, no neighbouring fields or arbitrary PD_URL windows
// are treated as complete records. Unknown framing or unsupported syntax before
// a qualifying complete own record retains full transport; later state is not
// needed to enrich an already closed own property object.
export function readInitial99State(html: string): Canonical99State | null {
    const tokens = /<!--|<\/?([a-z][\w:-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
    let opening: RegExpExecArray | null;
    while ((opening = tokens.exec(html)) !== null) {
        if (opening[0] === '<!--') {
            const end = html.indexOf('-->', tokens.lastIndex);
            if (end < 0) return null;
            tokens.lastIndex = end + 3;
            continue;
        }
        const tag = opening[1].toLowerCase();
        if (/^<\//.test(opening[0]) || !['script', 'style', 'textarea', 'title', 'xmp'].includes(tag)) continue;
        const closing = new RegExp(`</${tag}\\s*>`, 'gi');
        closing.lastIndex = tokens.lastIndex;
        const end = closing.exec(html);
        const bodyStart = tokens.lastIndex;
        const body = html.slice(bodyStart, end?.index);
        const attributes = [...opening[0].matchAll(/\s([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)];
        const types = attributes.filter(attribute => attribute[1].toLowerCase() === 'type');
        const type = types.length === 1 ? types[0][2] ?? types[0][3] ?? types[0][4] : null;
        const external = attributes.some(attribute => attribute[1].toLowerCase() === 'src');
        const javascript = types.length === 0 || types.length === 1 && ['text/javascript', 'application/javascript'].includes(type?.toLowerCase() ?? '');
        const assignment = tag === 'script' && javascript && !external
            ? body.match(/^\s*window\.__initialData__\s*=\s*(?=\{)/) : null;
        if (assignment) {
            const state = ownStates(body, assignment[0].length, bodyStart);
            return state ? { ...state, sourceStart: opening.index } : null;
        }
        if (!end) return null;
        tokens.lastIndex = closing.lastIndex;
    }
    return null;
}

function ownStates(body: string, start: number, offset: number): Canonical99State | null {
    const frames: Frame[] = [];
    const byPath = new Map<string, string>();
    let cursor = start, latestOwnEnd = 0, count = 0, complete = false;
    const beginValue = () => {
        const parent = frames.at(-1);
        if (!parent) return frames.length === 0 && cursor === start;
        if (parent.phase !== 'value' && parent.phase !== 'value-or-end') return false;
        parent.phase = 'comma-or-end';
        return true;
    };
    while (cursor < body.length && count++ < 100_000) {
        if (/\s/.test(body[cursor])) { cursor += 1; continue; }
        const char = body[cursor];
        const parent = frames.at(-1);
        if (char === '{' || char === '[') {
            if (!beginValue() || frames.length >= 64) break;
            frames.push({ kind: char === '{' ? 'object' : 'array', start: cursor,
                phase: char === '{' ? 'key-or-end' : 'value-or-end', keys: new Set() });
            cursor += 1;
        } else if (char === '}' || char === ']') {
            if (!parent || (char === '}' ? parent.kind !== 'object' : parent.kind !== 'array')
                || !['key-or-end', 'value-or-end', 'comma-or-end'].includes(parent.phase)) break;
            frames.pop(); cursor += 1;
            if (parent.kind === 'object' && parent.keys.has('PD_URL')) {
                let own: Record<string, unknown>;
                try { own = JSON.parse(body.slice(parent.start, cursor)); } catch { break; }
                const path = ownPropertyPath(own);
                if (path && !byPath.has(path)) {
                    // First complete own record wins; unrelated later scripts/state
                    // cannot revise or enrich an already selected property.
                    byPath.set(path, JSON.stringify(propertyFields(own))); latestOwnEnd = cursor + offset;
                }
            }
            if (!frames.length) { complete = true; break; }
        } else if (char === '"') {
            const end = stringEnd(body, cursor);
            if (end === null) break;
            let value: string;
            try { value = JSON.parse(body.slice(cursor, end)); } catch { break; }
            if (parent?.kind === 'object' && ['key', 'key-or-end'].includes(parent.phase)) {
                if (parent.keys.has(value)) break;
                parent.keys.add(value); parent.phase = 'colon';
            } else if (!beginValue()) break;
            cursor = end;
        } else if (char === ':') {
            if (parent?.kind !== 'object' || parent.phase !== 'colon') break;
            parent.phase = 'value'; cursor += 1;
        } else if (char === ',') {
            if (!parent || parent.phase !== 'comma-or-end') break;
            parent.phase = parent.kind === 'object' ? 'key' : 'value'; cursor += 1;
        } else {
            const primitive = body.slice(cursor).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=[\s,}\]])/);
            if (!primitive || !beginValue()) break;
            cursor += primitive[0].length;
        }
    }
    return byPath.size ? { end: latestOwnEnd, byPath, kind: 'initial-data', complete } : null;
}

function stringEnd(text: string, start: number): number | null {
    for (let cursor = start + 1; cursor < text.length; cursor += 1) {
        if (text[cursor] === '"') return cursor + 1;
        if (text[cursor] === '\\') cursor += 1;
        else if (text.charCodeAt(cursor) < 0x20) return null;
    }
    return null;
}

function ownPropertyPath(own: Record<string, unknown>): string | null {
    if (typeof own.PD_URL !== 'string' || !Object.hasOwn(own, 'MIN_PRICE')) return null;
    const amount = typeof own.MIN_PRICE === 'number' ? own.MIN_PRICE : Number(String(own.MIN_PRICE).replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) return null;
    try {
        const url = new URL(own.PD_URL, 'https://www.99acres.com');
        const id = url.pathname.match(/-spid-([a-z0-9]+)$/i)?.[1];
        // Published links may have alphanumeric IDs, and internal SPID is not
        // the public URL identity. Association uses exact PD_URL + JSON-LD path,
        // never an internal identifier or another record's price/area.
        if (!id || url.protocol !== 'https:' || url.username || url.password || url.port
            || !['www.99acres.com', '99acres.com'].includes(url.hostname)) return null;
        return url.pathname.toLowerCase();
    } catch { return null; }
}

function propertyFields(own: Record<string, unknown>): Record<string, unknown> {
    // A property object can also contain dealer/profile metadata. Only direct
    // property fields and its dedicated photo/geo containers enrich the row.
    const names = ['PD_URL', 'SPID', 'PREFERENCE', 'MIN_PRICE', 'PRICE_IN_WORDS',
        'SUPERBUILTUP_AREA', 'SUPERBUILTUPAREA_UNIT', 'CARPET_AREA', 'CARPETAREA_UNIT', 'BUILTUP_AREA', 'BUILTUPAREA_UNIT',
        'LOCALIZED_AREA_TYPE', 'AREA_TYPE', 'BEDROOM_NUM', 'BATHROOM_NUM', 'FURNISH_LABEL', 'FLOOR_NUMBER', 'FLOOR_NUM',
        'PROP_TYPE_LABEL', 'PROP_NAME', 'localityLabel', 'LOCALITY_NAME', 'CITY', 'LATITUDE', 'LONGITUDE',
        'POSTED_BY', 'CLASS_LABEL', 'CONTACT_TYPE', 'CLASS', 'IS_VERIFIED', 'VERIFIED', 'IS_FEATURED', 'FEATURED',
        'POSTING_DATE', 'POSTED_DATE', 'POSTED_ON', 'UPDATE_DATE', 'AGE_LABEL', 'AGE_OF_PROPERTY', 'FACING_LABEL', 'FACING',
        'OWNERSHIP_TYPE', 'OWNERSHIP', 'PARKING_LABEL', 'PARKING', 'RERA_ID', 'RERA_REGISTRATION_ID',
        'MAINTENANCE', 'MAINTENANCE_CHARGES', 'PHOTO_URL', 'MEDIUM_PHOTO_URL', 'photoUrl'];
    const fields: Record<string, unknown> = {};
    for (const name of names) if (Object.hasOwn(own, name) && (own[name] === null || typeof own[name] !== 'object')) {
        fields[name] = typeof own[name] === 'number' ? String(own[name]) : own[name];
    }
    if (own.MAP_DETAILS && typeof own.MAP_DETAILS === 'object' && !Array.isArray(own.MAP_DETAILS)) {
        const geo = own.MAP_DETAILS as Record<string, unknown>;
        for (const name of ['LATITUDE', 'LONGITUDE']) if (!Object.hasOwn(fields, name) && ['string', 'number'].includes(typeof geo[name])) fields[name] = String(geo[name]);
    }
    for (const name of ['PROPERTY_IMAGES', 'THUMBNAIL_IMAGES', 'SPRITE_IMAGES', 'image', 'images', 'imageUrl', 'imageUrls']) {
        if (Object.hasOwn(own, name)) fields[name] = own[name];
    }
    return fields;
}
