import assert from 'node:assert/strict';
import test from 'node:test';
import { Response, type fetch } from 'undici';
import { fetchHtml, scrapeProperties, type PropertyScrapeRuntime } from './routes.js';
import { commitPropertyMonitor, PropertyMonitorError } from './property-monitor.js';
import type { PropertyRecord } from './types.js';

function listings(ids: number[], price = '85 Lakh'): string {
    const url = (id: number) => `https://www.magicbricks.com/propertyDetails/2-BHK-flat-for-Sale-in-Mumbai&id=${id}.htm`;
    const title = (id: number) => `2 BHK Flat in Project ${id}, Andheri, Mumbai`;
    return `<script type="application/ld+json">${JSON.stringify({ '@type': 'ItemList',
        itemListElement: ids.map(id => ({ '@type': 'ListItem', item: { name: title(id), url: url(id) } })),
    })}</script>` + ids.map(id => `<div class="mb-srp__card"><a href="${url(id).replace('&', '&amp;')}">${title(id)}</a>`
        + `<div>INR ${price} Carpet Area 1000 sqft Bathroom 2 Furnished Posted by Owner</div></div>`).join('');
}

function harness(pages: Array<string | Error>, budget = Infinity) {
    let remaining = budget;
    const rows: PropertyRecord[] = [];
    const urls: string[] = [];
    const values = new Map<string, unknown>();
    const statuses: string[] = [];
    const prefixRowCounts: number[] = [];
    let proxyCalls = 0;
    let waits = 0;
    let recoveries = 0;
    let monitorCalls = 0;
    const runtime: PropertyScrapeRuntime = {
        createProxy: async () => { proxyCalls += 1; return undefined; },
        remainingChargeCount: () => remaining,
        fetchPage: async (url, proxy, options) => {
            if (options.completePrefix) {
                const html = listings([1001, 1002, 1003]);
                const prefix = options.completePrefix(html);
                if (prefix) prefixRowCounts.push((prefix.match(/class="mb-srp__card"/g) ?? []).length);
            }
            return fetchHtml(url, proxy, options, {
                fetch: (async () => {
                    urls.push(url);
                    assert.ok(pages.length > 0, 'unexpected extra source request');
                    const page = pages.shift()!;
                    if (page instanceof Error) throw page;
                    return new Response(page);
                }) as typeof fetch,
                delay: async () => { recoveries += 1; },
            });
        },
        pushRecord: async row => {
            assert.ok(remaining > 0, 'must not push or overcharge with no remaining budget');
            rows.push(row);
            remaining -= 1;
            // The collector must recheck limits even when a push has not reported the stop flag.
            return { chargedCount: 1, eventChargeLimitReached: false };
        },
        setValue: async (key, value) => { values.set(key, structuredClone(value)); },
        setStatus: async message => { statuses.push(message); },
        saveMonitor: async () => { monitorCalls += 1; },
        wait: async () => { waits += 1; },
    };
    return { runtime, rows, urls, values, statuses, prefixRowCounts,
        summary: () => values.get('RUN_SUMMARY') as Record<string, unknown>,
        counts: () => ({ proxyCalls, waits, recoveries, monitorCalls }) };
}

test('zero remaining budget stops before proxy setup or traffic and does not advance a watchlist', async () => {
    const check = harness([], 0);
    await scrapeProperties({ maxResults: 25, monitorStoreName: 'budget-watch' }, check.runtime);
    assert.equal(check.urls.length, 0);
    assert.equal(check.rows.length, 0);
    assert.deepEqual(check.counts(), { proxyCalls: 0, waits: 0, recoveries: 0, monitorCalls: 0 });
    assert.equal(check.summary().spendingLimitReached, true);
    assert.equal(check.summary().processedPages, 0);
    assert.equal(check.summary().failedPages, 0);
    assert.equal(check.summary().stopReason, 'SPENDING_LIMIT');
    assert.match(check.statuses.at(-1)!, /spending limit.*0 property/);
    assert.ok(!check.statuses.some(message => /no listings matched/i.test(message)));
});

test('one-row budget bounds the downloaded prefix and stops before another push, page or wait', async () => {
    const check = harness([listings([1, 2])], 1);
    await scrapeProperties({ maxResults: 50 }, check.runtime);
    assert.equal(check.rows.length, 1);
    assert.equal(check.urls.length, 1);
    assert.deepEqual(check.prefixRowCounts, [1]);
    assert.equal(check.counts().waits, 0);
    assert.equal(check.summary().spendingLimitReached, true);
    assert.equal(check.summary().savedListings, 1);
    assert.equal(check.summary().failedPages, 0);
});

