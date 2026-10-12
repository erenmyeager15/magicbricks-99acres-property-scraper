import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { normalizeInput } from './input.js';

test('uses a one-result Mumbai MagicBricks Residential India default', () => {
    const input = normalizeInput(null);

    assert.equal(input.source, 'magicbricks');
    assert.equal(input.transactionType, 'sale');
    assert.deepEqual(input.cities, ['Mumbai']);
    assert.equal(input.maxResults, 1);
    assert.deepEqual(input.searchUrls, []);
    assert.deepEqual(input.proxyConfiguration, {
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
        apifyProxyCountry: 'IN',
    });
    assert.equal(input.allowRecommendedDirectFallback, true);
});

test('accepts full portal search URLs and preserves their filters', () => {
    const input = normalizeInput({
        searchUrls: [
            'https://www.magicbricks.com/property-for-rent/residential-real-estate?cityName=Pune&bedroom=3&budgetMax=50000',
            'https://www.99acres.com/property-in-bengaluru-ffid?property_type=1&budget_min=5000000',
        ],
    });

    assert.equal(input.searchUrls.length, 2);
    assert.equal(input.searchUrls[0].source, 'magicbricks');
    assert.equal(input.searchUrls[0].transactionType, 'rent');
    assert.equal(input.searchUrls[0].city, 'Pune');
    assert.match(input.searchUrls[0].url, /bedroom=3&budgetMax=50000/);
    assert.equal(input.searchUrls[1].source, '99acres');
    assert.equal(input.searchUrls[1].transactionType, 'sale');
    assert.equal(input.searchUrls[1].city, 'Bengaluru');
});

test('rejects lookalike and credential-bearing search URLs', () => {
    assert.throws(
        () => normalizeInput({ searchUrls: ['https://magicbricks.com.evil.example/search'] }),
        /magicbricks\.com or 99acres\.com/,
    );
    assert.throws(
        () => normalizeInput({ searchUrls: ['https://user:pass@www.99acres.com/property-in-pune-ffid'] }),
        /standard public HTTPS URL/,
    );
});

test('rejected search URLs never echo credentials or query secrets', () => {
    for (const url of [
        'https://user:private-password@www.99acres.com/property-in-pune-ffid',
        'https://magicbricks.com.evil.example/search?token=private-password',
        'not a url private-password',
    ]) {
        assert.throws(() => normalizeInput({ searchUrls: [url] }), error => {
            assert.ok(error instanceof Error);
            assert.doesNotMatch(error.message, /private-password|user:/);
            return true;
        });
    }
});

test('rejects invalid or conflicting starting pages before requesting the source', () => {
    for (const url of [
        'https://www.magicbricks.com/search?page=0',
        'https://www.magicbricks.com/search?page=2.5',
        'https://www.magicbricks.com/search?page=2&page=3',
        'https://www.99acres.com/property-in-mumbai-ffid-page-5?page=2',
        'https://www.99acres.com/property-in-mumbai-ffid-page-invalid',
    ]) {
        assert.throws(() => normalizeInput({ searchUrls: [url] }), /starting page/i);
    }
});

test('cleans cities, clamps limits, and completes partial proxy input', () => {
    const input = normalizeInput({
        source: 'both',
        transactionType: 'rent',
        cities: [' Pune ', '', 'Pune', ' Mumbai  South '],
        minPrice: 25_000,
        maxPrice: 90_000,
        maxResults: 900,
        proxyConfiguration: { apifyProxyCountry: 'IN' },
    });

    assert.deepEqual(input.cities, ['Pune', 'Mumbai South']);
    assert.equal(input.maxResults, 500);
    assert.equal(input.minPrice, 25_000);
    assert.equal(input.maxPrice, 90_000);
    assert.deepEqual(input.proxyConfiguration, {
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
        apifyProxyCountry: 'IN',
    });
    assert.equal(input.allowRecommendedDirectFallback, true);
});

test('rejects inverted price ranges before scraping', () => {
    assert.throws(
        () => normalizeInput({ minPrice: 5_000_000, maxPrice: 1_000_000 }),
        /minPrice cannot be greater than maxPrice/,
    );
});

test('preserves explicit proxy-off input', () => {
    const input = normalizeInput({ proxyConfiguration: { useApifyProxy: false } });
    assert.deepEqual(input.proxyConfiguration, { useApifyProxy: false });
    assert.equal(input.allowRecommendedDirectFallback, false);
});

test('accepts common API aliases without weakening bounded normalization', () => {
    const input = normalizeInput({
        cities: [],
        city: 'Pune',
        maxItems: 25,
        searchUrls: [],
        startUrls: [{ url: 'https://www.magicbricks.com/property-for-sale/residential-real-estate?cityName=Pune' }],
    });
    assert.deepEqual(input.cities, ['Pune']);
    assert.equal(input.maxResults, 25);
    assert.equal(input.searchUrls.length, 1);
    assert.equal(input.searchUrls[0].city, 'Pune');
});

test('keeps UI prefills without schema-injecting primary fields over API aliases', () => {
    const schema = JSON.parse(readFileSync('INPUT_SCHEMA.json', 'utf8')) as {
        properties: Record<string, { default?: unknown; prefill?: unknown }>;
    };

    assert.equal(schema.properties.cities.default, undefined);
    assert.deepEqual(schema.properties.cities.prefill, ['Mumbai']);
    assert.equal(schema.properties.maxResults.default, undefined);
    assert.equal(schema.properties.maxResults.prefill, 1);

    const input = normalizeInput({ city: 'Pune', maxItems: 5 });
    assert.deepEqual(input.cities, ['Pune']);
    assert.equal(input.maxResults, 5);
});

test('accepts one city string and one search URL string from API clients', () => {
    const input = normalizeInput({
        cities: 'Bengaluru',
        searchUrls: 'https://www.99acres.com/property-in-bangalore-ffid',
    });
    assert.deepEqual(input.cities, ['Bengaluru']);
    assert.equal(input.searchUrls[0].source, '99acres');
});

test('malformed city and monitor inputs fail with actionable validation instead of TypeError', () => {
    assert.throws(() => normalizeInput({ cities: [123] } as never), /cities must contain/i);
    assert.throws(() => normalizeInput({ monitorStoreName: 123 } as never), /monitorStoreName must be/i);
});

test('custom proxy settings never opt into the automatic direct fallback', () => {
    const input = normalizeInput({ proxyConfiguration: {
        useApifyProxy: true,
        apifyProxyGroups: ['DATACENTER'],
    } });
    assert.equal(input.allowRecommendedDirectFallback, false);
});

test('malformed encoded search paths and non-object proxy input fail safely before access', () => {
    assert.throws(() => normalizeInput({ searchUrls: ['https://www.99acres.com/property-in-%E0%A4-ffid'] }), /valid URL-encoded/);
    assert.throws(() => normalizeInput({ proxyConfiguration: 'private-secret' } as never), /proxy configuration object/);
    assert.throws(() => normalizeInput(['private-secret'] as never), /JSON object/);
});
