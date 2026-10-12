import type {
    ActorInput,
    NormalizedInput,
    PropertySource,
    SearchUrlDefinition,
    TransactionType,
} from './types.js';
import { PropertyFailureError } from './failures.js';

function invalidInput(message: string): never {
    throw new PropertyFailureError({ category: 'INPUT_INVALID', message });
}

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

    let decodedPath: string;
    try { decodedPath = decodeURIComponent(url.pathname); }
    catch { return invalidInput('Search URL path must contain valid URL-encoded characters.'); }
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

export function searchUrlStartPage(url: URL, source: Exclude<PropertySource, 'both'>): number {
    const pages = url.searchParams.getAll('page');
    const pathPage = source === '99acres'
        ? url.pathname.match(/-ffid-page-([^/]+)\/?$/i)?.[1] : undefined;
    if (pathPage !== undefined) pages.push(pathPage);
    if (pages.length === 0) return 1;

    const numbers = pages.map(value => /^\d+$/.test(value) ? Number(value) : NaN);
    if (numbers.some(page => !Number.isSafeInteger(page) || page < 1 || page > Number.MAX_SAFE_INTEGER - 20)
        || numbers.some(page => page !== numbers[0])) {
        invalidInput('Search URL starting page must be one positive integer, with matching path and query page values.');
    }
    return numbers[0];
}

function searchUrlValue(rawValue: unknown): string | null {
    if (typeof rawValue === 'string') return rawValue;
    if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)
        && typeof (rawValue as { url?: unknown }).url === 'string') {
        return (rawValue as { url: string }).url;
    }
    return null;
}

function normalizeSearchUrls(value: unknown, fallbackCity: string): SearchUrlDefinition[] {
    if (value === undefined || value === null) return [];
    const values = Array.isArray(value) ? value : [value];
    if (values.length > MAX_SEARCH_URLS) invalidInput(`searchUrls supports at most ${MAX_SEARCH_URLS} URLs.`);

    const seen = new Set<string>();
    const output: SearchUrlDefinition[] = [];

    for (const rawValue of values) {
        const rawUrl = searchUrlValue(rawValue);
        if (!rawUrl?.trim()) {
            invalidInput('Each searchUrls item must be a URL string or an object containing a URL string.');
        }
        if (rawUrl.length > 2_048) invalidInput('Each searchUrls item must be 2,048 characters or fewer.');

        let url: URL;
        try {
            url = new URL(rawUrl.trim());
        } catch {
            invalidInput('Invalid search URL. Each searchUrls item must be a complete public portal URL.');
        }

        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
            invalidInput('Search URL must be a standard public HTTPS URL without credentials or a custom port.');
        }

        const source = searchUrlSource(url);
        if (!source) invalidInput('Search URL must use magicbricks.com or 99acres.com.');
        searchUrlStartPage(url, source);

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
        invalidInput(`${field} must be a non-negative INR amount.`);
    }
    return parsed;
}

function normalizeProxyConfiguration(input: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!input) return { ...DEFAULT_PROXY };
    const configuration = { ...input };
    if (configuration.useApifyProxy !== undefined && typeof configuration.useApifyProxy !== 'boolean') {
        invalidInput('proxyConfiguration.useApifyProxy must be true or false.');
    }
    if (configuration.proxyUrls !== undefined) {
        if (!Array.isArray(configuration.proxyUrls)) invalidInput('proxyUrls must be a list of HTTP or HTTPS proxy URLs.');
        if (configuration.proxyUrls.length === 0) {
            // An empty editor list is not a custom route. Preserve the explicit
            // Apify/off selection; do not infer permission to buy proxy traffic.
            if (configuration.useApifyProxy === undefined) {
                invalidInput('Empty proxyUrls requires an explicit useApifyProxy choice: true for Apify Proxy, or false for no proxy.');
            }
            delete configuration.proxyUrls;
        } else {
            for (const value of configuration.proxyUrls) {
                let url: URL;
                try {
                    if (typeof value !== 'string' || !value.trim()) throw new Error();
                    url = new URL(value);
                    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error();
                } catch {
                    invalidInput('proxyUrls must contain complete HTTP or HTTPS proxy URLs; blank and null entries are not supported.');
                }
            }
            return configuration;
        }
    }
    if (configuration.useApifyProxy === false) return configuration;
    return {
        ...DEFAULT_PROXY,
        ...configuration,
    };
}

