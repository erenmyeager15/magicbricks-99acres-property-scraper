import type {
    ActorInput,
    NormalizedInput,
    PropertySource,
    SearchUrlDefinition,
    TransactionType,
} from './types.js';

const DEFAULT_CITIES = ['Mumbai'];
const DEFAULT_PROXY: Record<string, unknown> = {
    useApifyProxy: true,
    apifyProxyGroups: ['RESIDENTIAL'],
    apifyProxyCountry: 'IN',
};
const MAX_CITIES = 20;
const MAX_RESULTS = 500;
const MAX_SEARCH_URLS = 10;

function titleFromSlug(value: string): string {
    return value
        .split(/[-_]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function cityFromSearchUrl(url: URL, source: Exclude<PropertySource, 'both'>, fallbackCity: string): string {
    const queryCity = url.searchParams.get('cityName')
        ?? url.searchParams.get('city')
        ?? url.searchParams.get('city_name');
    if (queryCity?.trim()) return queryCity.replace(/\s+/g, ' ').trim();

    const decodedPath = decodeURIComponent(url.pathname);
    const pathMatch = source === '99acres'
        ? decodedPath.match(/property(?:-for-rent)?-in-(.+?)-ffid(?:-|\/|$)/i)
        : decodedPath.match(/property-for-(?:sale|rent)-in-([^/?]+)/i);

    return pathMatch?.[1] ? titleFromSlug(pathMatch[1]) : fallbackCity;
}

function searchUrlSource(url: URL): Exclude<PropertySource, 'both'> | null {
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'magicbricks.com' || hostname.endsWith('.magicbricks.com')) return 'magicbricks';
    if (hostname === '99acres.com' || hostname.endsWith('.99acres.com')) return '99acres';
    return null;
}

function normalizeSearchUrls(value: unknown, fallbackCity: string): SearchUrlDefinition[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new Error('searchUrls must be an array of MagicBricks or 99acres URLs.');
    if (value.length > MAX_SEARCH_URLS) throw new Error(`searchUrls supports at most ${MAX_SEARCH_URLS} URLs.`);

    const seen = new Set<string>();
    const output: SearchUrlDefinition[] = [];

    for (const rawValue of value) {
        if (typeof rawValue !== 'string' || !rawValue.trim()) {
            throw new Error('Each searchUrls item must be a non-empty URL string.');
        }
        if (rawValue.length > 2_048) throw new Error('Each searchUrls item must be 2,048 characters or fewer.');

        let url: URL;
        try {
            url = new URL(rawValue.trim());
        } catch {
            throw new Error(`Invalid search URL: ${rawValue}`);
        }

        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
            throw new Error(`Search URL must be a standard public HTTPS URL: ${rawValue}`);
        }

        const source = searchUrlSource(url);
        if (!source) throw new Error(`Search URL must use magicbricks.com or 99acres.com: ${rawValue}`);

        url.protocol = 'https:';
        url.hash = '';
        const normalizedUrl = url.toString();
        if (seen.has(normalizedUrl)) continue;
        seen.add(normalizedUrl);

        const transactionType: TransactionType = /property-for-rent|\brent\b/i.test(`${url.pathname} ${url.search}`)
            ? 'rent'
            : 'sale';
        const city = cityFromSearchUrl(url, source, fallbackCity);

        output.push({
            source,
            transactionType,
            city,
            citySlug: city.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'custom-search',
            url: normalizedUrl,
        });
    }

    return output;
}

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
    const normalizedCities = cities.length ? cities : DEFAULT_CITIES;
    const searchUrls = normalizeSearchUrls(input?.searchUrls, normalizedCities[0]);
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
        searchUrls,
        source,
        transactionType,
        cities: normalizedCities,
        minPrice,
        maxPrice,
        maxResults,
        proxyConfiguration: normalizeProxyConfiguration(input?.proxyConfiguration),
    };
}
