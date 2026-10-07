import assert from 'node:assert/strict';
import test from 'node:test';
import { addPropertyIntelligence, buildPropertyReport, MAX_MONITORED_PROPERTIES, monitorScope, propertyChangesCsv,
    propertyKey, readMonitorState, squareFeet } from './property-intelligence.js';
import { classifyPropertyPage, extractArea, shouldStopFailedSearch, buildJobs } from './routes.js';
import { normalizeInput } from './input.js';
import type { PropertyRecord } from './types.js';
import { commitPropertyMonitor, PropertyMonitorError, type PropertyMonitorStorage } from './property-monitor.js';

function row(overrides: Partial<PropertyRecord> = {}): PropertyRecord {
    return { source: 'magicbricks', transactionType: 'sale', propertyId: '42', cityQuery: 'Mumbai',
        city: 'Mumbai', locality: 'Bandra', propertyType: 'Apartment', bhk: 2, price: 10_000_000,
        priceDisplay: 'INR 1 Cr', area: 1_000, areaUnit: 'sqft', areaType: 'Carpet Area',
        pricePerSqft: 10_000, propertyUrl: 'https://www.magicbricks.com/propertyDetails-42',
        scrapedAt: '2026-10-07T10:00:00.000Z', ...overrides } as PropertyRecord;
}
const first = '2026-10-07T10:00:00.000Z';
const second = '2026-10-08T10:00:00.000Z';
const baseline = () => buildPropertyReport([row()], null, 'scope', first, 5, { failedPages: 0 });

