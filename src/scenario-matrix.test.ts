import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { ApifyClient, ChargingManager, Configuration, log, type ConfigurationOptions } from 'apify';
import { Response, type fetch } from 'undici';
import { normalizeInput } from './input.js';
import { PropertyFailureError } from './failures.js';
import { buildJobs, fetchHtml, MAX_HTML_BYTES, scrapeProperties, type PropertyScrapeRuntime } from './routes.js';
import { commitPropertyMonitor } from './property-monitor.js';
import { propertyKey } from './property-intelligence.js';
import type { ActorInput, PropertyRecord, PropertySource, ScrapeJob, TransactionType } from './types.js';

// Snapshot of the live prices read on 12 October 2026. These simulate billing
// inputs, NOT separate customer accounts or actual paid-plan revenue.
const TIERS = [
    { name: 'FREE/no-discount', micros: 3000 },
    { name: 'BRONZE', micros: 2850 },
    { name: 'SILVER', micros: 2700 },
    { name: 'GOLD', micros: 2550 },
    { name: 'PLATINUM', micros: 2550 },
    { name: 'DIAMOND', micros: 2550 },
] as const;
const START_MICROS = 50; // One synthetic start at the unchanged 512 MB setting.
const EVENT = 'property-scraped';
const SOURCES: PropertySource[] = ['magicbricks', '99acres', 'both'];
const TRANSACTIONS: TransactionType[] = ['sale', 'rent'];
const LIMITS = [1, 5, 25, 50, 500];
const CAPACITIES = [0, 1, 5, 25, Infinity];

// Keep the 900-case matrix readable. This changes only this isolated test worker.
log.setLevel(log.LEVELS.OFF);

test('matrix price snapshot matches the unchanged Actor event definitions', async () => {
    const actor = JSON.parse(await readFile(new URL('../.actor/actor.json', import.meta.url), 'utf8'));
    const events = actor.pricingInfo.pricingPerEvent.actorChargeEvents;
    assert.deepEqual(Object.keys(events).sort(), ['apify-actor-start', EVENT].sort());
    assert.equal(events['apify-actor-start'].eventPriceUsd, START_MICROS / 1_000_000);
    for (const tier of TIERS) {
        const name = tier.name.split('/')[0];
        assert.equal(events[EVENT].eventTieredPricingUsd[name].tieredEventPriceUsd, tier.micros / 1_000_000);
    }
    assert.equal(actor.defaultRunOptions.memoryMbytes, 512);
});

async function offlineCharging(micros: number, capacity = Infinity, adjustmentMicros = 0) {
    const chargeCalls: Array<{ eventName: string; count: number }> = [];
    const maxTotalChargeUsd = Number.isFinite(capacity)
        ? (START_MICROS + capacity * micros + adjustmentMicros) / 1_000_000 : Infinity;
    const client = {
        run: (id: string) => {
            assert.equal(id, 'offline-scenario-matrix');
            return { charge: async (event: { eventName: string; count: number }) => {
                assert.equal(event.eventName, EVENT);
                assert.equal(event.count, 1);
                chargeCalls.push(event);
            } };
        },
    } as unknown as ApifyClient;
    const configuration = new Configuration();
    const settings: ConfigurationOptions = {
        isAtHome: true, actorRunId: 'offline-scenario-matrix',
        testPayPerEvent: false, useChargingLogDataset: false, purgeOnStart: false,
        maxTotalChargeUsd,
        actorPricingInfo: JSON.stringify({ pricingModel: 'PAY_PER_EVENT', pricingPerEvent: { actorChargeEvents: {
            [EVENT]: { eventPriceUsd: micros / 1_000_000, eventTitle: 'Property scraped' },
            'apify-actor-start': { eventPriceUsd: START_MICROS / 1_000_000, eventTitle: 'Actor Start' },
        } } }),
        // The platform supplies this synthetic charge. Do not charge it manually.
        chargedEventCounts: JSON.stringify({ 'apify-actor-start': 1 }),
    };
    for (const [key, value] of Object.entries(settings)) configuration.set(key as keyof ConfigurationOptions, value);
    const manager = new ChargingManager(configuration, client);
    await manager.init(); // Pricing comes from config; the client never uses HTTP.
    assert.equal(manager.getPricingInfo().perEventPrices[EVENT], micros / 1_000_000);
    return { manager, chargeCalls, maxTotalChargeUsd };
}

