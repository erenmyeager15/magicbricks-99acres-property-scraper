import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeInput } from './input.js';

test('uses a one-result MagicBricks Residential India default', () => {
    const input = normalizeInput(null);

    assert.equal(input.source, 'magicbricks');
    assert.equal(input.transactionType, 'sale');
    assert.deepEqual(input.cities, ['Mumbai']);
    assert.equal(input.maxResults, 1);
    assert.deepEqual(input.proxyConfiguration, {
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
        apifyProxyCountry: 'IN',
    });
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
});