function normalizeCities(value: unknown): string[] {
    if (value === undefined || value === null) return DEFAULT_CITIES;
    const values = Array.isArray(value) ? value : [value];
    if (values.some(city => typeof city !== 'string')) invalidInput('cities must contain Indian city names.');
    const cities = [...new Set(values
        .map(city => String(city).replace(/\s+/g, ' ').trim())
        .filter(Boolean))].slice(0, MAX_CITIES);
    return cities.length ? cities : DEFAULT_CITIES;
}

function hasSuppliedValues(value: unknown): boolean {
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'string') return value.trim().length > 0;
    return value !== undefined && value !== null;
}

export function normalizeInput(input: ActorInput | null): NormalizedInput {
    if (input !== null && (typeof input !== 'object' || Array.isArray(input))) invalidInput('Actor input must be a JSON object.');
    if (input?.monitorStoreName !== undefined && input.monitorStoreName !== null && typeof input.monitorStoreName !== 'string') {
        invalidInput('monitorStoreName must be a text name, or omitted to disable monitoring.');
    }
    if (input?.proxyConfiguration !== undefined && input.proxyConfiguration !== null
        && (typeof input.proxyConfiguration !== 'object' || Array.isArray(input.proxyConfiguration))) {
        invalidInput('proxyConfiguration must be a proxy configuration object.');
    }
    const source: PropertySource = ['magicbricks', '99acres', 'both'].includes(input?.source ?? '')
        ? input?.source as PropertySource
        : 'magicbricks';
    const transactionType = input?.transactionType === 'rent' ? 'rent' : 'sale';
    if (input?.city !== undefined && input.city !== null && typeof input.city !== 'string') {
        invalidInput('city must be an Indian city name.');
    }
    const normalizedCities = normalizeCities(hasSuppliedValues(input?.cities) ? input?.cities : input?.city);
    const suppliedSearchUrls = hasSuppliedValues(input?.searchUrls)
        ? input?.searchUrls : input?.searchUrl ?? input?.startUrls;
    const searchUrls = normalizeSearchUrls(suppliedSearchUrls, normalizedCities[0]);
    const minPrice = normalizeMoneyFilter(input?.minPrice, 'minPrice');
    const maxPrice = normalizeMoneyFilter(input?.maxPrice, 'maxPrice');

    if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
        invalidInput('minPrice cannot be greater than maxPrice.');
    }

    const requestedMaxResults = Number(input?.maxResults ?? input?.maxItems ?? 1);
    const maxResults = Number.isFinite(requestedMaxResults)
        ? Math.min(Math.max(Math.floor(requestedMaxResults), 1), MAX_RESULTS)
        : 1;
    const monitorStoreName = input?.monitorStoreName?.trim() || null;
    if (monitorStoreName && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(monitorStoreName)) {
        invalidInput('monitorStoreName must be 1-63 letters, numbers, underscores or hyphens.');
    }
    const priceChangeThresholdPercent = input?.priceChangeThresholdPercent ?? 5;
    if (typeof priceChangeThresholdPercent !== 'number' || !Number.isFinite(priceChangeThresholdPercent)
        || priceChangeThresholdPercent < 0 || priceChangeThresholdPercent > 100) {
        invalidInput('priceChangeThresholdPercent must be a number between 0 and 100.');
    }

    return {
        searchUrls,
        source,
        transactionType,
        cities: normalizedCities,
        minPrice,
        maxPrice,
        maxResults,
        proxyConfiguration: normalizeProxyConfiguration(input?.proxyConfiguration),
        monitorStoreName,
        priceChangeThresholdPercent,
    };
}
