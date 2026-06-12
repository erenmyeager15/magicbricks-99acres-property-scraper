import { Actor, log } from 'apify';
import { fetch, ProxyAgent, type Dispatcher } from 'undici';
import { createHash } from 'node:crypto';
import type { ActorInput, NormalizedInput, PropertyRecord, PropertySource, ScrapeJob } from './types.js';

const CHARGE_EVENT_NAME = 'property-scraped';
const DEFAULT_MAX_RESULTS = 50;
const MAX_RESULTS_CAP = 500;
const REQUEST_HEADERS = {
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-IN,en;q=0.9',
    'cache-control': 'no-cache',
    'pragma': 'no-cache',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
};

type ProxyConfiguration = Awaited<ReturnType<typeof Actor.createProxyConfiguration>>;
type AnyObject = Record<string, unknown>;
type StateListing = Omit<Partial<PropertyRecord>, 'area'> & {
    area?: { value: number | null; unit: string | null };
};

export async function scrapeProperties(rawInput: ActorInput): Promise<void> {
    const input = normalizeInput(rawInput);
    const sources = resolveSources(input.source);
    const proxyConfiguration = await Actor.createProxyConfiguration(input.proxyConfiguration);
    const jobs = buildJobs(input, sources);
    const seen = new Set<string>();
    const sourceCounts = new Map<string, number>();
    const attemptedSources = new Set<string>();
    let pushed = 0;

    log.info('Starting property scrape', {
        source: input.source,
        transactionType: input.transactionType,
        cities: input.cities,
        maxResults: input.maxResults,
    });

    for (const job of jobs) {
        if (pushed >= input.maxResults) break;

        log.info(`Fetching ${job.source} ${job.transactionType} listings`, {
            city: job.city,
            page: job.page,
            url: job.url,
        });

        try {
            const html = await fetchHtml(job.url, proxyConfiguration);
            const parsedRecords = job.source === 'magicbricks'
                ? parseMagicBricks(html, job)
                : parse99Acres(html, job);

            if (parsedRecords.length === 0) {
                log.warning('No records parsed from page', { source: job.source, city: job.city, page: job.page });
            }

            let pushedFromThisJob = 0;
            const softCap = Math.ceil(input.maxResults / sources.length);
            const balanceFirstPass = sources.length > 1 && attemptedSources.size < sources.length;

            for (const record of parsedRecords) {
                if (pushed >= input.maxResults) break;
                if (balanceFirstPass && (sourceCounts.get(job.source) ?? 0) >= softCap) break;

                const dedupeKey = record.propertyId || record.propertyUrl;
                if (seen.has(dedupeKey)) continue;
                if (!passesPriceFilter(record, input)) continue;

                seen.add(dedupeKey);
                await Actor.pushData(record);
                await Actor.charge({ eventName: CHARGE_EVENT_NAME });
                pushed += 1;
                pushedFromThisJob += 1;
                sourceCounts.set(job.source, (sourceCounts.get(job.source) ?? 0) + 1);
            }

            attemptedSources.add(job.source);
            log.info('Parsed page complete', {
                source: job.source,
                city: job.city,
                page: job.page,
                parsed: parsedRecords.length,
                pushedFromThisJob,
                totalPushed: pushed,
            });
        } catch (error) {
            attemptedSources.add(job.source);
            log.warning(`Skipping page after retries: ${(error as Error).message}`, {
                source: job.source,
                city: job.city,
                page: job.page,
                url: job.url,
            });
        }

        await delay(randomInt(900, 2200));
    }

    if (pushed === 0) {
        throw new Error('No property listings were scraped. Try a different city or enable Apify Proxy.');
    }

    log.info('Property scrape finished', { pushed, sourceCounts: Object.fromEntries(sourceCounts) });
}

