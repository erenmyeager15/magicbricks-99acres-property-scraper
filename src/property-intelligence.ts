import { createHash } from 'node:crypto';
import type { NormalizedInput, PropertyRecord } from './types.js';

export const MAX_MONITORED_PROPERTIES = 2_000;
export const MAX_OBSERVATIONS = 10;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const propertyKey = (row: PropertyRecord) => `${row.source}:${row.propertyId || row.propertyUrl}`;

export function squareFeet(area: number | null, unit: string | null): number | null {
    if (area === null || !Number.isFinite(area) || area <= 0 || !unit) return null;
    const normalized = unit.toLowerCase().replace(/[.\s_-]+/g, '');
    const factor = ['sqft', 'squarefeet', 'squarefoot', 'ft2', 'ft²'].includes(normalized) ? 1
        : ['sqm', 'sqmeter', 'sqmeters', 'squaremeter', 'squaremeters', 'm2', 'm²', 'mtk'].includes(normalized) ? 10.7639
        : ['sqyd', 'squareyard', 'squareyards', 'yd2', 'yd²'].includes(normalized) ? 9 : null;
    return factor ? Math.round(area * factor * 100) / 100 : null;
}

export function addPropertyIntelligence(row: PropertyRecord): PropertyRecord {
    const areaSqft = squareFeet(row.area, row.areaUnit);
    const qualityFlags: string[] = [];
    if (row.price === null || !Number.isFinite(row.price) || row.price <= 0) qualityFlags.push('price_missing_or_invalid');
    if (/[-–]\s*(?:₹|Rs\.?|INR)?\s*\d/.test(row.priceDisplay ?? '')) qualityFlags.push('price_range');
    if (areaSqft === null) qualityFlags.push('area_missing_or_unsupported');
    if (!row.areaType) qualityFlags.push('area_basis_unknown');
    const priceBasis = row.transactionType === 'sale' ? 'asking_sale'
        : /(?:\/\s*(?:month|mo)\b|per\s+month|monthly)/i.test(row.priceDisplay ?? '') ? 'monthly_rent' : 'unknown';
    if (priceBasis === 'unknown') qualityFlags.push('rent_period_unknown');
    const label = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();
    const comparable = qualityFlags.length === 0 && row.locality && row.propertyType && row.bhk !== null;
    const comparisonKey = comparable
        ? [row.transactionType, priceBasis, row.city ?? row.cityQuery, row.locality!, row.propertyType!, String(row.bhk), row.areaType!].map(label).join('|')
        : null;
    return { ...row, areaSqft, priceBasis, comparisonKey, qualityFlags };
}

export function monitorScope(input: NormalizedInput, searchKeys: string[]): string {
    return createHash('sha256').update(JSON.stringify({
        searchKeys: [...new Set(searchKeys)].sort(), minPrice: input.minPrice, maxPrice: input.maxPrice,
        maxResults: input.maxResults, version: 1,
    })).digest('hex');
}

interface Snapshot {
    key: string; source: PropertyRecord['source']; propertyUrl: string;
    price: number | null; priceBasis: string; areaSqft: number | null; areaType: string | null;
    range: boolean; firstSeenAt: string; lastSeenAt: string;
    observations: Array<{ at: string; price: number | null }>;
}
export interface MonitorState { version: 1; scope: string; observedAt: string; entries: Snapshot[] }
export interface PropertyChange {
    key: string; source: PropertyRecord['source']; propertyUrl: string;
    change: 'FIRST_SEEN' | 'PRICE_INCREASE' | 'PRICE_DECREASE' | 'UPDATED' | 'UNCHANGED' | 'NOT_OBSERVED';
    previousPrice: number | null; price: number | null; priceChangePercent: number | null;
    priceAlert: boolean; priceComparable: boolean; firstSeenAt: string; lastSeenAt: string;
}
export interface PropertyReport {
    version: 1; observedAt: string; scope: string; baseline: boolean;
    coverage: Record<string, unknown>; changes: PropertyChange[];
    sampleBenchmarks: Array<{ comparisonKey: string; sampleSize: number; medianPricePerSqft: number }>;
    note: string;
}

export function readMonitorState(value: unknown): MonitorState | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid saved property-monitor state; use a new store name.');
    const candidate = value as MonitorState;
    if (candidate.version !== 1 || typeof candidate.scope !== 'string'
        || !Number.isFinite(Date.parse(candidate.observedAt)) || !Array.isArray(candidate.entries)
        || candidate.entries.length > MAX_MONITORED_PROPERTIES) throw new Error('Unsupported saved property-monitor state.');
    const keys = new Set<string>();
    for (const entry of candidate.entries) {
        if (!entry || typeof entry.key !== 'string' || typeof entry.propertyUrl !== 'string'
            || entry.key.length > 4_096 || entry.propertyUrl.length > 4_096 || keys.has(entry.key)
            || !['magicbricks', '99acres'].includes(entry.source) || !Number.isFinite(Date.parse(entry.lastSeenAt))
            || !Number.isFinite(Date.parse(entry.firstSeenAt)) || !Array.isArray(entry.observations)
            || entry.observations.length > MAX_OBSERVATIONS || (entry.price !== null && !Number.isFinite(entry.price))
            || !['asking_sale', 'monthly_rent', 'unknown'].includes(entry.priceBasis) || typeof entry.range !== 'boolean'
            || (entry.areaSqft !== null && (!Number.isFinite(entry.areaSqft) || entry.areaSqft <= 0))
            || (entry.areaType !== null && (typeof entry.areaType !== 'string' || entry.areaType.length > 256))
            || Date.parse(entry.firstSeenAt) > Date.parse(entry.lastSeenAt) || Date.parse(entry.lastSeenAt) > Date.parse(candidate.observedAt)
            || entry.observations.some(observation => !observation || !Number.isFinite(Date.parse(observation.at))
                || Date.parse(observation.at) > Date.parse(entry.lastSeenAt)
                || (observation.price !== null && !Number.isFinite(observation.price)))) {
            throw new Error('Corrupt saved property-monitor entry.');
        }
        keys.add(entry.key);
    }
    return candidate;
}