function pageFixture(job: ScrapeJob): string {
    const ids = Array.from({ length: 25 }, (_, index) => (job.page - 1) * 25 + index + 1);
    const rent = job.transactionType === 'rent';
    const price = rent ? 25_000 : 8_500_000;
    const title = (id: number) => `2 BHK Flat ${id}, Andheri, Mumbai`;
    if (job.source === '99acres') {
        return `<script type="application/ld+json">${JSON.stringify(ids.map(id => ({
            '@type': 'Apartment', name: title(id),
            url: `https://www.99acres.com/2-bhk-flat-in-mumbai-1000-sq-ft-spid-${id}`,
            offers: { price, priceCurrency: 'INR', description: rent ? 'monthly rent' : 'asking sale price' },
            floorSize: { value: 1000, unitText: 'sqft' },
        })))}</script>`;
    }
    const url = (id: number) => `https://www.magicbricks.com/propertyDetails/2-BHK-flat-for-${rent ? 'Rent' : 'Sale'}-in-Mumbai&id=${id}.htm`;
    return `<script type="application/ld+json">${JSON.stringify({ '@type': 'ItemList',
        itemListElement: ids.map(id => ({ '@type': 'ListItem', item: { name: title(id), url: url(id) } })),
    })}</script>` + ids.map(id => `<div class="mb-srp__card"><a href="${url(id).replace('&', '&amp;')}">${title(id)}</a>`
        + `<div>INR ${rent ? '25,000 monthly' : '85 Lakh'} Carpet Area 1000 sqft Bathroom 2 Furnished Posted by Owner</div></div>`).join('');
}

async function matrixHarness(input: ActorInput, micros: number, capacity = Infinity, adjustmentMicros = 0) {
    const charging = await offlineCharging(micros, capacity, adjustmentMicros);
    const normalized = normalizeInput(input);
    const sources = normalized.source === 'both' ? ['magicbricks', '99acres'] as const : [normalized.source];
    const jobs = buildJobs(normalized, [...sources]);
    const jobsByUrl = new Map(jobs.map(job => [job.url, job]));
    const rows: PropertyRecord[] = [];
    const requests: string[] = [];
    const values = new Map<string, unknown>();
    const statuses: string[] = [];
    let proxyCalls = 0;
    let monitorCalls = 0;
    let waits = 0;
    let recoveries = 0;
    let response: ((job: ScrapeJob, attempt: number) => Response | Error) = job => new Response(pageFixture(job));
    const runtime: PropertyScrapeRuntime = {
        createProxy: async configuration => {
            proxyCalls += 1;
            return configuration?.useApifyProxy === false && !Array.isArray(configuration.proxyUrls)
                ? undefined : { newUrl: async () => 'http://127.0.0.1:9999' };
        },
        remainingChargeCount: () => charging.manager.calculateMaxEventChargeCountWithinLimit(EVENT),
        fetchPage: async (url, proxy, options) => {
            const job = jobsByUrl.get(url);
            assert.ok(job, 'collector must use a planned bounded search URL');
            return fetchHtml(url, proxy, options, {
                fetch: (async () => {
                    assert.ok(runtime.remainingChargeCount() > 0, 'no source access after budget depletion');
                    requests.push(url);
                    const result = response(job, requests.length);
                    if (result instanceof Error) throw result;
                    return result;
                }) as typeof fetch,
                delay: async () => { recoveries += 1; },
            });
        },
        pushRecord: async row => {
            assert.ok(runtime.remainingChargeCount() > 0, 'no push after budget depletion');
            // Use the public SDK's budget trimming and charging, with an in-memory
            // dataset and stub charge endpoint. No local model of float rounding.
            const { limitedItems, eventsToCharge } = charging.manager.calculatePushDataLimits({
                items: row, eventName: EVENT, isDefaultDataset: true,
            });
            assert.equal(limitedItems.length, 1);
            rows.push(...limitedItems);
            const results = await Promise.all(Object.entries(eventsToCharge)
                .map(([eventName, count]) => charging.manager.charge({ eventName, count })));
            return { chargedCount: results.reduce((sum, result) => sum + result.chargedCount, 0),
                eventChargeLimitReached: results.some(result => result.eventChargeLimitReached) };
        },
        setValue: async (key, value) => { values.set(key, structuredClone(value)); },
        setStatus: async message => { statuses.push(message); },
        saveMonitor: async () => { monitorCalls += 1; },
        wait: async () => { waits += 1; },
    };
    return { ...charging, runtime, rows, requests, values, statuses, jobs,
        setResponse: (next: typeof response) => { response = next; },
        counts: () => ({ proxyCalls, monitorCalls, waits, recoveries }),
        summary: () => values.get('RUN_SUMMARY') as Record<string, unknown> };
}