function normalizeInput(input: ActorInput): NormalizedInput {
    const source: PropertySource = ['magicbricks', '99acres', 'both'].includes(input.source ?? '')
        ? input.source as PropertySource
        : 'both';
    const transactionType = input.transactionType === 'rent' ? 'rent' : 'sale';
    const cities = (input.cities?.length ? input.cities : ['Mumbai'])
        .map((city) => cleanText(city))
        .filter(Boolean)
        .slice(0, 20);

    return {
        source,
        transactionType,
        cities: cities.length ? cities : ['Mumbai'],
        minPrice: finiteNumber(input.minPrice),
        maxPrice: finiteNumber(input.maxPrice),
        maxResults: Math.min(Math.max(Math.floor(input.maxResults ?? DEFAULT_MAX_RESULTS), 1), MAX_RESULTS_CAP),
        proxyConfiguration: input.proxyConfiguration ?? {
            useApifyProxy: true,
            apifyProxyGroups: ['RESIDENTIAL'],
            apifyProxyCountry: 'IN',
        },
    };
}

function resolveSources(source: PropertySource): Array<Exclude<PropertySource, 'both'>> {
    if (source === 'magicbricks') return ['magicbricks'];
    if (source === '99acres') return ['99acres'];
    return ['magicbricks', '99acres'];
}

function buildJobs(input: NormalizedInput, sources: Array<Exclude<PropertySource, 'both'>>): ScrapeJob[] {
    const jobs: ScrapeJob[] = [];
    const max99Pages = Math.min(Math.ceil(input.maxResults / 25) + 2, 20);

    for (let page = 1; page <= max99Pages; page += 1) {
        for (const city of input.cities) {
            const citySlug = slugCity(city);

            for (const source of sources) {
                if (source === 'magicbricks' && page > 1) continue;
                jobs.push({
                    source,
                    transactionType: input.transactionType,
                    city,
                    citySlug,
                    page,
                    url: buildSourceUrl(source, input.transactionType, city, citySlug, page),
                });
            }
        }
    }

    return jobs;
}

function buildSourceUrl(
    source: Exclude<PropertySource, 'both'>,
    transactionType: 'sale' | 'rent',
    city: string,
    citySlug: string,
    page: number,
): string {
    if (source === 'magicbricks') {
        const path = transactionType === 'rent' ? 'property-for-rent' : 'property-for-sale';
        return `https://www.magicbricks.com/${path}/residential-real-estate?cityName=${encodeURIComponent(city)}`;
    }

    const prefix = transactionType === 'rent' ? `property-for-rent-in-${citySlug}` : `property-in-${citySlug}`;
    return page === 1
        ? `https://www.99acres.com/${prefix}-ffid`
        : `https://www.99acres.com/${prefix}-ffid-page-${page}`;
}

async function fetchHtml(url: string, proxyConfiguration: ProxyConfiguration): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;
            const dispatcher: Dispatcher | undefined = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
            const response = await fetch(url, {
                headers: REQUEST_HEADERS,
                dispatcher,
            });

            if ([403, 407, 429, 500, 502, 503, 504].includes(response.status)) {
                throw new Error(`HTTP ${response.status}`);
            }

            const html = await response.text();
            if (looksBlocked(html)) {
                throw new Error('Page appears blocked or challenged');
            }

            return html;
        } catch (error) {
            lastError = error as Error;
            if (attempt < 3) await delay(1000 * attempt + randomInt(250, 900));
        }
    }

    throw lastError ?? new Error('Request failed');
}

function looksBlocked(html: string): boolean {
    const lower = html.toLowerCase();
    const hasListings = lower.includes('mb-srp__card')
        || lower.includes('application/ld+json')
        || lower.includes('itemlistelement')
        || lower.includes('property-card');

    if (hasListings) return false;

    return lower.includes('captcha')
        || lower.includes('access denied')
        || lower.includes('unusual traffic')
        || lower.includes('enable cookies')
        || lower.includes('cloudflare');
}

