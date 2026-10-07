import { Actor, log } from 'apify';
import { fetch, ProxyAgent, type Dispatcher } from 'undici';
import { createHash } from 'node:crypto';
import { wasPushedRecordSaved } from './billing.js';
import { normalizeInput } from './input.js';
import { addPropertyIntelligence, monitorScope, propertyKey, squareFeet } from './property-intelligence.js';
import { PropertyMonitorError, savePropertyMonitor } from './property-monitor.js';
import type { ActorInput, NormalizedInput, PropertyRecord, PropertySource, ScrapeJob } from './types.js';

const CHARGE_EVENT_NAME = 'property-scraped';
export const REQUEST_TIMEOUT_MS = 30_000;
export const MAX_HTML_BYTES = 12 * 1024 * 1024;
const MAX_REQUEST_ATTEMPTS = 2;
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
    const proxyConfiguration = await Actor.createProxyConfiguration(input.proxyConfiguration);
    const configuredSources = resolveSources(input.source);
    const jobs = buildJobs(input, configuredSources);
    const observedAt = new Date().toISOString();
    const savedRecords: PropertyRecord[] = [];
    const searchFailures = new Map<string, number>();
    const repeatedPages = new Set<string>();
    const sources = [...new Set(jobs.map((job) => job.source))];
    const seen = new Set<string>();
    const sourceCounts = new Map<string, number>();
    const attemptedSources = new Set<string>();
    const exhaustedSearches = new Set<string>();
    let pushed = 0;
    let processedPages = 0;
    let failedPages = 0;
    let spendingLimitReached = false;
    let fatalBillingError: Error | null = null;
    let earlyStoppedPages = 0;
    let decodedHtmlBytesRead = 0;

    log.info('Starting property scrape', {
        source: input.source,
        transactionType: input.transactionType,
        cities: input.cities,
        maxResults: input.maxResults,
        customSearchUrls: input.searchUrls.length,
    });

    for (const [jobIndex, job] of jobs.entries()) {
        if (pushed >= input.maxResults || spendingLimitReached || fatalBillingError) break;

        const searchKey = job.searchKey;
        if (exhaustedSearches.has(searchKey)) continue;

        log.info(`Fetching ${job.source} ${job.transactionType} listings`, {
            city: job.city,
            page: job.page,
            url: job.url,
        });

        try {
            const softCap = Math.ceil(input.maxResults / sources.length);
            const balanceFirstPass = sources.length > 1 && attemptedSources.size < sources.length;
            const rowsNeeded = Math.min(input.maxResults - pushed,
                balanceFirstPass ? softCap - (sourceCounts.get(job.source) ?? 0) : input.maxResults - pushed);
            const html = await fetchHtml(job.url, proxyConfiguration, {
                completePrefix: job.source === 'magicbricks'
                    ? text => completeMagicPrefix(text, job, input, rowsNeeded, seen) : undefined,
                onChunk: bytes => { decodedHtmlBytesRead += bytes; },
                onEarlyStop: () => { earlyStoppedPages += 1; },
            });
            const parsedRecords = job.source === 'magicbricks'
                ? parseMagicBricks(html, job)
                : parse99Acres(html, job);
            const pageState = classifyPropertyPage(html, parsedRecords.length);
            if (pageState === 'blocked' || pageState === 'unrecognized') {
                throw new Error(pageState === 'blocked' ? 'Source returned a challenge page' : 'Page format was not recognized; no confirmed empty search');
            }
            processedPages += 1;

            if (parsedRecords.length === 0) {
                log.warning('No records parsed from page', { source: job.source, city: job.city, page: job.page });
                exhaustedSearches.add(searchKey);
            }
            if (parsedRecords.length > 0 && parsedRecords.every(record => seen.has(propertyKey(record)))) {
                repeatedPages.add(searchKey);
                exhaustedSearches.add(searchKey);
                log.warning('Repeated pagination page detected; stopping this search rather than paying for more duplicates.');
            }

            let pushedFromThisJob = 0;

            for (const parsedRecord of parsedRecords) {
                const record = addPropertyIntelligence(parsedRecord);
                if (pushed >= input.maxResults || spendingLimitReached || fatalBillingError) break;
                if (balanceFirstPass && (sourceCounts.get(job.source) ?? 0) >= softCap) break;

                const dedupeKey = propertyKey(record);
                if (seen.has(dedupeKey)) continue;
                if (!passesPriceFilter(record, input)) continue;

                try {
                    const chargeResult = await Actor.pushData(record, CHARGE_EVENT_NAME);
                    const recordWasSaved = wasPushedRecordSaved(chargeResult);

                    if (recordWasSaved) {
                        seen.add(dedupeKey);
                        pushed += 1;
                        pushedFromThisJob += 1;
                        sourceCounts.set(job.source, (sourceCounts.get(job.source) ?? 0) + 1);
                        savedRecords.push(record);
                    }

                    if (chargeResult.eventChargeLimitReached) {
                        spendingLimitReached = true;
                        await Actor.setStatusMessage(`Stopped at the user's spending limit after ${pushed} property listings`);
                        log.info('User spending limit reached; stopping before more property pages are requested.');
                        break;
                    }
                } catch (error) {
                    fatalBillingError = error instanceof Error ? error : new Error(String(error));
                    spendingLimitReached = true;
                    await Actor.setStatusMessage('Stopped because property output billing failed.');
                    log.error('Stopping property scrape because dataset push with property-scraped charge failed.', {
                        error: fatalBillingError.message,
                    });
                    throw fatalBillingError;
                }
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
            failedPages += 1;
            searchFailures.set(searchKey, (searchFailures.get(searchKey) ?? 0) + 1);
            if (shouldStopFailedSearch(searchFailures.get(searchKey)!)) exhaustedSearches.add(searchKey);
            log.warning(`Skipping page after retries: ${(error as Error).message}`, {
                source: job.source,
                city: job.city,
                page: job.page,
                url: job.url,
            });
        }

        if (shouldDelayBeforeNextJob(
            pushed,
            input.maxResults,
            spendingLimitReached,
            fatalBillingError,
            jobIndex < jobs.length - 1,
        )) {
            await delay(randomInt(400, 900));
        }
    }

    if (fatalBillingError) throw fatalBillingError;
    const coverage = {
        savedListings: pushed, processedPages, failedPages, spendingLimitReached,
        resultLimitReached: pushed >= input.maxResults,
        requestedSources: sources, sourcesWithSavedListings: [...sourceCounts.keys()],
        failedSearches: searchFailures.size, repeatedSearchPages: repeatedPages.size,
        earlyStoppedPages, decodedHtmlBytesRead,
        boundedSample: true,
    };
    await Actor.setValue('RUN_SUMMARY', coverage);
    if (input.monitorStoreName && processedPages > 0) {
        try {
            await savePropertyMonitor(input.monitorStoreName, savedRecords,
                monitorScope(input, jobs.map(job => job.searchKey)), observedAt,
                input.priceChangeThresholdPercent, coverage);
        } catch (error) {
            // Keep core results, but never label a failed persistent comparison as a successful baseline.
            await Actor.setValue('PROPERTY_REPORT', { historyCommitted: error instanceof PropertyMonitorError ? error.historyCommitted : false, coverage,
                error: (error as Error).message });
            throw new Error(`Property data was saved, but the requested monitor update failed: ${(error as Error).message}`);
        }
    }

    if (pushed === 0) {
        if (shouldFailEmptyRun(processedPages)) {
            throw new Error('All property pages failed after retries. Try Residential India proxy or run again later.');
        }

        await Actor.setStatusMessage('Search completed successfully, but no listings matched the supplied filters.');
        log.info('Property scrape finished with no matching listings', { processedPages, failedPages });
        return;
    }

    log.info('Property scrape finished', {
        pushed,
        processedPages,
        failedPages,
        sourceCounts: Object.fromEntries(sourceCounts),
    });
}