// Exercise the new primary-snapshot path with the installed SDK's real budget
// arithmetic in every tier. No fixture makes a network or charge API request.
for (const tier of TIERS) for (const transactionType of TRANSACTIONS) for (const maxResults of [1, 5, 25]) {
    for (const capacity of [0, 1, 5, Infinity]) {
        test(`primary snapshot budget ${tier.name}: ${transactionType}, limit=${maxResults}, capacity=${capacity}`, async () => {
            const check = await matrixHarness({ source: '99acres', transactionType, maxResults, monitorStoreName: 'offline-primary' }, tier.micros, capacity);
            check.setResponse(job => {
                const price = transactionType === 'rent' ? 25_000 : 8_500_000;
                const ids = Array.from({ length: 25 }, (_, index) => (job.page - 1) * 25 + index + 1);
                const listings = ids.map(id => ({ PD_URL: `/2-bhk-flat-in-mumbai-1000-sq-ft-spid-${id}`,
                    MIN_PRICE: price, PRICE_IN_WORDS: `INR ${price}${transactionType === 'rent' ? '/month' : ''}`,
                    CARPET_AREA: 1000, CARPETAREA_UNIT: 'sqft', LOCALIZED_AREA_TYPE: 'Carpet Area', BEDROOM_NUM: 2,
                    BATHROOM_NUM: 2, IS_VERIFIED: true, POSTED_BY: 'Owner' }));
                const head = pageFixture(job) + `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
                    props: { pageProps: { listings } }, page: '/search',
                })}</script>`;
                const stream = new ReadableStream<Uint8Array>({ start(controller) {
                    controller.enqueue(new TextEncoder().encode(head));
                    controller.enqueue(new TextEncoder().encode('<footer>' + 'unused '.repeat(5000) + '</footer>'));
                    controller.close();
                } });
                return new Response(stream);
            });
            await scrapeProperties({ source: '99acres', transactionType, maxResults, monitorStoreName: 'offline-primary' }, check.runtime);
            const expected = Math.min(maxResults, capacity);
            assert.equal(check.rows.length, expected);
            assert.equal(check.summary().savedListings, expected);
            assert.equal(check.summary().failedPages, 0);
            assert.equal(check.summary().terminalFailure, null);
            assert.equal(check.counts().monitorCalls, expected > 0 ? 1 : 0);
            assert.equal(check.requests.length, expected > 0 ? 1 : 0);
            assert.equal(check.summary().earlyStoppedPages, expected === 1 ? 1 : 0);
            assert.equal(check.summary().primary99StatePages, expected > 0 ? 1 : 0);
            assert.deepEqual(check.summary().earlyStoppedSourcePages, { magicbricks: 0, '99acres': expected === 1 ? 1 : 0 });
            assert.ok(check.rows.every(row => row.price === (transactionType === 'rent' ? 25_000 : 8_500_000)
                && row.areaSqft === 1000 && row.bathrooms === 2 && row.verified === true
                && row.priceBasis === (transactionType === 'rent' ? 'monthly_rent' : 'asking_sale')));
        });
    }
}