test('the SDK stop flag saves only the delivered row and prevents additional work', async () => {
    const check = harness([listings([1, 2])]);
    check.runtime.pushRecord = async row => {
        check.rows.push(row);
        return { chargedCount: 1, eventChargeLimitReached: true };
    };
    await scrapeProperties({ maxResults: 50 }, check.runtime);
    assert.equal(check.rows.length, 1);
    assert.equal(check.urls.length, 1);
    assert.equal(check.summary().savedListings, 1);
    assert.equal(check.summary().stopReason, 'SPENDING_LIMIT');
    assert.equal(check.counts().waits, 0);
});

test('a rejected dataset push never becomes a saved listing or an empty-search status', async () => {
    const check = harness([listings([1])]);
    check.runtime.pushRecord = async () => ({ chargedCount: 0, eventChargeLimitReached: true });
    await scrapeProperties({ maxResults: 1, monitorStoreName: 'depleted-watch' }, check.runtime);
    assert.equal(check.rows.length, 0);
    assert.equal(check.summary().savedListings, 0);
    assert.equal(check.summary().spendingLimitReached, true);
    assert.ok(!check.statuses.some(message => /no listings matched/.test(message)));
    assert.equal(check.counts().monitorCalls, 0);
});

test('invalid billing capacity fails before any proxy or source access', async () => {
    for (const capacity of [NaN, -1, -Infinity]) {
        const check = harness([]);
        check.runtime.remainingChargeCount = () => capacity;
        await assert.rejects(scrapeProperties({ maxResults: 1 }, check.runtime), /invalid remaining limit/);
        assert.equal(check.counts().proxyCalls, 0);
        assert.equal(check.urls.length, 0);
    }
});

test('unlimited or free collection preserves both pages, complete prices and unique identities', async () => {
    const check = harness([listings([1]), listings([2])]);
    check.runtime.pushRecord = async row => {
        check.rows.push(row);
        return { chargedCount: 0, eventChargeLimitReached: false };
    };
    await scrapeProperties({ maxResults: 50 }, check.runtime);
    assert.equal(check.rows.length, 2);
    assert.equal(check.urls.length, 2);
    assert.equal(check.rows[0].price, 8_500_000);
    assert.equal(check.rows[0].areaSqft, 1000);
    assert.notEqual(check.rows[0].propertyId, check.rows[1].propertyId);
    assert.equal(check.rows[1].searchPage, 2);
    assert.equal(check.summary().spendingLimitReached, false);
});

test('a complete custom search continues 5 to 6 and saves correct page provenance', async () => {
    const check = harness([listings([1]), listings([2])]);
    await scrapeProperties({ maxResults: 50, searchUrls: [
        'https://www.magicbricks.com/property-for-sale/residential-real-estate?cityName=Mumbai&page=5&bedroom=2',
    ] }, check.runtime);
    assert.deepEqual(check.rows.map(row => row.searchPage), [5, 6]);
    assert.deepEqual(check.urls.map(url => new URL(url).searchParams.get('page')), ['5', '6']);
    assert.ok(check.urls.every(url => new URL(url).searchParams.get('bedroom') === '2'));
});