export function shouldFailEmptyRun(processedPages: number): boolean {
    return processedPages === 0;
}

export function shouldStopFailedSearch(failedPages: number): boolean {
    return failedPages >= 2;
}

export function classifyPropertyPage(html: string, parsedCount: number): 'listings' | 'empty' | 'blocked' | 'unrecognized' {
    if (parsedCount > 0) return 'listings';
    if (looksBlocked(html)) return 'blocked';
    const text = stripHtml(html);
    if (/no (?:matching )?(?:properties|listings|results) (?:were )?(?:found|available)|couldn['’]?t find any propert|0 properties found/i.test(text)) return 'empty';
    return 'unrecognized';
}

function resolveSources(source: PropertySource): Array<Exclude<PropertySource, 'both'>> {
    if (source === 'magicbricks') return ['magicbricks'];
    if (source === '99acres') return ['99acres'];
    return ['magicbricks', '99acres'];
}

export function buildJobs(input: NormalizedInput, sources: Array<Exclude<PropertySource, 'both'>>): ScrapeJob[] {
    const requestedPages = calculatePageLimit(input.maxResults);

    if (input.searchUrls.length > 0) {
        const customJobs: ScrapeJob[] = [];

        for (let page = 1; page <= requestedPages; page += 1) {
            for (const searchUrl of input.searchUrls) {
                const searchKey = `${searchUrl.source}:${searchUrl.url}`;
                customJobs.push({
                    ...searchUrl,
                    page,
                    url: paginateSearchUrl(searchUrl.url, searchUrl.source, page),
                    searchKey,
                    isCustomUrl: true,
                });
            }
        }

        return customJobs;
    }

    const jobs: ScrapeJob[] = [];
    const maxPages = Math.max(
        ...sources.map((source) => (
            source === '99acres' ? calculate99AcresPageLimit(input.maxResults) : requestedPages
        )),
    );

    for (let page = 1; page <= maxPages; page += 1) {
        for (const city of input.cities) {
            const citySlug = slugCity(city);

            for (const source of sources) {
                const sourcePageLimit = source === '99acres'
                    ? calculate99AcresPageLimit(input.maxResults)
                    : requestedPages;
                if (page > sourcePageLimit) continue;

                jobs.push({
                    source,
                    transactionType: input.transactionType,
                    city,
                    citySlug,
                    page,
                    url: buildSourceUrl(source, input.transactionType, city, citySlug, page),
                    searchKey: `${source}:${input.transactionType}:${citySlug}`,
                    isCustomUrl: false,
                });
            }
        }
    }

    return jobs;
}

export function calculatePageLimit(maxResults: number): number {
    return Math.min(Math.max(Math.ceil(maxResults / 25), 1), 20);
}

export function calculate99AcresPageLimit(maxResults: number): number {
    return Math.min(calculatePageLimit(maxResults) + 1, 20);
}

export function paginateSearchUrl(
    rawUrl: string,
    source: Exclude<PropertySource, 'both'>,
    page: number,
): string {
    if (page <= 1) return rawUrl;

    const url = new URL(rawUrl);
    if (source === 'magicbricks') {
        url.searchParams.set('page', String(page));
        return url.toString();
    }

    if (/-ffid(?:-page-\d+)?\/?$/i.test(url.pathname)) {
        url.pathname = url.pathname.replace(/-ffid(?:-page-\d+)?\/?$/i, `-ffid-page-${page}`);
    } else {
        url.searchParams.set('page', String(page));
    }
    return url.toString();
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
        const url = `https://www.magicbricks.com/${path}/residential-real-estate?cityName=${encodeURIComponent(city)}`;
        return paginateSearchUrl(url, source, page);
    }

    const prefix = transactionType === 'rent' ? `property-for-rent-in-${citySlug}` : `property-in-${citySlug}`;
    return page === 1
        ? `https://www.99acres.com/${prefix}-ffid`
        : `https://www.99acres.com/${prefix}-ffid-page-${page}`;
}

class NonRetryableRequestError extends Error {
    override name = 'NonRetryableRequestError';
}

export function isRetryableHttpStatus(status: number): boolean {
    return status === 403 || status === 407 || status === 408 || status === 429 || status >= 500;
}

export function createRequestSignal(timeoutMs = REQUEST_TIMEOUT_MS): AbortSignal {
    return AbortSignal.timeout(timeoutMs);
}

export function shouldDelayBeforeNextJob(
    pushed: number,
    maxResults: number,
    spendingLimitReached: boolean,
    fatalBillingError: Error | null,
    hasMoreJobs: boolean,
): boolean {
    return hasMoreJobs && pushed < maxResults && !spendingLimitReached && !fatalBillingError;
}

type BoundedResponse = {
    headers: { get(name: string): string | null };
    body: {
        cancel(reason?: unknown): Promise<void>;
        getReader(): {
            read(): Promise<{ done: boolean; value?: Uint8Array }>;
            cancel(reason?: unknown): Promise<void>;
            releaseLock(): void;
        };
    } | null;
};

type ResponseReadOptions = {
    completePrefix?: (html: string) => string | null;
    onChunk?: (bytes: number) => void;
    onEarlyStop?: () => void;
};

export async function readBoundedResponseText(
    response: BoundedResponse,
    maxBytes = MAX_HTML_BYTES,
    options: ResponseReadOptions = {},
): Promise<string> {
    const contentLengthHeader = response.headers.get('content-length');
    const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);

    if (contentLength !== null && Number.isFinite(contentLength) && contentLength > maxBytes) {
        await response.body?.cancel();
        throw new NonRetryableRequestError(`HTML response exceeds ${maxBytes} byte limit`);
    }

    if (!response.body) return '';

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytesRead = 0;
    let text = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;

            bytesRead += value.byteLength;
            options.onChunk?.(value.byteLength);
            if (bytesRead > maxBytes) {
                await reader.cancel();
                throw new NonRetryableRequestError(`HTML response exceeds ${maxBytes} byte limit`);
            }

            text += decoder.decode(value, { stream: true });
            const completePrefix = options.completePrefix?.(text);
            if (completePrefix) {
                await reader.cancel('Requested complete property cards have been captured');
                options.onEarlyStop?.();
                return completePrefix;
            }
        }

        return text + decoder.decode();
    } finally {
        reader.releaseLock();
    }
}