for (const tier of TIERS) for (const transactionType of TRANSACTIONS) for (const maxResults of [1, 5, 25]) {
    for (const capacity of [0, 1, 5, Infinity]) {
        test(`native initial-data budget ${tier.name}: ${transactionType}, limit=${maxResults}, capacity=${capacity}`, async () => {
            const check = await matrixHarness({ source: '99acres', transactionType, maxResults, monitorStoreName: 'offline-primary' }, tier.micros, capacity);
            check.setResponse(job => {
                const price = transactionType === 'rent' ? 25_000 : 8_500_000;
                const ids = Array.from({ length: 25 }, (_, index) => (job.page - 1) * 25 + index + 1);
                const listings = ids.map(id => ({ SPID: id, PREFERENCE: transactionType === 'rent' ? 'R' : 'S', PD_URL: `/2-bhk-flat-in-mumbai-1000-sq-ft-spid-${id}`,
                    MIN_PRICE: price, PRICE_IN_WORDS: `INR ${price}${transactionType === 'rent' ? '/month' : ''}`,
                    CARPET_AREA: 1000, CARPETAREA_UNIT: 'sqft', LOCALIZED_AREA_TYPE: 'Carpet Area', BEDROOM_NUM: 2,
                    BATHROOM_NUM: 2, IS_VERIFIED: true, POSTED_BY: 'Owner' }));
                const head = pageFixture(job) + `<script>window.__initialData__ = ${JSON.stringify({ search: { listings } })};</script>`;
                const stream = new ReadableStream<Uint8Array>({ start(controller) {
                    controller.enqueue(new TextEncoder().encode(head));
                    controller.enqueue(new TextEncoder().encode('<footer>' + 'unused '.repeat(5000) + '</footer>'));
                    controller.close();
                } });
                return new Response(stream);
            });
            await scrapeProperties({ source: '99acres', transactionType, maxResults, monitorStoreName: 'offline-primary' }, check.runtime);
            const expected = Math.min(maxResults, capacity);
            assert.equal(check.rows.length, expected);
            assert.equal(check.summary().savedListings, expected);
            assert.equal(check.summary().failedPages, 0);
            assert.equal(check.summary().terminalFailure, null);
            assert.equal(check.counts().monitorCalls, expected > 0 ? 1 : 0);
            assert.equal(check.requests.length, expected > 0 ? 1 : 0);
            assert.equal(check.summary().earlyStoppedPages, expected === 1 ? 1 : 0);
            assert.equal(check.summary().primary99StatePages, expected === 1 ? 1 : 0);
            assert.deepEqual(check.summary().earlyStoppedSourcePages, { magicbricks: 0, '99acres': expected === 1 ? 1 : 0 });
            assert.ok(check.rows.every(row => row.price === (transactionType === 'rent' ? 25_000 : 8_500_000)
                && row.areaSqft === 1000 && (expected !== 1 || row.bathrooms === 2 && row.verified === true)
                && row.priceBasis === (transactionType === 'rent' ? 'monthly_rent' : 'asking_sale')));
        });
    }
}

for (const tier of TIERS) for (const source of SOURCES) for (const transactionType of TRANSACTIONS) {
    for (const maxResults of LIMITS) for (const capacity of CAPACITIES) {
        test(`tier matrix ${tier.name}: ${source}/${transactionType}, limit=${maxResults}, capacity=${capacity}`, async () => {
            const input = { source, transactionType, maxResults, monitorStoreName: 'offline-matrix' };
            const check = await matrixHarness(input, tier.micros, capacity);
            await scrapeProperties(input, check.runtime);
            const expectedRows = Math.min(maxResults, capacity);
            assert.equal(check.rows.length, expectedRows);
            assert.equal(check.manager.getChargedEventCount(EVENT), expectedRows);
            assert.equal(check.chargeCalls.length, expectedRows);
            assert.equal(new Set(check.rows.map(propertyKey)).size, expectedRows);
            assert.equal(check.summary().savedListings, expectedRows);
            assert.equal(check.summary().failedPages, 0);
            assert.ok(check.requests.length <= check.jobs.length);
            assert.equal(check.counts().recoveries, 0);
            assert.equal(check.counts().monitorCalls, expectedRows > 0 ? 1 : 0);
            for (const row of check.rows) {
                assert.equal(row.transactionType, transactionType);
                assert.equal(row.price, transactionType === 'sale' ? 8_500_000 : 25_000);
                assert.equal(row.areaSqft, 1000);
                assert.ok(check.requests.includes(row.searchUrl));
                assert.ok(row.propertyUrl.startsWith(`https://www.${row.source}.com/`));
                if (source !== 'both') assert.equal(row.source, source);
            }
            // A small user budget may stop on the first portal before the second
            // portal is visited. Never assert full source coverage in that case.
            if (source === 'both' && expectedRows > Math.ceil(maxResults / 2)) {
                assert.equal(new Set(check.rows.map(row => row.source)).size, 2);
            }
            const totalMicros = START_MICROS + check.manager.getChargedEventCount(EVENT) * tier.micros;
            if (Number.isFinite(capacity)) {
                assert.ok(totalMicros <= Math.round(check.maxTotalChargeUsd * 1_000_000));
                assert.equal(check.summary().spendingLimitReached, capacity <= maxResults);
            }
            if (capacity === 0) {
                assert.equal(check.requests.length, 0);
                assert.equal(check.counts().proxyCalls, 0);
                assert.equal(check.counts().waits, 0);
            }
        });
    }
}