test('normalizes sqft, square metres and yards without guessing unknown units', () => {
    assert.equal(squareFeet(100, 'sqm'), 1076.39);
    assert.equal(squareFeet(100, 'sqyd'), 900);
    assert.equal(squareFeet(100, 'MTK'), 1076.39);
    assert.equal(squareFeet(100, 'bigha'), null);
    assert.equal(squareFeet(-1, 'sqft'), null);
    assert.equal(squareFeet(Number.NaN, 'sqft'), null);
    assert.deepEqual(extractArea('Carpet Area 100 sq.m'), { value: 100, unit: 'sqm' });
    assert.deepEqual(extractArea('Plot Area 120 square yards'), { value: 120, unit: 'sqyd' });
    assert.deepEqual(extractArea('Super area 1,200 sqft'), { value: 1200, unit: 'sqft' });
});
test('keeps portal IDs separate and excludes unknown area/rent basis from comparisons', () => {
    assert.notEqual(propertyKey(row()), propertyKey(row({ source: '99acres' })));
    assert.equal(addPropertyIntelligence(row({ areaType: null })).comparisonKey, null);
    assert.equal(addPropertyIntelligence(row({ transactionType: 'rent', priceDisplay: '₹25,000' })).priceBasis, 'unknown');
    assert.equal(addPropertyIntelligence(row({ transactionType: 'rent', priceDisplay: '₹25,000 monthly' })).priceBasis, 'monthly_rent');
    assert.equal(addPropertyIntelligence(row({ priceDisplay: '₹1 Cr - ₹2 Cr' })).comparisonKey, null);
});
test('creates a first-seen baseline then an unchanged observation', () => {
    const initial = baseline();
    assert.equal(initial.report.baseline, true);
    assert.equal(initial.report.changes[0].change, 'FIRST_SEEN');
    const repeat = buildPropertyReport([row()], initial.state, 'scope', second, 5, {});
    assert.equal(repeat.report.changes[0].change, 'UNCHANGED');
    assert.equal(repeat.report.changes[0].priceAlert, false);
    assert.equal(repeat.state.entries[0].observations.length, 2);
    assert.equal(repeat.state.entries[0].firstSeenAt, first);
});
test('flags comparable price drops and keeps small changes below the alert threshold', () => {
    const drop = buildPropertyReport([row({ price: 9_000_000 })], baseline().state, 'scope', second, 5, {});
    assert.equal(drop.report.changes[0].change, 'PRICE_DECREASE');
    assert.equal(drop.report.changes[0].priceChangePercent, -10);
    assert.equal(drop.report.changes[0].priceAlert, true);
    const small = buildPropertyReport([row({ price: 10_100_000 })], baseline().state, 'scope', second, 5, {});
    assert.equal(small.report.changes[0].change, 'PRICE_INCREASE');
    assert.equal(small.report.changes[0].priceAlert, false);
});
test('does not call area/period changes or missing prices a comparable price change', () => {
    for (const record of [row({ area: 1500 }), row({ areaType: 'Super Built-up Area' }), row({ price: null }),
        row({ transactionType: 'rent', priceDisplay: '₹25,000 monthly', price: 25_000 }), row({ priceDisplay: '₹1 Cr - ₹2 Cr' })]) {
        const change = buildPropertyReport([record], baseline().state, 'scope', second, 5, {}).report.changes[0];
        assert.equal(change.priceComparable, false);
        assert.equal(change.priceAlert, false);
        assert.equal(change.priceChangePercent, null);
    }
});
test('reports missing rows as NOT_OBSERVED and preserves their history after partial failures', () => {
    const next = buildPropertyReport([], baseline().state, 'scope', second, 5, { failedPages: 1, resultLimitReached: true });
    assert.equal(next.report.changes[0].change, 'NOT_OBSERVED');
    assert.equal(next.state.entries[0].lastSeenAt, first);
    assert.equal(next.report.coverage.failedPages, 1);
    assert.match(next.report.note, /does not mean sold/);
});
test('scope includes filter/limit changes but ignores ordering and excludes credentials', () => {
    const config = normalizeInput({ source: 'both', maxResults: 25 });
    assert.equal(monitorScope(config, ['a', 'b']), monitorScope(config, ['b', 'a', 'a']));
    assert.notEqual(monitorScope(config, ['a']), monitorScope({ ...config, maxResults: 50 }, ['a']));
    assert.notEqual(monitorScope(config, ['a']), monitorScope({ ...config, minPrice: 1 }, ['a']));
    assert.equal(monitorScope(config, ['a']), monitorScope({ ...config, proxyConfiguration: { proxyUrls: ['secret'] } }, ['a']));
    assert.throws(() => buildPropertyReport([], baseline().state, 'newscope', second, 5, {}), /inputs changed/);
    assert.throws(() => buildPropertyReport([], baseline().state, 'scope', first, 5, {}), /stale/);
});
test('bounds storage by retention, property count and ten observations', () => {
    let state = baseline().state;
    for (let day = 8; day <= 20; day++) state = buildPropertyReport([row()], state, 'scope', `2026-10-${String(day).padStart(2, '0')}T10:00:00.000Z`, 5, {}).state;
    assert.equal(state.entries[0].observations.length, 10);
    const many = Array.from({ length: 2100 }, (_, n) => row({ propertyId: String(n) }));
    assert.equal(buildPropertyReport(many, null, 'scope', first, 5, {}).state.entries.length, MAX_MONITORED_PROPERTIES);
    assert.equal(buildPropertyReport([], baseline().state, 'scope', '2026-12-01T10:00:00.000Z', 5, {}).state.entries.length, 0);
});
test('produces only like-for-like sample medians, not a valuation across area types', () => {
    const report = buildPropertyReport([row(), row({ propertyId: '43', pricePerSqft: 12000 }),
        row({ propertyId: '44', pricePerSqft: 20000 }), row({ propertyId: '45', areaType: 'Super Built-up Area', pricePerSqft: 2000 })], null, 'scope', first, 5, {}).report;
    assert.equal(report.sampleBenchmarks.length, 1);
    assert.equal(report.sampleBenchmarks[0].medianPricePerSqft, 12000);
    assert.equal(report.sampleBenchmarks[0].sampleSize, 3);
});
test('rejects corrupt persisted state and safely quotes formula-like CSV fields', () => {
    assert.equal(readMonitorState(null), null);
    assert.deepEqual(readMonitorState(baseline().state), baseline().state);
    assert.throws(() => readMonitorState({ version: 5 }), /Unsupported/);
    const report = baseline().report;
    report.changes[0].key = '=HYPERLINK("unsafe")';
    assert.match(propertyChangesCsv(report), /'=HYPERLINK\(""unsafe""\)/);
});
test('classifies an unparsed challenge even when generic JSON-LD exists', () => {
    assert.equal(classifyPropertyPage('<script type="application/ld+json">{"@type":"WebSite"}</script> Access denied captcha', 0), 'blocked');
    assert.equal(classifyPropertyPage('No properties found', 0), 'empty');
    assert.equal(classifyPropertyPage('<html>Changed page layout</html>', 0), 'unrecognized');
    assert.equal(classifyPropertyPage('real listings', 1), 'listings');
    assert.equal(shouldStopFailedSearch(1), false);
    assert.equal(shouldStopFailedSearch(2), true);
});
test('round-robins supplied portal URLs rather than exhausting the first source first', () => {
    const jobs = buildJobs(normalizeInput({ maxResults: 50, searchUrls: [
        'https://www.magicbricks.com/property-for-sale/residential-real-estate?cityName=Mumbai',
        'https://www.99acres.com/property-in-mumbai-ffid',
    ] }), ['magicbricks', '99acres']);
    assert.deepEqual(jobs.map(job => [job.source, job.page]), [['magicbricks', 1], ['99acres', 1], ['magicbricks', 2], ['99acres', 2]]);
});
test('validates monitoring name and threshold without changing default scraping', () => {
    assert.equal(normalizeInput(null).monitorStoreName, null);
    assert.equal(normalizeInput({ monitorStoreName: 'mumbai-2bhk' }).monitorStoreName, 'mumbai-2bhk');
    assert.throws(() => normalizeInput({ monitorStoreName: '../escape' }), /monitorStoreName/);
    assert.throws(() => normalizeInput({ priceChangeThresholdPercent: -1 }), /priceChangeThreshold/);
});

function fakeStorage(failAt?: string) {
    const calls: string[] = [];
    let savedState: unknown = null;
    const step = async (name: string) => { calls.push(name); if (name === failAt) throw new Error(`${name} failed`); };
    const storage: PropertyMonitorStorage = {
        loadState: async () => { await step('load'); return savedState; },
        prolongLock: async () => { await step('prolong'); },
        saveCsv: async () => { await step('csv'); },
        commitState: async state => { await step('state'); savedState = state; },
        saveReport: async report => { await step('report'); assert.equal(report.historyCommitted, true); },
        releaseLock: async () => { await step('release'); },
    };
    return { storage, calls, state: () => savedState };
}

test('monitor exports before committing, releases its lease, and compares a repeat', async () => {
    const fake = fakeStorage();
    await commitPropertyMonitor(fake.storage, [row()], 'scope', first, 5, {});
    assert.deepEqual(fake.calls, ['load', 'prolong', 'csv', 'state', 'report', 'release']);
    await commitPropertyMonitor(fake.storage, [row()], 'scope', second, 5, {});
    assert.equal(readMonitorState(fake.state())!.entries[0].observations.length, 2);
});
test('failed exports or leases never advance the baseline', async () => {
    for (const point of ['load', 'prolong', 'csv']) {
        const fake = fakeStorage(point);
        await assert.rejects(commitPropertyMonitor(fake.storage, [row()], 'scope', first, 5, {}),
            (error: unknown) => error instanceof PropertyMonitorError && error.historyCommitted === false);
        assert.equal(fake.state(), null);
        assert.equal(fake.calls.at(-1), 'release');
        assert.ok(!fake.calls.includes('state'));
    }
});
test('ambiguous state-write errors are not reported as a guaranteed rollback', async () => {
    const fake = fakeStorage('state');
    await assert.rejects(commitPropertyMonitor(fake.storage, [row()], 'scope', first, 5, {}),
        (error: unknown) => error instanceof PropertyMonitorError && error.historyCommitted === 'unknown');
    assert.equal(fake.calls.at(-1), 'release');
    assert.ok(!fake.calls.includes('report'));
});
test('post-commit report or lease failures retain truthful commit status', async () => {
    for (const point of ['report', 'release']) {
        const fake = fakeStorage(point);
        await assert.rejects(commitPropertyMonitor(fake.storage, [row()], 'scope', first, 5, {}),
            (error: unknown) => error instanceof PropertyMonitorError && error.historyCommitted === true);
        assert.ok(readMonitorState(fake.state()));
        assert.equal(fake.calls.at(-1), 'release');
    }
});
test('stale commits release their lease without overwriting a newer snapshot', async () => {
    const fake = fakeStorage();
    await commitPropertyMonitor(fake.storage, [row()], 'scope', second, 5, {});
    await assert.rejects(commitPropertyMonitor(fake.storage, [row()], 'scope', first, 5, {}), /stale/);
    assert.equal(readMonitorState(fake.state())!.observedAt, second);
    assert.equal(fake.calls.filter(call => call === 'state').length, 1);
    assert.equal(fake.calls.at(-1), 'release');
});
test('rejects corrupt observations, duplicate state IDs and invented price bases', () => {
    const corruptObservation = structuredClone(baseline().state);
    corruptObservation.entries[0].observations[0].price = Number.NaN;
    assert.throws(() => readMonitorState(corruptObservation), /Corrupt/);
    const duplicate = structuredClone(baseline().state);
    duplicate.entries.push(structuredClone(duplicate.entries[0]));
    assert.throws(() => readMonitorState(duplicate), /Corrupt/);
    const badBasis = structuredClone(baseline().state);
    badBasis.entries[0].priceBasis = 'daily_return';
    assert.throws(() => readMonitorState(badBasis), /Corrupt/);
});