async function fetchHtml(url: string, proxyConfiguration: ProxyConfiguration, options: ResponseReadOptions = {}): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
        let dispatcher: Dispatcher | undefined;

        try {
            const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;
            dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
            const response = await fetch(url, {
                headers: REQUEST_HEADERS,
                dispatcher,
                signal: createRequestSignal(),
            });

            if (!response.ok) {
                await response.body?.cancel();
                const error = new Error(`HTTP ${response.status}`);
                if (!isRetryableHttpStatus(response.status)) {
                    throw new NonRetryableRequestError(error.message);
                }
                throw error;
            }

            const html = await readBoundedResponseText(response, MAX_HTML_BYTES, options);
            if (looksBlocked(html)) {
                throw new Error('Page appears blocked or challenged');
            }

            return html;
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            if (error instanceof NonRetryableRequestError) break;
            if (attempt < MAX_REQUEST_ATTEMPTS) await delay(1000 * attempt + randomInt(250, 900));
        } finally {
            await dispatcher?.close();
        }
    }

    throw lastError ?? new Error('Request failed');
}

function looksBlocked(html: string): boolean {
    const lower = html.toLowerCase();
    if (/mb-srp__card|property-card|-spid-\d+/.test(lower)) return false;
    return lower.includes('captcha')
        || lower.includes('access denied')
        || lower.includes('unusual traffic')
        || lower.includes('enable cookies')
        || lower.includes('cloudflare');
}