for (const tier of TIERS) for (const capacity of [0, 1, 2, 5, 25, 500]) for (const adjustment of [-1, 0, 1]) {
    test(`SDK micro-dollar boundary ${tier.name}: capacity=${capacity}, adjustment=${adjustment}`, async () => {
        const check = await offlineCharging(tier.micros, capacity, adjustment);
        assert.equal(check.manager.calculateMaxEventChargeCountWithinLimit(EVENT),
            adjustment < 0 ? Math.max(0, capacity - 1) : capacity);
        assert.equal(check.chargeCalls.length, 0);
    });
}

for (const tier of TIERS) for (const budgetMicros of [50, 3050, 10_000, 76_000, 1_500_050]) {
    test(`same-dollar cap ${tier.name}: USD=${budgetMicros / 1_000_000}`, async () => {
        const capacity = Math.floor((budgetMicros - START_MICROS) / tier.micros);
        const adjustment = budgetMicros - START_MICROS - capacity * tier.micros;
        const input = { source: 'magicbricks' as const, maxResults: 500 };
        const check = await matrixHarness(input, tier.micros, capacity, adjustment);
        await scrapeProperties(input, check.runtime);
        const expectedRows = Math.min(500, capacity);
        assert.equal(check.rows.length, expectedRows);
        assert.equal(check.manager.getChargedEventCount(EVENT), expectedRows);
        assert.ok(START_MICROS + expectedRows * tier.micros <= budgetMicros);
        assert.equal(check.summary().spendingLimitReached, capacity <= 500);
        if (capacity === 0) assert.equal(check.requests.length, 0);
    });
}

for (const tier of TIERS) for (const source of ['magicbricks', '99acres'] as const) for (const transactionType of TRANSACTIONS) {
    for (const mode of ['legacy-alias', 'exact-url', 'custom-proxy', 'direct', 'matching-filter', 'excluding-filter'] as const) {
        test(`input/route matrix ${tier.name}: ${source}/${transactionType}, ${mode}`, async () => {
            const input: ActorInput = { source, transactionType, maxResults: 50 };
            if (mode === 'legacy-alias') { delete input.maxResults; input.maxItems = 50; input.city = 'Mumbai'; }
            if (mode === 'exact-url') {
                input.searchUrls = [source === 'magicbricks'
                    ? `https://www.magicbricks.com/property-for-${transactionType}/residential-real-estate?cityName=Mumbai&page=5&bedroom=2`
                    : `https://www.99acres.com/${transactionType === 'rent' ? 'property-for-rent-in' : 'property-in'}-mumbai-ffid-page-5?property_type=1`];
            }
            if (mode === 'custom-proxy') input.proxyConfiguration = { useApifyProxy: false, proxyUrls: ['http://offline:offline@127.0.0.1:9999'] };
            if (mode === 'direct') input.proxyConfiguration = { useApifyProxy: false, proxyUrls: [] };
            if (mode === 'matching-filter') input.minPrice = input.maxPrice = transactionType === 'sale' ? 8_500_000 : 25_000;
            if (mode === 'excluding-filter') input.minPrice = transactionType === 'sale' ? 10_000_000 : 30_000;
            const check = await matrixHarness(input, tier.micros);
            await scrapeProperties(input, check.runtime);
            const expectedRows = mode === 'excluding-filter' ? 0 : 50;
            assert.equal(check.rows.length, expectedRows);
            assert.equal(check.manager.getChargedEventCount(EVENT), expectedRows);
            assert.equal(check.summary().failedPages, 0);
            assert.equal(check.summary().terminalFailure, null);
            if (mode === 'exact-url') {
                assert.deepEqual([...new Set(check.rows.map(row => row.searchPage))], [5, 6]);
                assert.ok(check.requests.every(url => url.includes(source === 'magicbricks' ? 'bedroom=2' : 'property_type=1')));
            }
            if (mode === 'direct') assert.equal((check.summary().connection as { effective: string }).effective, 'direct');
            if (mode === 'custom-proxy') assert.equal((check.summary().connection as { effective: string }).effective, 'custom-proxy');
        });
    }
}