function parseMagicBricks(html: string, job: ScrapeJob): PropertyRecord[] {
    const listItems = extractMagicListItems(html);
    const chunks = extractMagicCardChunks(html);
    const records: PropertyRecord[] = [];
    const maxItems = Math.max(listItems.length, chunks.length);

    for (let index = 0; index < maxItems; index += 1) {
        const listItem = listItems[index];
        const chunk = chunks[index] ?? '';
        const text = cleanText(stripHtml(chunk));
        const propertyUrl = absoluteUrl(listItem?.url ?? extractMagicUrl(chunk), 'https://www.magicbricks.com');

        if (!propertyUrl) continue;

        const title = cleanText(listItem?.name) || extractMagicTitle(text, job.city);
        const location = parseMagicLocation(title, job.city);
        const priceDisplay = extractPriceDisplay(text);
        const area = extractArea(text);
        const bhk = extractBhk(title) ?? extractBhk(text);
        const bathrooms = extractIntegerAfterLabel(text, 'Bathroom');
        const balconies = extractIntegerAfterLabel(text, 'Balcony');
        const projectName = location.projectName;

        records.push({
            source: 'magicbricks',
            transactionType: job.transactionType,
            cityQuery: job.city,
            propertyId: extractMagicId(propertyUrl) ?? stableId('magicbricks', propertyUrl),
            title: title || null,
            propertyType: extractPropertyType(`${title} ${text}`),
            bhk,
            price: parseIndianMoney(priceDisplay),
            priceDisplay,
            depositDisplay: extractDepositDisplay(text),
            area: area.value,
            areaUnit: area.unit,
            areaType: extractAreaType(text),
            bedrooms: bhk,
            bathrooms,
            balconies,
            furnishing: extractFurnishing(text),
            status: extractStatus(text, job.transactionType),
            floor: extractFloor(text),
            projectName,
            locality: location.locality,
            city: job.city,
            address: location.address,
            latitude: null,
            longitude: null,
            imageUrl: extractMagicImage(chunk),
            propertyUrl,
            description: text ? redactSensitiveText(truncate(text, 700)) : null,
            scrapedAt: new Date().toISOString(),
        });
    }

    return records;
}

function parse99Acres(html: string, job: ScrapeJob): PropertyRecord[] {
    const ldObjects = collectLdObjects(html);
    const propertyObjects = ldObjects.filter(is99PropertyObject);
    const stateByUrl = extract99StateByUrl(html);
    const records: PropertyRecord[] = [];
    const seenUrls = new Set<string>();

    for (const item of propertyObjects) {
        const url = absoluteUrl(asString(item.url), 'https://www.99acres.com');
        if (!url || seenUrls.has(url)) continue;
        seenUrls.add(url);

        const state = find99StateForUrl(stateByUrl, url);
        const title = cleanText(asString(item.name));
        const description = redactSensitiveText(cleanText(asString(item.description)));
        const address = asObject(item.address);
        const geo = asObject(item.geo);
        const rooms = cleanText(asString(item.numberOfRooms ?? item['numberOfRooms ']));
        const bhk = extractBhk(`${rooms} ${title}`) ?? extractBhk(description);
        const floorSize = extractFloorSize(item.floorSize);
        const descriptionArea = extractArea(description);
        const priceText = [
            extractOfferPrice(item),
            description,
            title,
            extractTextNearUrl(html, url),
        ].filter(Boolean).join(' ');
        const priceDisplay = state.priceDisplay ?? extractPriceDisplay(priceText);
        const stateArea = state.area ?? { value: null, unit: null };

        records.push({
            source: '99acres',
            transactionType: job.transactionType,
            cityQuery: job.city,
            propertyId: extract99AcresId(url) ?? stableId('99acres', url),
            title: title || null,
            propertyType: state.propertyType ?? extractPropertyType(`${title} ${description}`) ?? 'Apartment',
            bhk: bhk ?? state.bhk ?? null,
            price: state.price ?? parseIndianMoney(priceDisplay),
            priceDisplay,
            depositDisplay: extractDepositDisplay(priceText),
            area: floorSize.value ?? stateArea.value ?? descriptionArea.value,
            areaUnit: floorSize.unit ?? stateArea.unit ?? descriptionArea.unit,
            areaType: state.areaType ?? (floorSize.value ? 'Built-up Area' : extractAreaType(description)),
            bedrooms: bhk ?? state.bhk ?? null,
            bathrooms: finiteNumber(item.numberOfBathroomsTotal) ?? state.bathrooms ?? null,
            balconies: null,
            furnishing: state.furnishing ?? extractFurnishing(description),
            status: extractStatus(description, job.transactionType),
            floor: cleanText(asString(item.floorlevel)) || state.floor || extractFloor(description),
            projectName: cleanText(asString(address.name)) || state.projectName || (is99ProjectUrl(url) ? title : null),
            locality: cleanText(asString(address.streetAddress)) || state.locality || cleanText(asString(address.addressLocality)) || null,
            city: cleanText(asString(address.addressLocality)) || state.city || job.city,
            address: buildAddress(address),
            latitude: finiteNumber(geo.latitude) ?? state.latitude ?? null,
            longitude: finiteNumber(geo.longitude) ?? state.longitude ?? null,
            imageUrl: state.imageUrl ?? extract99AcresImage(html, url),
            propertyUrl: url,
            description: description ? truncate(description, 800) : null,
            scrapedAt: new Date().toISOString(),
        });
    }

    return records;
}