test('a short custom 99acres page can reach 25 priced rows on its bounded continuation', async () => {
    const acresListings = (ids: number[]) => `<script type="application/ld+json">${JSON.stringify(ids.map(id => ({
        '@type': 'Apartment', name: `2 BHK Flat ${id} Mumbai`,
        url: `https://www.99acres.com/2-bhk-flat-in-mumbai-1000-sq-ft-spid-${id}`,
        offers: { price: 8500000, priceCurrency: 'INR' }, floorSize: { value: 1000, unitText: 'sqft' },
    })))}</script>`;
    const check = harness([acresListings(Array.from({ length: 24 }, (_, index) => index + 1)), acresListings([25])]);
    await scrapeProperties({ maxResults: 25, searchUrls: [
        'https://www.99acres.com/property-in-mumbai-ffid-page-5?property_type=1',
    ] }, check.runtime);
    assert.equal(check.rows.length, 25);
    assert.equal(check.urls.length, 2);
    assert.equal(new Set(check.rows.map(row => row.propertyId)).size, 25);
    assert.ok(check.rows.every(row => row.price === 8_500_000));
    assert.equal(check.rows[24].searchPage, 6);
    assert.equal(check.summary().resultLimitReached, true);
});

test('the unchanged one-result default saves exactly one priced row without another page or wait', async () => {
    const check = harness([listings([1, 2])]);
    await scrapeProperties({}, check.runtime);
    assert.equal(check.rows.length, 1);
    assert.equal(check.rows[0].source, 'magicbricks');
    assert.equal(check.rows[0].cityQuery, 'Mumbai');
    assert.equal(check.rows[0].price, 8_500_000);
    assert.equal(check.urls.length, 1);
    assert.equal(check.counts().waits, 0);
    assert.equal(check.summary().stopReason, 'RESULT_LIMIT');
});

test('duplicate pages stop the search without duplicate charges or an extra request', async () => {
    const check = harness([listings([1]), listings([1])]);
    await scrapeProperties({ maxResults: 75 }, check.runtime);
    assert.equal(check.rows.length, 1);
    assert.equal(check.urls.length, 2);
    assert.equal(check.summary().repeatedSearchPages, 1);
    assert.equal(check.counts().waits, 1);
});

test('total maintenance failure remains a visible failure with a diagnostic summary', async () => {
    const maintenance = '<html><h1>We are down for maintenance</h1></html>';
    const check = harness([maintenance, maintenance, maintenance]);
    await assert.rejects(scrapeProperties({ maxResults: 1 }, check.runtime), /All property pages failed/);
    assert.equal(check.rows.length, 0);
    assert.equal(check.urls.length, 3);
    assert.equal(check.summary().failedPages, 1);
    assert.equal(check.summary().stopReason, 'SOURCE_FAILURE');
});

test('transient replacement page recovers complete output through the actual collection loop', async () => {
    const check = harness(['<html>Temporary replacement</html>', listings([1])]);
    await scrapeProperties({ maxResults: 1 }, check.runtime);
    assert.equal(check.rows.length, 1);
    assert.equal(check.rows[0].price, 8_500_000);
    assert.equal(check.urls.length, 2);
    assert.equal(check.summary().failedPages, 0);
    assert.equal(check.summary().stopReason, 'RESULT_LIMIT');
});

test('a failed city does not prevent another configured city from returning priced output', async () => {
    const maintenance = '<html><h1>We are down for maintenance</h1></html>';
    const check = harness([maintenance, maintenance, maintenance, listings([1])]);
    await scrapeProperties({ maxResults: 1, cities: ['Mumbai', 'Pune'] }, check.runtime);
    assert.equal(check.rows.length, 1);
    assert.equal(check.summary().failedPages, 1);
    assert.equal(check.summary().processedPages, 1);
    assert.equal(check.summary().savedListings, 1);
    assert.equal(check.summary().failedSearches, 1);
    assert.equal(check.summary().stopReason, 'RESULT_LIMIT');
});

test('confirmed empty search remains a genuine empty result, not an outage or budget stop', async () => {
    const check = harness(['No matching properties found']);
    await scrapeProperties({ maxResults: 1 }, check.runtime);
    assert.equal(check.urls.length, 1);
    assert.equal(check.summary().failedPages, 0);
    assert.equal(check.summary().stopReason, 'SEARCH_EXHAUSTED');
    assert.match(check.statuses.at(-1)!, /no listings matched/);
});

test('proxy setup failure retains safe diagnostics before any property request', async () => {
    const check = harness([]);
    check.runtime.createProxy = async () => { throw new Error('Proxy authentication failed: http://user:private-password@proxy.example'); };
    await assert.rejects(scrapeProperties({ cities: ['Mumbai', 'Pune'], maxResults: 50,
        proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['DATACENTER'] } }, check.runtime));
    assert.equal(check.urls.length, 0);
    assert.equal(check.summary().stopReason, 'PROXY_CONFIGURATION_FAILURE');
    assert.doesNotMatch(JSON.stringify(check.summary()), /private-password|proxy\.example|user:/);
});

test('recommended proxy setup failure uses one bounded direct fallback', async () => {
    const check = harness([listings([1])]);
    check.runtime.createProxy = async () => { throw new Error('Proxy authentication failed: private-password'); };
    await scrapeProperties({ maxResults: 1 }, check.runtime);
    assert.equal(check.urls.length, 1);
    assert.equal(check.rows.length, 1);
    assert.deepEqual(check.summary().connection, {
        requested: 'recommended-residential-in',
        effective: 'direct',
        directFallbackUsed: true,
        directFallbackSucceeded: true,
        directFallbackReason: {
            category: 'PROXY_AUTHENTICATION',
            message: 'Proxy authorization failed. Check the configured proxy credentials and access; rotating the same credentials will not fix this.',
        },
    });
    assert.doesNotMatch(JSON.stringify(check.summary()), /private-password/);
});

test('recommended proxy authorization failure retries the page direct once and switches the run', async () => {
    const proxyFailure = new TypeError('fetch failed private-secret', {
        cause: new Error('Proxy response (407) !== 200 when HTTP Tunneling'),
    });
    const check = harness([proxyFailure, listings([1])]);
    check.runtime.createProxy = async () => ({ newUrl: async () => 'http://user:private-password@127.0.0.1:8000' });
    await scrapeProperties({ maxResults: 1 }, check.runtime);
    assert.equal(check.urls.length, 2);
    assert.equal(check.rows.length, 1);
    const connection = check.summary().connection as Record<string, unknown>;
    assert.equal(connection.effective, 'direct');
    assert.equal(connection.directFallbackUsed, true);
    assert.equal(connection.directFallbackSucceeded, true);
    assert.deepEqual(check.summary().failureCategories, {});
    assert.doesNotMatch(JSON.stringify(check.summary()), /private-secret|127\.0\.0\.1|user:/);
});

test('permanent proxy authentication failure stops all remaining cities and portals', async () => {
    const check = harness([new TypeError('fetch failed private-secret', {
        cause: new Error('Proxy response (407) !== 200 when HTTP Tunneling'),
    })]);
    await assert.rejects(scrapeProperties({ source: 'both', cities: ['Mumbai', 'Pune'], maxResults: 100 }, check.runtime),
        /Proxy authorization failed/);
    assert.equal(check.urls.length, 1);
    assert.equal(check.counts().recoveries, 0);
    assert.equal(check.counts().waits, 0);
    assert.equal(check.summary().requestAttempts, 1);
    assert.equal(check.summary().failedPages, 1);
    assert.equal(check.summary().stopReason, 'PROXY_CONFIGURATION_FAILURE');
    assert.deepEqual(check.summary().failureCategories, { PROXY_AUTHENTICATION: 1 });
    assert.doesNotMatch(JSON.stringify(check.summary()), /private-secret/);
});

test('invalid input retains a safe summary and never initializes a proxy or requests listings', async () => {
    const check = harness([]);
    await assert.rejects(scrapeProperties({ cities: [123, 'private-secret'] } as never, check.runtime), /cities must contain/);
    assert.equal(check.counts().proxyCalls, 0);
    assert.equal(check.urls.length, 0);
    assert.equal(check.summary().stopReason, 'INPUT_INVALID');
    assert.doesNotMatch(JSON.stringify(check.summary()), /private-secret/);
});

test('output billing errors keep their failure category and save safe truthful diagnostics', async () => {
    const check = harness([listings([1])]);
    check.runtime.pushRecord = async () => { throw new Error('Billing service unavailable'); };
    await assert.rejects(scrapeProperties({ maxResults: 50, monitorStoreName: 'billing-watch' }, check.runtime),
        /Saving or charging for property output failed/);
    assert.equal(check.rows.length, 0);
    assert.equal(check.urls.length, 1);
    assert.equal(check.summary().stopReason, 'OUTPUT_BILLING_FAILURE');
    assert.equal(check.summary().spendingLimitReached, false);
    assert.equal(check.summary().failedPages, 0);
    assert.equal(check.counts().monitorCalls, 0);
});

test('monitor failure preserves delivered rows but is never reported as a successful baseline', async () => {
    const check = harness([listings([1])]);
    check.runtime.saveMonitor = async () => { throw new PropertyMonitorError('CSV export unavailable', false); };
    await assert.rejects(scrapeProperties({ maxResults: 1, monitorStoreName: 'broken-watch' }, check.runtime),
        /requested monitor update failed/);
    assert.equal(check.rows.length, 1);
    assert.equal((check.values.get('PROPERTY_REPORT') as { historyCommitted: boolean }).historyCommitted, false);
});

test('two full watchlist runs commit baseline then repeat history and CSV without platform writes', async () => {
    let state: unknown = null;
    let releases = 0;
    const reports: Array<Record<string, unknown>> = [];
    const csvs: string[] = [];
    const baseline = harness([listings([1])]);
    const repeat = harness([listings([1])]);
    const saveMonitor: PropertyScrapeRuntime['saveMonitor'] = async (_name, rows, scope, _observedAt, threshold, coverage) => {
        await commitPropertyMonitor({
            loadState: async () => state,
            prolongLock: async () => {},
            saveCsv: async csv => { csvs.push(csv); },
            commitState: async next => { state = structuredClone(next); },
            saveReport: async report => { reports.push(report as unknown as Record<string, unknown>); },
            releaseLock: async () => { releases += 1; },
        }, rows, scope, `2026-10-${reports.length + 10}T10:00:00.000Z`, threshold, coverage);
    };
    baseline.runtime.saveMonitor = saveMonitor;
    repeat.runtime.saveMonitor = saveMonitor;
    const input = { maxResults: 1, monitorStoreName: 'clean-repeat' };
    await scrapeProperties(input, baseline.runtime);
    await scrapeProperties(input, repeat.runtime);
    assert.equal(releases, 2);
    assert.equal(reports[0].baseline, true);
    assert.equal(reports[1].baseline, false);
    assert.equal((reports[0].changes as Array<{ change: string }>)[0].change, 'FIRST_SEEN');
    assert.equal((reports[1].changes as Array<{ change: string }>)[0].change, 'UNCHANGED');
    assert.match(csvs[0], /FIRST_SEEN/);
    assert.match(csvs[1], /UNCHANGED/);
});