for (const tier of TIERS) for (const source of SOURCES) for (const transactionType of TRANSACTIONS) {
    test(`baseline/repeat CSV ${tier.name}: ${source}/${transactionType}`, async () => {
        let state: unknown = null;
        let releases = 0;
        const reports: Array<{ baseline: boolean; changes: Array<{ change: string }>; historyCommitted: boolean }> = [];
        const csvs: string[] = [];
        const input = { source, transactionType, maxResults: 5, monitorStoreName: 'offline-repeat' };
        for (let observation = 0; observation < 2; observation += 1) {
            const check = await matrixHarness(input, tier.micros);
            check.runtime.saveMonitor = async (_name, rows, scope, _time, threshold, coverage) => {
                await commitPropertyMonitor({
                    loadState: async () => state, prolongLock: async () => {},
                    saveCsv: async csv => { csvs.push(csv); },
                    commitState: async next => { state = structuredClone(next); },
                    saveReport: async report => { reports.push(report); },
                    releaseLock: async () => { releases += 1; },
                }, rows, scope, `2026-10-${10 + observation}T10:00:00.000Z`, threshold, coverage);
            };
            await scrapeProperties(input, check.runtime);
            assert.equal(check.manager.getChargedEventCount(EVENT), 5);
            assert.equal(check.chargeCalls.length, 5);
        }
        assert.equal(releases, 2);
        assert.equal(reports[0].baseline, true);
        assert.equal(reports[1].baseline, false);
        assert.equal(reports[1].historyCommitted, true);
        assert.ok(reports[0].changes.every(change => change.change === 'FIRST_SEEN'));
        assert.ok(reports[1].changes.every(change => change.change === 'UNCHANGED'));
        assert.match(csvs[0], /FIRST_SEEN/);
        assert.match(csvs[1], /UNCHANGED/);
    });
}

const FAILURES = [
    { name: 'HTTP 403', response: () => new Response('Forbidden', { status: 403 }), category: 'SOURCE_HTTP', attempts: 3 },
    { name: 'HTTP 429', response: () => new Response('Rate limited', { status: 429 }), category: 'SOURCE_HTTP', attempts: 3 },
    { name: 'HTTP 500', response: () => new Response('Unavailable', { status: 500 }), category: 'SOURCE_HTTP', attempts: 3 },
    { name: 'HTTP 400', response: () => new Response('Bad request', { status: 400 }), category: 'SOURCE_HTTP', attempts: 1 },
    { name: 'HTTP 407', response: () => new Response('Proxy authentication', { status: 407 }), category: 'PROXY_AUTHENTICATION', attempts: 1 },
    { name: 'HTTP 597', response: () => new Response('Proxy authorization', { status: 597 }), category: 'PROXY_AUTHENTICATION', attempts: 1 },
    { name: 'timeout', response: () => Object.assign(new Error('private timeout'), { name: 'TimeoutError' }), category: 'REQUEST_TIMEOUT', attempts: 3 },
    { name: 'network', response: () => new Error('private network error'), category: 'NETWORK_ERROR', attempts: 3 },
    { name: 'verification', response: () => new Response('<html>Access denied captcha</html>'), category: 'SOURCE_BLOCKED', attempts: 3 },
    { name: 'maintenance', response: () => new Response('<html>We are down for maintenance</html>'), category: 'SOURCE_MAINTENANCE', attempts: 3 },
    { name: 'unrecognized', response: () => new Response('<html>Unrecognized private content</html>'), category: 'SOURCE_UNRECOGNIZED', attempts: 3 },
    { name: 'too large', response: () => new Response('', { headers: { 'content-length': String(MAX_HTML_BYTES + 1) } }), category: 'RESPONSE_TOO_LARGE', attempts: 1 },
] as const;
for (const tier of TIERS) for (const failure of FAILURES) {
    test(`terminal failure ${tier.name}: ${failure.name}`, async () => {
        const input = { maxResults: 1, monitorStoreName: 'offline-failure' };
        const check = await matrixHarness(input, tier.micros);
        check.setResponse(() => failure.response());
        await assert.rejects(scrapeProperties(input, check.runtime), error => {
            assert.ok(error instanceof PropertyFailureError);
            assert.equal(error.info.category, failure.category);
            return true;
        });
        assert.equal(check.requests.length, failure.attempts);
        assert.equal(check.rows.length, 0);
        assert.equal(check.chargeCalls.length, 0);
        assert.equal(check.counts().monitorCalls, 0);
        assert.equal(check.counts().recoveries, failure.attempts - 1);
        assert.equal((check.summary().terminalFailure as { category: string }).category, failure.category);
        assert.doesNotMatch(JSON.stringify([...check.values.values()]), /private timeout|private network|Unrecognized private content/);
    });
    if (failure.attempts > 1) test(`bounded recovery ${tier.name}: ${failure.name}`, async () => {
        const input = { maxResults: 1 };
        const check = await matrixHarness(input, tier.micros);
        check.setResponse((job, attempt) => attempt === 1 ? failure.response() : new Response(pageFixture(job)));
        await scrapeProperties(input, check.runtime);
        assert.equal(check.requests.length, 2);
        assert.equal(check.rows.length, 1);
        assert.equal(check.chargeCalls.length, 1);
        assert.equal(check.counts().recoveries, 1);
        assert.equal(check.summary().failedPages, 0);
        assert.equal(check.summary().requestAttempts, 2);
    });
}