export function buildPropertyReport(
    records: PropertyRecord[], prior: MonitorState | null, scope: string, observedAt: string,
    threshold: number, coverage: Record<string, unknown>,
): { state: MonitorState; report: PropertyReport } {
    const now = Date.parse(observedAt);
    if (!Number.isFinite(now)) throw new Error('Invalid observation time.');
    if (prior && prior.scope !== scope) throw new Error('Monitor inputs changed. Use a different monitorStoreName for a different search window.');
    if (prior && Date.parse(prior.observedAt) >= now) throw new Error('A newer or identical observation is already saved; stale run was not committed.');
    const previous = new Map((prior?.entries ?? []).filter(e => now - Date.parse(e.lastSeenAt) <= RETENTION_MS).map(e => [e.key, e]));
    const entries = new Map(previous);
    const changes: PropertyChange[] = [];
    const rows = [...new Map(records.map(row => [propertyKey(row), addPropertyIntelligence(row)])).values()];
    for (const row of rows) {
        const key = propertyKey(row);
        const old = previous.get(key);
        const range = row.qualityFlags!.includes('price_range');
        const priceComparable = Boolean(old && old.price !== null && old.price > 0 && row.price !== null && row.price > 0
            && !old.range && !range && old.priceBasis === row.priceBasis && row.priceBasis !== 'unknown'
            && old.areaSqft === row.areaSqft && old.areaType === row.areaType);
        const delta = priceComparable ? Math.round((row.price! - old!.price!) / old!.price! * 10_000) / 100 : null;
        const changed = old && (old.price !== row.price || old.priceBasis !== row.priceBasis
            || old.areaSqft !== row.areaSqft || old.areaType !== row.areaType || old.range !== range);
        changes.push({ key, source: row.source, propertyUrl: row.propertyUrl,
            change: !old ? 'FIRST_SEEN' : delta !== null && delta > 0 ? 'PRICE_INCREASE'
                : delta !== null && delta < 0 ? 'PRICE_DECREASE' : changed ? 'UPDATED' : 'UNCHANGED',
            previousPrice: old?.price ?? null, price: row.price, priceChangePercent: delta,
            priceAlert: delta !== null && delta !== 0 && Math.abs(delta) >= threshold,
            priceComparable, firstSeenAt: old?.firstSeenAt ?? observedAt, lastSeenAt: observedAt });
        entries.set(key, { key, source: row.source, propertyUrl: row.propertyUrl, price: row.price,
            priceBasis: row.priceBasis!, areaSqft: row.areaSqft!, areaType: row.areaType, range,
            firstSeenAt: old?.firstSeenAt ?? observedAt, lastSeenAt: observedAt,
            observations: [...(old?.observations ?? []), { at: observedAt, price: row.price }].slice(-MAX_OBSERVATIONS) });
        previous.delete(key);
    }
    for (const entry of previous.values()) changes.push({ key: entry.key, source: entry.source, propertyUrl: entry.propertyUrl,
        change: 'NOT_OBSERVED', previousPrice: entry.price, price: null, priceChangePercent: null,
        priceAlert: false, priceComparable: false, firstSeenAt: entry.firstSeenAt, lastSeenAt: entry.lastSeenAt });
    const groups = new Map<string, number[]>();
    for (const row of rows) if (row.comparisonKey && row.pricePerSqft !== null && row.pricePerSqft > 0) {
        const list = groups.get(row.comparisonKey) ?? []; list.push(row.pricePerSqft); groups.set(row.comparisonKey, list);
    }
    const sampleBenchmarks = [...groups].filter(([, values]) => values.length >= 3).map(([comparisonKey, values]) => {
        values.sort((a, b) => a - b);
        const middle = Math.floor(values.length / 2);
        return { comparisonKey, sampleSize: values.length,
            medianPricePerSqft: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2 };
    });
    return {
        state: { version: 1, scope, observedAt, entries: [...entries.values()]
            .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt)).slice(0, MAX_MONITORED_PROPERTIES) },
        report: { version: 1, observedAt, scope, baseline: !prior, coverage, changes, sampleBenchmarks,
            note: 'Bounded search sample, not a full market census or valuation. FIRST_SEEN means new to this watchlist, not newly posted. NOT_OBSERVED does not mean sold, rented or removed. Cross-portal IDs remain separate.' },
    };
}

export function propertyChangesCsv(report: PropertyReport): string {
    const fields: Array<keyof PropertyChange> = ['source', 'key', 'propertyUrl', 'change', 'previousPrice', 'price',
        'priceChangePercent', 'priceAlert', 'priceComparable', 'firstSeenAt', 'lastSeenAt'];
    const cell = (value: unknown) => {
        let text = value == null ? '' : String(value);
        if (typeof value === 'string' && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
        return `"${text.replace(/"/g, '""')}"`;
    };
    return [fields.join(','), ...report.changes.map(row => fields.map(field => cell(row[field])).join(','))].join('\r\n') + '\r\n';
}
