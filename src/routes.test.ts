import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildJobs,
    calculatePageLimit,
    calculatePricePerSqft,
    calculate99AcresPageLimit,
    createRequestSignal,
    extractAmenityNames,
    extractFacing,
    extractListedBy,
    extractPropertyAge,
    isRetryableHttpStatus,
    paginateSearchUrl,
    parseIndianMoney,
    readBoundedResponseText,
    redactSensitiveText,
    shouldDelayBeforeNextJob,
    shouldFailEmptyRun,
} from './routes.js';
import { normalizeInput } from './input.js';

test('builds one exact job for each supplied search URL without rewriting filters', () => {
    const input = normalizeInput({
        searchUrls: ['https://www.magicbricks.com/property-for-sale/residential-real-estate?cityName=Mumbai&bedroom=4'],
        maxResults: 10,
    });
    const jobs = buildJobs(input, ['magicbricks']);

    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].isCustomUrl, true);
    assert.equal(jobs[0].source, 'magicbricks');
    assert.equal(jobs[0].city, 'Mumbai');
    assert.match(jobs[0].url, /cityName=Mumbai&bedroom=4/);
});

test('limits 99acres pagination to one bounded overfetch page', () => {
    assert.equal(calculatePageLimit(1), 1);
    assert.equal(calculatePageLimit(25), 1);
    assert.equal(calculatePageLimit(26), 2);
    assert.equal(calculate99AcresPageLimit(1), 2);
    assert.equal(calculate99AcresPageLimit(25), 2);
    assert.equal(calculate99AcresPageLimit(26), 3);
    assert.equal(calculate99AcresPageLimit(1_000), 20);
});

test('paginates full search URLs while preserving their filters', () => {
    const magicUrl = paginateSearchUrl(
        'https://www.magicbricks.com/property-for-sale/residential-real-estate?cityName=Mumbai&bedroom=4',
        'magicbricks',
        2,
    );
    const acresUrl = paginateSearchUrl(
        'https://www.99acres.com/property-in-bengaluru-ffid?property_type=1&budget_min=5000000',
        '99acres',
        3,
    );

    assert.match(magicUrl, /cityName=Mumbai/);
    assert.match(magicUrl, /bedroom=4/);
    assert.match(magicUrl, /page=2/);
    assert.match(acresUrl, /property-in-bengaluru-ffid-page-3/);
    assert.match(acresUrl, /property_type=1/);
    assert.match(acresUrl, /budget_min=5000000/);
});

test('extracts safe property detail fields from public listing text', () => {
    const text = 'Posted by owner. This east-facing freehold flat is 0-1 year old with lift(s), security guard and gymnasium.';

    assert.equal(extractListedBy(text), 'Owner');
    assert.equal(extractListedBy('Get Phone No. Contact Agent'), 'Agent');
    assert.equal(extractFacing(text), 'East');
    assert.equal(extractPropertyAge(text), '0-1 year old');
    assert.deepEqual(extractAmenityNames(text), ['Lift', 'Security', 'Gymnasium']);
});

test('parses crore and lakh prices into INR numbers', () => {
    assert.equal(parseIndianMoney('INR 1.25 Crore'), 12_500_000);
    assert.equal(parseIndianMoney('Rs. 85 Lakh'), 8_500_000);
});

test('parses plain INR prices and missing values', () => {
    assert.equal(parseIndianMoney('INR 6,250,000'), 6_250_000);
    assert.equal(parseIndianMoney(null), null);
});

test('normalizes listing prices to price per square foot', () => {
    assert.equal(calculatePricePerSqft(10_000_000, 1_000, 'sqft'), 10_000);
    assert.equal(calculatePricePerSqft(10_000_000, 100, 'sqm'), 9_290);
    assert.equal(calculatePricePerSqft(10_000_000, 0, 'sqft'), null);
    assert.equal(calculatePricePerSqft(10_000_000, 1_000, null), null);
});

test('redacts Indian phone numbers and email addresses', () => {
    const redacted = redactSensitiveText('Call +91 9876543210 or email owner@example.com');

    assert.equal(redacted.includes('9876543210'), false);
    assert.equal(redacted.includes('owner@example.com'), false);
    assert.match(redacted, /\[redacted phone\]/);
    assert.match(redacted, /\[redacted email\]/);
});

test('request signal aborts stalled requests at the configured timeout', async () => {
    const signal = createRequestSignal(5);
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    assert.equal(signal.aborted, true);
});

test('classifies transient HTTP statuses without retrying permanent client failures', () => {
    for (const status of [403, 407, 408, 429, 500, 502, 503, 504, 599]) {
        assert.equal(isRetryableHttpStatus(status), true, `${status} should be retryable`);
    }
    for (const status of [400, 401, 404, 410, 422]) {
        assert.equal(isRetryableHttpStatus(status), false, `${status} should be permanent`);
    }
});

test('rejects and cancels a response whose declared length exceeds the limit', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
        cancel() {
            cancelled = true;
        },
    });
    const response = new Response(body, { headers: { 'content-length': '11' } });

    await assert.rejects(readBoundedResponseText(response, 10), /exceeds 10 byte limit/);
    assert.equal(cancelled, true);
});

test('rejects a chunked response as soon as streamed bytes exceed the limit', async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encoder.encode('12345'));
            controller.enqueue(encoder.encode('67890'));
        },
        cancel() {
            cancelled = true;
        },
    });
    const response = new Response(body);

    await assert.rejects(readBoundedResponseText(response, 8), /exceeds 8 byte limit/);
    assert.equal(cancelled, true);
});

test('reads a response that stays within the byte limit', async () => {
    const response = new Response('property listings');
    assert.equal(await readBoundedResponseText(response, 100), 'property listings');
});

test('delays only when another result and another job may still require a request', () => {
    assert.equal(shouldDelayBeforeNextJob(9, 10, false, null, true), true);
    assert.equal(shouldDelayBeforeNextJob(10, 10, false, null, true), false);
    assert.equal(shouldDelayBeforeNextJob(9, 10, true, null, true), false);
    assert.equal(shouldDelayBeforeNextJob(9, 10, false, new Error('billing failed'), true), false);
    assert.equal(shouldDelayBeforeNextJob(9, 10, false, null, false), false);
});

test('treats a processed empty search as successful but fails a total source outage', () => {
    assert.equal(shouldFailEmptyRun(1), false);
    assert.equal(shouldFailEmptyRun(3), false);
    assert.equal(shouldFailEmptyRun(0), true);
});