const INVALID_INPUTS: Array<{ name: string; input: unknown }> = [
    { name: 'non-object input', input: [] },
    { name: 'non-string city', input: { city: 123 } },
    { name: 'non-string cities', input: { cities: [123, 'private-value'] } },
    { name: 'non-object proxy', input: { proxyConfiguration: [] } },
    { name: 'ambiguous empty custom route', input: { proxyConfiguration: { proxyUrls: [] } } },
    { name: 'null custom proxy', input: { proxyConfiguration: { proxyUrls: [null] } } },
    { name: 'unsupported custom route', input: { proxyConfiguration: { proxyUrls: ['socks5://user:private-password@proxy.example:9999'] } } },
    { name: 'invalid Apify toggle', input: { proxyConfiguration: { useApifyProxy: 'yes' } } },
    { name: 'unapproved search host', input: { searchUrls: ['https://example.com/private-query'] } },
    { name: 'search credentials', input: { searchUrls: ['https://user:private-password@www.magicbricks.com/property-for-sale-in-mumbai'] } },
    { name: 'conflicting page', input: { searchUrls: ['https://www.99acres.com/property-in-mumbai-ffid-page-5?page=6'] } },
    { name: 'unsafe monitor name', input: { monitorStoreName: '../../private-value' } },
    { name: 'invalid threshold', input: { priceChangeThresholdPercent: -1 } },
    { name: 'reversed price range', input: { minPrice: 200, maxPrice: 100 } },
];
for (const tier of TIERS) for (const scenario of INVALID_INPUTS) {
    test(`invalid-input preflight ${tier.name}: ${scenario.name}`, async () => {
        const check = await matrixHarness({}, tier.micros);
        await assert.rejects(scrapeProperties(scenario.input as ActorInput, check.runtime), error => {
            assert.ok(error instanceof PropertyFailureError);
            assert.equal(error.info.category, 'INPUT_INVALID');
            return true;
        });
        assert.equal(check.requests.length, 0);
        assert.equal(check.chargeCalls.length, 0);
        assert.equal(check.counts().proxyCalls, 0);
        assert.equal(check.counts().monitorCalls, 0);
        assert.equal(check.summary().stopReason, 'INPUT_INVALID');
        assert.doesNotMatch(JSON.stringify([...check.values.values()]), /private-password|private-value|private-query/);
    });
}