export function parseMagicBricks(html: string, job: ScrapeJob): PropertyRecord[] {
    const listItems = extractMagicListItems(html);
    const chunks = extractMagicCardChunks(html);
    const records: PropertyRecord[] = [];
    const usedListItems = new Set<number>();
    const pairs = chunks.map(chunk => {
        const cardUrl = absoluteUrl(extractMagicUrl(chunk), 'https://www.magicbricks.com');
        const titleMatches = cardUrl ? [] : listItems.map((item, index) => ({ item, index }))
            .filter(({ item }) => item.name && cleanText(stripHtml(chunk)).includes(item.name));
        const listIndex = cardUrl ? listItems.findIndex(item => magicUrlKey(item.url) === magicUrlKey(cardUrl))
            : titleMatches.length === 1 ? titleMatches[0].index : -1;
        if (listIndex >= 0) usedListItems.add(listIndex);
        return { chunk, listItem: listIndex >= 0 ? listItems[listIndex] : undefined, cardUrl };
    });
    for (const [index, listItem] of listItems.entries()) {
        if (!usedListItems.has(index)) pairs.push({ chunk: '', listItem, cardUrl: null });
    }

    for (const [index, pair] of pairs.entries()) {
        const { listItem, chunk, cardUrl } = pair;
        const text = cleanText(stripHtml(chunk));
        const propertyUrl = absoluteUrl(cardUrl ?? listItem?.url ?? null, 'https://www.magicbricks.com');

        if (!propertyUrl) continue;

        const title = cleanText(listItem?.name) || extractMagicTitle(text, job.city);
        const location = parseMagicLocation(title, job.city);
        const priceDisplay = extractPriceDisplay(text);
        const price = parseIndianMoney(priceDisplay);
        const area = extractArea(text);
        const bhk = extractBhk(title) ?? extractBhk(text);
        const bathrooms = extractIntegerAfterLabel(text, 'Bathroom');
        const balconies = extractIntegerAfterLabel(text, 'Balcony');
        const projectName = location.projectName;
        const details = extractListingDetails(text);
        const imageUrls = extractMagicImages(chunk);

        records.push({
            source: 'magicbricks',
            transactionType: job.transactionType,
            cityQuery: job.city,
            propertyId: extractMagicId(propertyUrl) ?? stableId('magicbricks', propertyUrl),
            title: title || null,
            propertyType: extractPropertyType(`${title} ${text}`),
            bhk,
            price,
            priceDisplay,
            pricePerSqft: calculatePricePerSqft(price, area.value, area.unit),
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
            listedBy: details.listedBy,
            verified: details.verified,
            featured: details.featured,
            postedAt: details.postedAt,
            propertyAge: details.propertyAge,
            facing: details.facing,
            ownership: details.ownership,
            parking: details.parking,
            reraId: details.reraId,
            maintenanceDisplay: details.maintenanceDisplay,
            amenities: details.amenities,
            imageUrl: imageUrls[0] ?? null,
            imageUrls,
            imagesCount: imageUrls.length,
            propertyUrl,
            searchUrl: job.url,
            searchPage: job.page,
            resultPosition: index + 1,
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

    for (const [index, item] of propertyObjects.entries()) {
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
        const price = state.price ?? parseIndianMoney(priceDisplay);
        const areaValue = stateArea.value ?? floorSize.value ?? descriptionArea.value;
        const areaUnit = stateArea.value !== null ? stateArea.unit
            : floorSize.value !== null ? floorSize.unit : descriptionArea.unit;
        const details = extractListingDetails(description);
        const imageUrls = uniqueStrings([
            state.imageUrl,
            ...(state.imageUrls ?? []),
            ...extract99AcresImages(html, url),
        ]);

        records.push({
            source: '99acres',
            transactionType: job.transactionType,
            cityQuery: job.city,
            propertyId: extract99AcresId(url) ?? stableId('99acres', url),
            title: title || null,
            propertyType: state.propertyType ?? extractPropertyType(`${title} ${description}`) ?? 'Apartment',
            bhk: bhk ?? state.bhk ?? null,
            price,
            priceDisplay,
            pricePerSqft: calculatePricePerSqft(price, areaValue, areaUnit),
            depositDisplay: extractDepositDisplay(priceText),
            area: areaValue,
            areaUnit,
            areaType: state.areaType ?? extractAreaType(description),
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
            listedBy: state.listedBy ?? details.listedBy,
            verified: state.verified ?? details.verified,
            featured: state.featured ?? details.featured,
            postedAt: state.postedAt ?? details.postedAt,
            propertyAge: state.propertyAge ?? details.propertyAge,
            facing: state.facing ?? details.facing,
            ownership: state.ownership ?? details.ownership,
            parking: state.parking ?? details.parking,
            reraId: state.reraId ?? details.reraId,
            maintenanceDisplay: state.maintenanceDisplay ?? details.maintenanceDisplay,
            amenities: details.amenities,
            imageUrl: state.imageUrl ?? imageUrls[0] ?? null,
            imageUrls,
            imagesCount: imageUrls.length,
            propertyUrl: url,
            searchUrl: job.url,
            searchPage: job.page,
            resultPosition: index + 1,
            description: description ? truncate(description, 800) : null,
            scrapedAt: new Date().toISOString(),
        });
    }

    return records;
}

export function passesPriceFilter(record: PropertyRecord, input: NormalizedInput): boolean {
    if (input.minPrice === null && input.maxPrice === null) return true;
    if (record.price === null) return false;
    if (input.minPrice !== null && record.price < input.minPrice) return false;
    if (input.maxPrice !== null && record.price > input.maxPrice) return false;
    return true;
}

export function calculatePricePerSqft(
    price: number | null,
    area: number | null,
    areaUnit: string | null,
): number | null {
    const normalizedArea = squareFeet(area, areaUnit);
    return price !== null && Number.isFinite(price) && price > 0 && normalizedArea
        ? Math.round(price / normalizedArea) : null;
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
    return completeMagicCards(html).map(card => html.slice(card.start, card.end));
}

function extractMagicUrl(chunk: string): string | null {
    for (const match of chunk.matchAll(/href=["']([^"']+)["']/gi)) {
        const href = decodeHtml(match[1].replace(/\\\//g, '/'));
        const absolute = absoluteUrl(href, 'https://www.magicbricks.com');
        if (!absolute) continue;
        try {
            const url = new URL(absolute);
            if ((url.hostname === 'magicbricks.com' || url.hostname.endsWith('.magicbricks.com'))
                && (/propertyDetails/i.test(url.pathname) || /\.htm$/i.test(url.pathname))) return absolute;
        } catch { /* Ignore malformed links; never attach another listing's price by position. */ }
    }
    return null;
}

function magicUrlKey(url: string | null): string | null {
    if (!url) return null;
    try {
        const parsed = new URL(decodeHtml(url), 'https://www.magicbricks.com');
        return parsed.pathname + (parsed.searchParams.has('id') ? `?id=${parsed.searchParams.get('id')}` : '');
    } catch { return null; }
}

// Count balanced card containers, excluding comments and raw script/style strings. A partial card
// or a footer after the card is not property data. No DOM parser or browser is needed for this path.
export function completeMagicCards(html: string): Array<{ start: number; end: number }> {
    const cards: Array<{ start: number; end: number }> = [];
    const tokens = /<!--|<\/?([a-z][\w:-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
    let start = -1;
    let depth = 0;
    let match: RegExpExecArray | null;
    while ((match = tokens.exec(html)) !== null) {
        if (match[0] === '<!--') {
            const end = html.indexOf('-->', tokens.lastIndex);
            if (end < 0) break;
            tokens.lastIndex = end + 3;
            continue;
        }
        const tag = match[1].toLowerCase();
        const closing = /^<\//.test(match[0]);
        if (!closing && (tag === 'script' || tag === 'style')) {
            const endTag = new RegExp(`</${tag}\\s*>`, 'gi');
            endTag.lastIndex = tokens.lastIndex;
            const end = endTag.exec(html);
            if (!end) break;
            tokens.lastIndex = endTag.lastIndex;
            continue;
        }
        if (tag !== 'div') continue;
        if (!closing) {
            const attributes = [...match[0].matchAll(/\s([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)];
            const classAttribute = attributes.find(attribute => attribute[1].toLowerCase() === 'class');
            const className = classAttribute ? classAttribute[2] ?? classAttribute[3] ?? classAttribute[4] : '';
            if (start < 0 && /(?:^|\s)mb-srp__card(?:\s|$)/.test(className)) start = match.index;
            if (start >= 0) depth += 1;
        } else if (start >= 0) {
            depth -= 1;
            if (depth === 0) {
                cards.push({ start, end: tokens.lastIndex });
                start = -1;
            }
        }
    }
    return cards;
}

export function completeMagicPrefix(
    html: string, job: ScrapeJob, input: NormalizedInput, required: number, seen: ReadonlySet<string>,
): string | null {
    if (job.source !== 'magicbricks' || required < 1) return null;
    const cards = completeMagicCards(html);
    if (cards.length < required) return null;
    // Stop only when a complete ItemList is already before the cards. If it is late or absent,
    // keep reading normally, including 99acres inline state. This preserves source field parity.
    const listItems = extractMagicListItems(html.slice(0, cards[0].start));
    if (!listItems.length) return null;
    const parsedRows = parseMagicBricks(html.slice(0, cards[cards.length - 1].end), job);
    const rowByUrl = new Map<string | null, PropertyRecord>();
    for (const row of parsedRows) {
        const url = magicUrlKey(row.propertyUrl);
        if (!rowByUrl.has(url)) rowByUrl.set(url, row);
    }
    const matched = new Set<string>();
    let eligible = 0;
    for (const card of cards) {
        const prefix = html.slice(0, card.end);
        const cardUrl = extractMagicUrl(html.slice(card.start, card.end));
        const listItem = listItems.find(item => magicUrlKey(item.url) === magicUrlKey(cardUrl));
        if (!cardUrl || !listItem?.name) return null;
        const record = rowByUrl.get(magicUrlKey(cardUrl));
        if (!record) return null;
        const key = propertyKey(record);
        if (!seen.has(key) && !matched.has(key) && record.title && record.price !== null && record.price > 0
            && record.area !== null && record.area > 0 && record.areaUnit && passesPriceFilter(record, input)) {
            matched.add(key);
            eligible += 1;
        }
        if (eligible >= required) return prefix;
    }
    return null;
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
        const imageUrls = extract99ImageUrlsFromText(windowText);
        const listedByText = captureFirstJsonString(windowText, [
            'POSTED_BY',
            'CLASS_LABEL',
            'CONTACT_TYPE',
            'CLASS',
        ]);

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
            listedBy: extractListedBy(listedByText ?? ''),
            verified: captureFirstJsonBoolean(windowText, ['IS_VERIFIED', 'VERIFIED']),
            featured: captureFirstJsonBoolean(windowText, ['IS_FEATURED', 'FEATURED']),
            postedAt: captureFirstJsonString(windowText, ['POSTING_DATE', 'POSTED_DATE', 'POSTED_ON', 'UPDATE_DATE']),
            propertyAge: captureFirstJsonString(windowText, ['AGE_LABEL', 'AGE_OF_PROPERTY']),
            facing: captureFirstJsonString(windowText, ['FACING_LABEL', 'FACING']),
            ownership: captureFirstJsonString(windowText, ['OWNERSHIP_TYPE', 'OWNERSHIP']),
            parking: captureFirstJsonString(windowText, ['PARKING_LABEL', 'PARKING']),
            reraId: captureFirstJsonString(windowText, ['RERA_ID', 'RERA_REGISTRATION_ID']),
            maintenanceDisplay: captureFirstJsonString(windowText, ['MAINTENANCE', 'MAINTENANCE_CHARGES']),
            imageUrl: imageUrls[0] ?? captureJsonString(windowText, 'photoUrl') ?? captureJsonString(windowText, 'PHOTO_URL'),
            imageUrls,
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

function captureFirstJsonString(text: string, keys: string[]): string | null {
    for (const key of keys) {
        const value = captureJsonString(text, key);
        if (value) return value;
    }
    return null;
}

function captureFirstJsonBoolean(text: string, keys: string[]): boolean | null {
    for (const key of keys) {
        const re = new RegExp(
            `"${escapeRegExp(key)}"\\s*:\\s*(?:"([^"]*)"|(true|false|null|-?\\d+))`,
            'i',
        );
        const match = text.match(re);
        if (!match) continue;

        const value = cleanText(match[1] ?? match[2]).toLowerCase();
        if (['true', '1', 'yes', 'y'].includes(value)) return true;
        if (['false', '0', 'no', 'n'].includes(value)) return false;
    }
    return null;
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

const AMENITY_PATTERNS: Array<[string, RegExp]> = [
    ['Lift', /\blifts?\b/i],
    ['Security', /\bsecurity(?:\s+guard)?s?\b/i],
    ['Power Backup', /\bpower\s+backup\b/i],
    ['Reserved Parking', /\breserved\s+parking\b/i],
    ['Visitor Parking', /\bvisitor\s+parking\b/i],
    ['Swimming Pool', /\bswimming\s+pool\b/i],
    ['Gymnasium', /\b(?:gym|gymnasium)\b/i],
    ['Club House', /\bclub\s*house\b/i],
    ['Garden', /\b(?:garden|landscaped\s+garden)\b/i],
    ['Park', /\bpark\b/i],
    ["Children's Play Area", /\b(?:children'?s?|kids?)\s+play\s+area\b/i],
    ['Intercom', /\bintercom\b/i],
    ['Fire Safety', /\bfire\s+(?:safety|alarm|fighting)\b/i],
    ['Gated Community', /\bgated\s+(?:community|society)\b/i],
    ['Water Supply', /\b(?:24\s*x\s*7|24\/7|continuous)\s+water\b|\bwater\s+supply\b/i],
    ['Air Conditioning', /\bair\s+condition(?:ing|ed)\b|\bcentral\s+ac\b/i],
];

export function extractAmenityNames(text: string): string[] {
    return AMENITY_PATTERNS
        .filter(([, pattern]) => pattern.test(text))
        .map(([name]) => name);
}

export function extractListedBy(text: string): string | null {
    const direct = text.match(
        /\b(?:posted|listed|advertised)\s+by\s*:?\s*(owner|individual|dealer|broker|builder|agent)\b/i,
    )?.[1]
        ?? text.match(/\bcontact\s+(owner|dealer|broker|builder|agent)\b/i)?.[1]
        ?? text.match(/^\s*(owner|individual|dealer|broker|builder|agent)\s*$/i)?.[1];
    if (!direct) return null;

    const normalized = direct.toLowerCase();
    if (normalized === 'individual') return 'Owner';
    if (normalized === 'dealer' || normalized === 'broker' || normalized === 'agent') return 'Agent';
    return normalizeLabel(normalized);
}

export function extractFacing(text: string): string | null {
    const directionPattern = '(north(?:[ -]east|[ -]west)?|south(?:[ -]east|[ -]west)?|east|west)';
    const match = text.match(new RegExp('\\b' + directionPattern + '\\s*[- ]?facing\\b', 'i'))
        ?? text.match(new RegExp('\\bfacing(?:\\s+direction)?\\s*[:\\-]?\\s*' + directionPattern + '\\b', 'i'));
    return match?.[1] ? normalizeLabel(match[1].replace(/\s+/g, '-')) : null;
}

export function extractPropertyAge(text: string): string | null {
    const match = text.match(/\b((?:\d+\s*-\s*\d+|\d+\+?)\s*(?:years?|yrs?)\s*old)\b/i);
    return match ? cleanText(match[1].replace(/\byrs?\b/i, 'years')) : null;
}

function extractOwnership(text: string): string | null {
    const match = text.match(/\b(freehold|leasehold|co-operative\s+society|cooperative\s+society|power\s+of\s+attorney)\b/i);
    return match ? normalizeLabel(match[1]) : null;
}

function extractParking(text: string): string | null {
    const match = text.match(/\b(?:(\d+)\s+)?(covered|open|stilt|basement)?\s*(?:car\s+)?parking\b/i);
    if (!match) return null;

    const parts = [match[1], match[2], 'Parking'].filter(Boolean).map(cleanText);
    return parts.length > 1 ? parts.join(' ') : 'Parking available';
}

function extractReraId(text: string): string | null {
    const match = text.match(/\bRERA\s*(?:registration\s*)?(?:ID|No\.?|number)\s*[:#-]?\s*([A-Z0-9][A-Z0-9/-]{4,})\b/i);
    return match ? match[1] : null;
}

function extractMaintenanceDisplay(text: string): string | null {
    const match = text.match(
        /\bmaintenance(?:\s+charges?)?\s*[:\-]?\s*((?:INR|Rs\.?|\u20b9)\s*[\d,.]+(?:\s*(?:\/\s*month|monthly))?)/i,
    );
    return match ? cleanText(match[1]) : null;
}

function extractPostedAt(text: string): string | null {
    const match = text.match(
        /\b(?:posted|updated|listed)\s*(?:on|:)?\s*(today|yesterday|\d+\s+(?:minutes?|hours?|days?|weeks?|months?)\s+ago|\d{1,2}[\/-][A-Za-z0-9]{1,9}[\/-]\d{2,4})\b/i,
    );
    return match ? cleanText(match[1]) : null;
}

function extractListingDetails(text: string) {
    return {
        listedBy: extractListedBy(text),
        verified: /\b(?:verified\s+(?:property|listing)|property\s+verified)\b/i.test(text) ? true : null,
        featured: /\b(?:featured|premium)\s+(?:property|listing)\b/i.test(text) ? true : null,
        postedAt: extractPostedAt(text),
        propertyAge: extractPropertyAge(text),
        facing: extractFacing(text),
        ownership: extractOwnership(text),
        parking: extractParking(text),
        reraId: extractReraId(text),
        maintenanceDisplay: extractMaintenanceDisplay(text),
        amenities: extractAmenityNames(text),
    };
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
    return [...new Set(values.map((value) => cleanText(value)).filter(Boolean))];
}

function extract99ImageUrlsFromText(text: string): string[] {
    return uniqueStrings(
        [...text.matchAll(/https?:\/\/(?:imagecdn|mediacdn)\.99acres\.com\/[^"'<>\s)\\]+/gi)]
            .map((match) => decodeHtml(match[0].replace(/\\u002F/g, '/')))
            .filter((imageUrl) => !/sprite|icon|logo|rera|\.m3u8(?:$|\?)/i.test(imageUrl)),
    ).slice(0, 1);
}

function extract99AcresImages(html: string, url: string): string[] {
    return extract99ImageUrlsFromText(extractRawWindowNearUrl(html, url, 7000));
}

function extractMagicImages(chunk: string): string[] {
    return uniqueStrings(
        [...chunk.matchAll(/https?:\/\/img\.staticmb\.com\/[^"'<>\s)\\]+/gi)]
            .map((match) => decodeHtml(match[0].replace(/\\u002F/g, '/')))
            .filter((imageUrl) => !/sprite|icon|logo/i.test(imageUrl)),
    ).slice(0, 20);
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
        const unit = cleanText(asString(value.unitText ?? value.unitCode)) || null;
        return { value: objectValue, unit: objectValue === null ? null : unit };
    }

    return extractArea(asString(value));
}

export function extractArea(text: string | null): { value: number | null; unit: string | null } {
    if (!text) return { value: null, unit: null };
    const match = text.match(/(\d[\d,]*(?:\.\d+)?)\s*(sq\.?\s*ft|sqft|sq-ft|square\s*feet|sq\.?\s*m(?:eters?)?|sqm|m[²2]|square\s*meters?|sq\.?\s*y(?:ards?|d)|sqyd|square\s*yards?)/i);
    if (!match) return { value: null, unit: null };
    const rawUnit = match[2].toLowerCase();
    const unit = /y/.test(rawUnit) ? 'sqyd' : /m/.test(rawUnit) ? 'sqm' : 'sqft';
    return { value: toNumber(match[1]), unit };
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

export function extractPriceDisplay(text: string | null): string | null {
    if (!text) return null;
    const candidates = [...text.matchAll(/(?:\u20b9|Rs\.?|INR)\s*[\d,.]+(?:\s*(?:Lac|Lakh|Cr|Crore))?(?:\s*-\s*(?:\u20b9|Rs\.?|INR)?\s*[\d,.]+(?:\s*(?:Lac|Lakh|Cr|Crore))?)?(?:\s*(?:\/\s*month|monthly))?/gi)]
        .map((match) => ({
            value: cleanText(match[0]),
            before: text.slice(Math.max(0, (match.index ?? 0) - 60), match.index ?? 0),
            context: text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 40),
        }))
        .filter(({ value }) => Boolean(value));

    const matches = candidates
        .filter(({ value, before, context }) => !isAncillaryFee(before) && isUsefulPriceCandidate(value, context))
        .map(({ value }) => value);

    if (matches.length > 0) return matches[0];

    const rentMatch = [...text.matchAll(/\b[\d,]{4,}\s*(?:monthly|per\s+month|\/\s*month)\b/gi)]
        .find(match => !isAncillaryFee(text.slice(Math.max(0, (match.index ?? 0) - 60), match.index ?? 0)));
    return rentMatch ? cleanText(rentMatch[0]) : null;
}

function isAncillaryFee(before: string): boolean {
    return /(?:maintenance(?:\s+charges?)?|(?:security\s+)?deposit|emi|booking\s+amount)\s*[:\-]?\s*(?:(?:INR|Rs\.?|\u20b9)\s*)?$/i.test(before);
}

function isUsefulPriceCandidate(value: string, context: string): boolean {
    if (/\b(?:Lac|Lakh|Cr|Crore)\b/i.test(value)) return true;
    if (/(?:\/\s*month|monthly)/i.test(value)) return true;
    if (/^\s*(?:\/\s*sqft|per\s+sqft|sq\.?\s*ft|emi\b)/i.test(context)) return false;
    return (parseIndianMoney(value) ?? 0) >= 100000;
}

export function parseIndianMoney(display: string | null): number | null {
    if (!display) return null;
    const amountMatch = display.match(/\d[\d,.]*/);
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

export function redactSensitiveText(text: string): string {
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