function passesPriceFilter(record: PropertyRecord, input: NormalizedInput): boolean {
    if (input.minPrice === null && input.maxPrice === null) return true;
    if (record.price === null) return false;
    if (input.minPrice !== null && record.price < input.minPrice) return false;
    if (input.maxPrice !== null && record.price > input.maxPrice) return false;
    return true;
}

function extractMagicListItems(html: string): Array<{ name: string | null; url: string | null }> {
    const lists: unknown[] = [];
    for (const object of collectLdObjects(html)) findItemLists(object, lists);

    const itemList = lists
        .map((list) => Array.isArray((list as AnyObject).itemListElement) ? (list as AnyObject).itemListElement as unknown[] : [])
        .find((items) => items.some((item) => Boolean(extractListItemUrl(item))));

    if (!itemList) return [];

    return itemList
        .map((item) => ({
            name: cleanText(extractListItemName(item)) || null,
            url: extractListItemUrl(item),
        }))
        .filter((item) => item.url);
}

function extractMagicCardChunks(html: string): string[] {
    const starts: number[] = [];
    const re = /<div[^>]+class=["'][^"']*\bmb-srp__card\b(?![-_])[^"']*["'][^>]*>/gi;
    let match: RegExpExecArray | null;

    while ((match = re.exec(html)) !== null) {
        starts.push(match.index);
    }

    return starts.map((start, index) => html.slice(start, starts[index + 1] ?? html.length));
}

function extractMagicUrl(chunk: string): string | null {
    const href = chunk.match(/href=["']([^"']*magicbricks\.com[^"']+)["']/i)?.[1]
        ?? chunk.match(/href=["']([^"']*propertyDetails[^"']+)["']/i)?.[1];
    return href ? decodeHtml(href.replace(/\\\//g, '/')) : null;
}

function extractMagicTitle(text: string, city: string): string | null {
    const cityIndex = text.toLowerCase().indexOf(city.toLowerCase());
    if (cityIndex > 20) return cleanText(text.slice(0, cityIndex + city.length));
    return cleanText(text.split(/(?:\u20b9|Rs\.?|\bContact\b)/i)[0]) || null;
}

function extractMagicId(url: string): string | null {
    const decodedUrl = decodeURIComponent(url);
    return decodedUrl.match(/[?&]id=([^&]+)/i)?.[1]
        ?? decodedUrl.match(/\/([^/?#]+)\.htm/i)?.[1]
        ?? null;
}

function parseMagicLocation(title: string | null, city: string): { projectName: string | null; locality: string | null; address: string | null } {
    if (!title) return { projectName: null, locality: null, address: city };

    const afterIn = title.match(/\bin\s+(.+)$/i)?.[1] ?? '';
    if (!afterIn) return { projectName: null, locality: null, address: city };

    const parts = afterIn
        .split(',')
        .map((part) => stripCitySuffix(cleanText(part), city))
        .filter(Boolean);

    const projectName = parts.length > 1 ? parts[0] : null;
    const locality = parts.length ? parts[parts.length - 1] : null;
    const address = [...parts, city].filter(Boolean).join(', ');

    return { projectName, locality, address };
}

function collectLdObjects(html: string): AnyObject[] {
    const output: AnyObject[] = [];
    const scriptRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match: RegExpExecArray | null;

    while ((match = scriptRe.exec(html)) !== null) {
        const rawJson = decodeHtml(match[1].trim());
        if (!rawJson) continue;

        try {
            const parsed = JSON.parse(rawJson) as unknown;
            flattenLd(parsed, output);
        } catch {
            const cleaned = rawJson.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
            try {
                const parsed = JSON.parse(cleaned) as unknown;
                flattenLd(parsed, output);
            } catch {
                // Ignore malformed structured-data blocks and continue with the next script.
            }
        }
    }

    return output;
}

function flattenLd(value: unknown, output: AnyObject[]): void {
    if (Array.isArray(value)) {
        value.forEach((entry) => flattenLd(entry, output));
        return;
    }

    if (!isObject(value)) return;
    output.push(value);

    const graph = value['@graph'];
    if (Array.isArray(graph)) graph.forEach((entry) => flattenLd(entry, output));
}

function findItemLists(value: unknown, output: unknown[]): void {
    if (Array.isArray(value)) {
        value.forEach((item) => findItemLists(item, output));
        return;
    }

    if (!isObject(value)) return;
    if (Array.isArray(value.itemListElement)) output.push(value);

    for (const nestedValue of Object.values(value)) {
        if (typeof nestedValue === 'object' && nestedValue !== null) findItemLists(nestedValue, output);
    }
}

function is99PropertyObject(item: AnyObject): boolean {
    const type = item['@type'];
    const types = Array.isArray(type) ? type.map(String) : [String(type ?? '')];
    return types.some((value) => ['Apartment', 'House', 'Residence', 'Product'].includes(value))
        && Boolean(asString(item.url))
        && Boolean(asString(item.name));
}

function extractListItemUrl(item: unknown): string | null {
    if (!isObject(item)) return null;
    const nestedItem = asObject(item.item);
    return asString(item.url) || asString(nestedItem.url) || null;
}

function extractListItemName(item: unknown): string | null {
    if (!isObject(item)) return null;
    const nestedItem = asObject(item.item);
    return asString(item.name) || asString(nestedItem.name) || null;
}

function extract99AcresId(url: string): string | null {
    return url.match(/(?:spid|npxid)-([^/?#]+)/i)?.[1]
        ?? url.match(/\/([^/?#]+?)(?:\?|\#|$)/)?.[1]
        ?? null;
}

function is99ProjectUrl(url: string): boolean {
    return /npxid-/i.test(url);
}

function extract99StateByUrl(html: string): Map<string, StateListing> {
    const map = new Map<string, StateListing>();
    const pdUrlRe = /"PD_URL"\s*:\s*"((?:\\.|[^"\\])+)"/g;
    let match: RegExpExecArray | null;

    while ((match = pdUrlRe.exec(html)) !== null) {
        const path = decodeJsonString(match[1]);
        const url = absoluteUrl(path, 'https://www.99acres.com');
        if (!url) continue;

        const windowText = html.slice(Math.max(0, match.index - 5000), Math.min(html.length, match.index + 4500));
        const priceDisplay = captureJsonString(windowText, 'PRICE_IN_WORDS');
        const minPrice = finiteNumber(captureJsonString(windowText, 'MIN_PRICE'));
        const area = extract99StateArea(windowText);
        const propertyType = extractPropertyType(captureJsonString(windowText, 'PROP_TYPE_LABEL') ?? '');
        const imageUrl = captureJsonString(windowText, 'photoUrl') ?? captureJsonString(windowText, 'PHOTO_URL');

        map.set(new URL(url).pathname.toLowerCase(), {
            price: minPrice,
            priceDisplay,
            area,
            areaType: captureJsonString(windowText, 'LOCALIZED_AREA_TYPE') ?? capture99AreaType(windowText),
            bhk: finiteNumber(captureJsonString(windowText, 'BEDROOM_NUM')),
            bathrooms: finiteNumber(captureJsonString(windowText, 'BATHROOM_NUM')),
            furnishing: normalizeNullableLabel(captureJsonString(windowText, 'FURNISH_LABEL')),
            floor: captureJsonString(windowText, 'FLOOR_NUMBER') ?? captureJsonString(windowText, 'FLOOR_NUM'),
            projectName: captureJsonString(windowText, 'PROP_NAME'),
            locality: captureJsonString(windowText, 'localityLabel') ?? captureJsonString(windowText, 'LOCALITY_NAME'),
            city: captureJsonString(windowText, 'CITY'),
            latitude: finiteNumber(captureJsonString(windowText, 'LATITUDE')),
            longitude: finiteNumber(captureJsonString(windowText, 'LONGITUDE')),
            imageUrl,
            propertyUrl: url,
            propertyType,
        });
    }

    return map;
}

function find99StateForUrl(
    stateByUrl: Map<string, StateListing>,
    url: string,
): StateListing {
    const path = new URL(url).pathname.toLowerCase();
    const direct = stateByUrl.get(path);
    if (direct) return direct;

    const id = extract99AcresId(url)?.toLowerCase();
    if (!id) return {};

    for (const [statePath, state] of stateByUrl.entries()) {
        if (statePath.toLowerCase().includes(id)) return state;
    }

    return {};
}

function extract99StateArea(windowText: string): { value: number | null; unit: string | null } {
    const areaCandidates = [
        ['SUPERBUILTUP_AREA', 'SUPERBUILTUPAREA_UNIT'],
        ['CARPET_AREA', 'CARPETAREA_UNIT'],
        ['BUILTUP_AREA', 'BUILTUPAREA_UNIT'],
    ] as const;

    for (const [areaKey, unitKey] of areaCandidates) {
        const value = finiteNumber(captureJsonString(windowText, areaKey));
        if (value !== null) {
            const unit = cleanText(captureJsonString(windowText, unitKey)) || 'sqft';
            return { value, unit: /sq/i.test(unit) ? 'sqft' : unit };
        }
    }

    return { value: null, unit: null };
}

function capture99AreaType(windowText: string): string | null {
    const areaType = captureJsonString(windowText, 'AREA_TYPE');
    if (!areaType) return null;
    if (/CARPET/i.test(areaType)) return 'Carpet Area';
    if (/SUPERBUILTUP/i.test(areaType)) return 'Super Built-up Area';
    if (/BUILTUP/i.test(areaType)) return 'Built-up Area';
    return normalizeLabel(areaType.replace(/_/g, ' '));
}

function captureJsonString(text: string, key: string): string | null {
    const re = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 'i');
    const match = text.match(re);
    return match ? cleanText(decodeJsonString(match[1])) || null : null;
}

function decodeJsonString(value: string): string {
    try {
        return JSON.parse(`"${value.replace(/"/g, '\\"')}"`) as string;
    } catch {
        return value
            .replace(/\\u002F/g, '/')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
    }
}

function extract99AcresImage(html: string, url: string): string | null {
    const windowText = extractRawWindowNearUrl(html, url, 7000);
    const imageMatches = [...windowText.matchAll(/https?:\/\/(?:imagecdn|mediacdn)\.99acres\.com\/[^"'<>\s)\\]+/gi)]
        .map((match) => decodeHtml(match[0].replace(/\\u002F/g, '/')))
        .filter((imageUrl) => !/sprite|icon|logo|rera/i.test(imageUrl));

    return imageMatches[0] ?? null;
}

function extractMagicImage(chunk: string): string | null {
    const match = chunk.match(/https?:\/\/img\.staticmb\.com\/[^"'<>\s)\\]+/i);
    return match ? decodeHtml(match[0].replace(/\\u002F/g, '/')) : null;
}

function extractOfferPrice(item: AnyObject): string | null {
    const offers = asObject(item.offers);
    const price = asString(offers.price);
    const currency = asString(offers.priceCurrency) || 'INR';
    if (!price) return null;
    return `${currency} ${price}`;
}

function extractTextNearUrl(html: string, url: string): string {
    return cleanText(stripHtml(extractRawWindowNearUrl(html, url, 5000)));
}

function extractRawWindowNearUrl(html: string, url: string, radius: number): string {
    const escapedUrl = url.replace(/\//g, '\\/');
    let index = html.indexOf(url);
    if (index < 0) index = html.indexOf(escapedUrl);
    if (index < 0) return html.slice(0, Math.min(html.length, radius * 2));

    return html.slice(Math.max(0, index - radius), Math.min(html.length, index + radius));
}

function extractFloorSize(value: unknown): { value: number | null; unit: string | null } {
    if (isObject(value)) {
        const objectValue = finiteNumber(value.value) ?? finiteNumber(value.size);
        const unit = cleanText(asString(value.unitText ?? value.unitCode)) || 'sqft';
        return { value: objectValue, unit: objectValue === null ? null : unit };
    }

    return extractArea(asString(value));
}

function extractArea(text: string | null): { value: number | null; unit: string | null } {
    if (!text) return { value: null, unit: null };
    const match = text.match(/(\d[\d,]*(?:\.\d+)?)\s*(?:sq\.?\s*ft|sqft|sq-ft|square\s*feet)/i);
    if (!match) return { value: null, unit: null };
    return { value: toNumber(match[1]), unit: 'sqft' };
}

function extractAreaType(text: string): string | null {
    if (/carpet\s+area/i.test(text)) return 'Carpet Area';
    if (/super\s+built/i.test(text)) return 'Super Built-up Area';
    if (/built[\s-]?up/i.test(text)) return 'Built-up Area';
    if (/plot\s+area/i.test(text)) return 'Plot Area';
    return null;
}

function extractBhk(text: string | null): number | null {
    if (!text) return null;
    const match = text.match(/(\d+(?:\.\d+)?)\s*BHK/i);
    return match ? Math.round(Number(match[1])) : null;
}

function extractPropertyType(text: string): string | null {
    const patterns = [
        'Apartment',
        'Flat',
        'Villa',
        'Independent House',
        'Builder Floor',
        'Plot',
        'Office Space',
        'Shop',
        'Showroom',
        'Penthouse',
        'Studio Apartment',
    ];

    const found = patterns.find((pattern) => new RegExp(`\\b${escapeRegExp(pattern)}\\b`, 'i').test(text));
    if (!found) return null;
    return found === 'Flat' ? 'Apartment' : found;
}

function extractPriceDisplay(text: string | null): string | null {
    if (!text) return null;
    const candidates = [...text.matchAll(/(?:\u20b9|Rs\.?|INR)\s*[\d,.]+(?:\s*(?:Lac|Lakh|Cr|Crore))?(?:\s*-\s*(?:\u20b9|Rs\.?|INR)?\s*[\d,.]+(?:\s*(?:Lac|Lakh|Cr|Crore))?)?(?:\s*(?:\/\s*month|monthly))?/gi)]
        .map((match) => ({
            value: cleanText(match[0]),
            context: text.slice(match.index ?? 0, (match.index ?? 0) + 80),
        }))
        .filter(({ value }) => Boolean(value));

    const matches = candidates
        .filter(({ value, context }) => isUsefulPriceCandidate(value, context))
        .map(({ value }) => value);

    if (matches.length > 0) return matches[matches.length - 1];

    const rentMatch = text.match(/\b[\d,]{4,}\s*(?:monthly|per\s+month|\/\s*month)\b/i);
    return rentMatch ? cleanText(rentMatch[0]) : null;
}

function isUsefulPriceCandidate(value: string, context: string): boolean {
    if (/\b(?:Lac|Lakh|Cr|Crore)\b/i.test(value)) return true;
    if (/(?:\/\s*month|monthly)/i.test(value)) return true;
    if (/(?:\/\s*sqft|per\s+sqft|sq\.?\s*ft|emi)/i.test(context)) return false;
    return (parseIndianMoney(value) ?? 0) >= 100000;
}

function parseIndianMoney(display: string | null): number | null {
    if (!display) return null;
    const amountMatch = display.match(/[\d,.]+/);
    if (!amountMatch) return null;

    const amount = toNumber(amountMatch[0]);
    if (amount === null) return null;

    if (/\b(?:Cr|Crore)\b/i.test(display)) return Math.round(amount * 10000000);
    if (/\b(?:Lac|Lakh)\b/i.test(display)) return Math.round(amount * 100000);
    return Math.round(amount);
}

function extractDepositDisplay(text: string | null): string | null {
    if (!text) return null;
    const match = text.match(/(?:security\s+deposit|deposit)[^\d\u20b9R]{0,40}((?:\u20b9|Rs\.?|INR)?\s*[\d,.]+(?:\s*(?:Lac|Lakh|Cr|Crore))?)/i);
    return match ? cleanText(match[0]) : null;
}

function extractIntegerAfterLabel(text: string, label: string): number | null {
    const match = text.match(new RegExp(`${escapeRegExp(label)}\\s+(\\d+)`, 'i'));
    return match ? Number(match[1]) : null;
}

function extractFurnishing(text: string): string | null {
    const match = text.match(/\b(?:Semi[-\s]?Furnished|Unfurnished|Furnished|Fully Furnished)\b/i);
    return match ? normalizeLabel(match[0]) : null;
}

function extractStatus(text: string, transactionType: 'sale' | 'rent'): string | null {
    if (/ready\s+to\s+move/i.test(text)) return 'Ready to move';
    if (/under\s+construction/i.test(text)) return 'Under construction';
    if (/immediate|available\s+now/i.test(text)) return transactionType === 'rent' ? 'Available now' : 'Ready to move';

    const possession = text.match(/poss(?:ession)?\.?\s*(?:by|from)?\s*([A-Za-z]{3,9}\s+\d{4})/i);
    return possession ? `Possession by ${possession[1]}` : null;
}

function extractFloor(text: string): string | null {
    const match = text.match(/(?:floor|Floor)\s*[:\-]?\s*([A-Za-z0-9 /\-]+?)(?:\s{2,}|,|Bathroom|Balcony|Furnishing|$)/);
    return match ? cleanText(match[1]) : null;
}

function buildAddress(address: AnyObject): string | null {
    const parts = [
        asString(address.name),
        asString(address.streetAddress),
        asString(address.addressLocality),
        asString(address.addressCountry),
    ].map(cleanText).filter(Boolean);

    return parts.length ? [...new Set(parts)].join(', ') : null;
}

function redactSensitiveText(text: string): string {
    return text
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted email]')
        .replace(/\b(?:\+?91[-\s]?)?[6-9]\d{9}\b/g, '[redacted phone]');
}

function stripHtml(html: string): string {
    return decodeHtml(html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' '));
}

function decodeHtml(value: string): string {
    return value
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCharCode(parseInt(code, 16)));
}

function cleanText(value: unknown): string {
    return String(value ?? '')
        .replace(/\\u002F/g, '/')
        .replace(/\u20b9|\u00e2\u201a\u00b9/g, 'INR ')
        .replace(/\s+/g, ' ')
        .trim();
}

function truncate(value: string, maxLength: number): string {
    return value.length > maxLength ? `${value.slice(0, maxLength - 3).trim()}...` : value;
}

function stripCitySuffix(value: string, city: string): string {
    return value
        .replace(new RegExp(`\\b${escapeRegExp(city)}\\b`, 'ig'), '')
        .replace(/\s+/g, ' ')
        .replace(/,\s*$/, '')
        .trim();
}

function normalizeLabel(value: string): string {
    return value
        .toLowerCase()
        .replace(/(^|\s|-)\w/g, (letter) => letter.toUpperCase())
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeNullableLabel(value: string | null): string | null {
    return value ? normalizeLabel(value) : null;
}

function slugCity(city: string): string {
    return city
        .toLowerCase()
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

function absoluteUrl(url: string | null, base: string): string | null {
    if (!url) return null;
    try {
        return new URL(url, base).toString();
    } catch {
        return null;
    }
}

function asString(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    return null;
}

function asObject(value: unknown): AnyObject {
    return isObject(value) ? value : {};
}

function isObject(value: unknown): value is AnyObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const number = typeof value === 'number' ? value : Number(String(value ?? '').replace(/,/g, ''));
    return Number.isFinite(number) ? number : null;
}

function toNumber(value: string): number | null {
    const number = Number(value.replace(/,/g, ''));
    return Number.isFinite(number) ? number : null;
}

function stableId(...parts: string[]): string {
    return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