for (const tier of TIERS) for (const transactionType of TRANSACTIONS) {
    test(`confirmed-empty watchlist ${tier.name}: both/${transactionType}`, async () => {
        const input = { source: 'both' as const, transactionType, maxResults: 25, monitorStoreName: 'empty-matrix' };
        const check = await matrixHarness(input, tier.micros);
        check.setResponse(() => new Response('No matching properties found'));
        await scrapeProperties(input, check.runtime);
        assert.equal(check.rows.length, 0);
        assert.equal(check.chargeCalls.length, 0);
        assert.equal(check.summary().processedPages, 2);
        assert.equal(check.summary().failedPages, 0);
        assert.equal(check.summary().terminalFailure, null);
        assert.equal(check.counts().monitorCalls, 1);
    });
    for (const failedSource of ['magicbricks', '99acres'] as const) {
        test(`incomplete-empty watchlist ${tier.name}: ${transactionType}, ${failedSource} blocked`, async () => {
            const input = { source: 'both' as const, transactionType, maxResults: 25, monitorStoreName: 'incomplete-matrix' };
            const check = await matrixHarness(input, tier.micros);
            check.setResponse(job => job.source === failedSource
                ? new Response('Forbidden', { status: 403 }) : new Response('No matching properties found'));
            await assert.rejects(scrapeProperties(input, check.runtime), error => {
                assert.ok(error instanceof PropertyFailureError);
                assert.equal(error.info.httpStatus, 403);
                assert.match(error.message, /incomplete/i);
                return true;
            });
            assert.equal(check.rows.length, 0);
            assert.equal(check.chargeCalls.length, 0);
            assert.equal(check.counts().monitorCalls, 0);
            assert.equal(check.summary().processedPages, 1);
            assert.equal(check.summary().stopReason, 'SOURCE_FAILURE');
            assert.ok(!check.statuses.some(status => /no listings matched/i.test(status)));
        });
        test(`partial output is disclosed ${tier.name}: ${transactionType}, ${failedSource} blocked`, async () => {
            const input = { source: 'both' as const, transactionType, maxResults: 25 };
            const check = await matrixHarness(input, tier.micros);
            check.setResponse(job => job.source === failedSource
                ? new Response('Forbidden', { status: 403 }) : new Response(pageFixture(job)));
            await scrapeProperties(input, check.runtime);
            assert.ok(check.rows.length > 0);
            assert.ok((check.summary().failedPages as number) > 0);
            assert.equal(check.manager.getChargedEventCount(EVENT), check.rows.length);
            assert.equal(check.chargeCalls.length, check.rows.length);
            assert.deepEqual(check.summary().sourcesWithSavedListings, [failedSource === 'magicbricks' ? '99acres' : 'magicbricks']);
            assert.ok(check.rows.every(row => row.source !== failedSource));
        });
    }
}

for (const tier of TIERS) for (const price of [5000, 25_000, '25,000', 50_000, 85_000]) {
    test(`small structured rent ${tier.name}: ${price} remains its own price with unknown period`, async () => {
        const input = { source: '99acres' as const, transactionType: 'rent' as const, maxResults: 1 };
        const check = await matrixHarness(input, tier.micros);
        check.setResponse(() => new Response(`<script type="application/ld+json">${JSON.stringify([
            { '@type': 'Apartment', name: '2 BHK Flat Mumbai',
                url: 'https://www.99acres.com/2-bhk-flat-in-mumbai-spid-1001', offers: { price, priceCurrency: 'INR' },
                floorSize: { value: 1000, unitText: 'sqft' } },
            { '@type': 'Apartment', name: 'Other flat Mumbai',
                url: 'https://www.99acres.com/other-flat-in-mumbai-spid-1002', offers: { price: 8_500_000, priceCurrency: 'INR' },
                description: 'INR 85 Lakh Carpet Area 1000 sqft' },
        ])}</script>`));
        await scrapeProperties(input, check.runtime);
        assert.equal(check.rows.length, 1);
        assert.equal(check.rows[0].price, Number(String(price).replace(/,/g, '')));
        assert.equal(check.rows[0].priceBasis, 'unknown');
        assert.ok(check.rows[0].qualityFlags!.includes('rent_period_unknown'));
        assert.equal(check.chargeCalls.length, 1);
    });
}

for (const tier of TIERS) for (const price of [25_000, 250_000]) {
    test(`own monthly period survives structured-price precedence ${tier.name}: ${price}`, async () => {
        const input = { source: '99acres' as const, transactionType: 'rent' as const, maxResults: 1 };
        const check = await matrixHarness(input, tier.micros);
        check.setResponse(() => new Response(`<script type="application/ld+json">${JSON.stringify({
            '@type': 'Apartment', name: '2 BHK Flat Mumbai',
            url: 'https://www.99acres.com/2-bhk-flat-in-mumbai-spid-1001', offers: { price, priceCurrency: 'INR' },
            description: `Rent INR ${price} monthly Carpet Area 1000 sqft Deposit: INR 300000`,
            floorSize: { value: 1000, unitText: 'sqft' },
        })}</script>`));
        await scrapeProperties(input, check.runtime);
        assert.equal(check.rows[0].price, price);
        assert.equal(check.rows[0].priceBasis, 'monthly_rent');
        assert.match(check.rows[0].priceDisplay!, /monthly/i);
        assert.ok(!check.rows[0].qualityFlags!.includes('rent_period_unknown'));
    });
}
