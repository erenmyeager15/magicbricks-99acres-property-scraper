import type { ActorInput, NormalizedInput, PropertySource } from './types.js';

const DEFAULT_CITIES = ['Mumbai'];
const DEFAULT_PROXY: Record<string, unknown> = {
    useApifyProxy: true,
    apifyProxyGroups: ['RESIDENTIAL'],
    apifyProxyCountry: 'IN',
};
const MAX_CITIES = 20;
const MAX_RESULTS = 500;

function normalizeMoneyFilter(value: unknown, field: string): number | null {
    if (value === null || value === undefined || value === '') return null;
    const parsed = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`${field} must be a non-negative INR amount.`);
    }
    return parsed;
}

function normalizeProxyConfiguration(input: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!input) return { ...DEFAULT_PROXY };
    if (input.useApifyProxy === false || Array.isArray(input.proxyUrls)) return { ...input };
    return {
        ...DEFAULT_PROXY,
        ...input,
    };
}

export function normalizeInput(input: ActorInput | null): NormalizedInput {
    const source: PropertySource = ['magicbricks', '99acres', 'both'].includes(input?.source ?? '')
        ? input?.source as PropertySource
        : 'magicbricks';
    const transactionType = input?.transactionType === 'rent' ? 'rent' : 'sale';
    const cities = [...new Set((input?.cities ?? DEFAULT_CITIES)
        .map((city) => String(city).replace(/\s+/g, ' ').trim())
        .filter(Boolean))].slice(0, MAX_CITIES);
    const minPrice = normalizeMoneyFilter(input?.minPrice, 'minPrice');
    const maxPrice = normalizeMoneyFilter(input?.maxPrice, 'maxPrice');

    if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
        throw new Error('minPrice cannot be greater than maxPrice.');
    }

    const requestedMaxResults = Number(input?.maxResults ?? 1);
    const maxResults = Number.isFinite(requestedMaxResults)
        ? Math.min(Math.max(Math.floor(requestedMaxResults), 1), MAX_RESULTS)
        : 1;

    return {
        source,
        transactionType,
        cities: cities.length ? cities : DEFAULT_CITIES,
        minPrice,
        maxPrice,
        maxResults,
        proxyConfiguration: normalizeProxyConfiguration(input?.proxyConfiguration),
    };
}
