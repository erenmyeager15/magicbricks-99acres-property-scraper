import assert from 'node:assert/strict';
import test from 'node:test';
import { readInitial99State } from './99acres-initial-state.js';
import { complete99Prefix, fetchHtml, parse99Acres, readBoundedResponseText, scrapeProperties, type PropertyScrapeRuntime } from './routes.js';
import { normalizeInput } from './input.js';
import type { ScrapeJob, PropertyRecord } from './types.js';
import { Response, type fetch } from 'undici';

const url = (id: number) => `https://www.99acres.com/flat-in-mumbai-spid-${id}`;
const job: ScrapeJob = { source: '99acres', transactionType: 'rent', city: 'Mumbai', citySlug: 'mumbai', page: 1,
    searchKey: '99acres:rent:mumbai', isCustomUrl: false, url: 'https://www.99acres.com/property-for-rent-in-mumbai-ffid' };
const input = normalizeInput({ source: '99acres', transactionType: 'rent', maxResults: 1 });
const own = (id = 1, price = 25_000) => ({ SPID: String(id), PD_URL: new URL(url(id)).pathname,
    PREFERENCE: 'R', MIN_PRICE: price, PRICE_IN_WORDS: `INR ${price}/month`, CARPET_AREA: 1000, CARPETAREA_UNIT: 'sqft',
    BATHROOM_NUM: 2, FLOOR_NUMBER: 3, FURNISH_LABEL: 'Furnished', POSTED_BY: 'Owner', IS_VERIFIED: true,
    image: `https://imagecdn.99acres.com/fixture-${id}.jpg` });
const ld = () => `<script type="application/ld+json">${JSON.stringify([1, 2].map(id => ({ '@type': 'Apartment',
    url: url(id), name: `2 BHK Flat ${id} in Mumbai`, offers: { price: id === 1 ? 25_000 : 85_000, priceCurrency: 'INR' },
    floorSize: { value: 1000, unitText: 'sqft' }, description: 'Carpet Area 1000 sqft. Gymnasium.' })))}</script>`;
const open = '<script>window.__initialData__ = {"search":{"properties":[';
const first = () => ld() + open + JSON.stringify(own());
const full = () => first() + ',' + JSON.stringify(own(2, 85_000)) + '],"unused":"' + 'x'.repeat(100_000) + '"}};</script>';
const prefix = (html: string, selected = input, seen = new Set<string>()) => complete99Prefix(html, job, selected, 1, seen, readInitial99State(html));
const comparable = (row: PropertyRecord) => ({ ...row, scrapedAt: null });

test('observed window initial-data frame yields a complete own property before the root/script closes', () => {
    const state = readInitial99State(first());
    assert.ok(state); assert.equal(state.kind, 'initial-data'); assert.equal(state.complete, false);
    assert.equal(state.byPath.size, 1); assert.equal(state.end, first().length);
    assert.ok(prefix(first()));
});
test('complete native frame and early property prefix have identical own output fields', () => {
    const a = parse99Acres(first(), job, readInitial99State(first()))[0];
    const b = parse99Acres(full(), job, readInitial99State(full()))[0];
    assert.deepEqual(comparable(a), comparable(b));
    assert.equal(a.price, 25_000); assert.equal(a.bathrooms, 2); assert.equal(a.floor, '3');
    assert.deepEqual(a.imageUrls, ['https://imagecdn.99acres.com/fixture-1.jpg']);
    assert.equal(readInitial99State(full())?.complete, true);
});
test('partial property objects cannot provide fields or trigger cancellation', () => {
    assert.equal(readInitial99State(first().slice(0, -1)), null);
    assert.equal(prefix(first().slice(0, -1)), null);
});
test('native string braces, escaped quotes and nested objects cannot close a record prematurely', () => {
    const record = { ...own(), label: 'quote " } { ] ₹', nested: { photo: 'https://imagecdn.99acres.com/a.jpg', okay: true, absent: null } };
    const text = ld() + open + JSON.stringify(record);
    assert.ok(prefix(text)); assert.equal(readInitial99State(text)?.byPath.size, 1);
    assert.equal(readInitial99State(text.slice(0, -2)), null);
});
test('dealer/profile metadata cannot supply a property price, facing, posting date or photo', () => {
    const record: Record<string, unknown> = own();
    delete record.PRICE_IN_WORDS; delete record.image;
    record.profile = { MIN_PRICE: 90_000_000, PRICE_IN_WORDS: 'INR 9 Crore', FACING: 'West', POSTING_DATE: 'wrong',
        photo: 'https://imagecdn.99acres.com/dealer.jpg', CONTACT_NAME: 'private-name', CONTACT_PHONE: 'private-phone' };
    const text = ld() + open + JSON.stringify(record), state = readInitial99State(text);
    const row = parse99Acres(text, job, state)[0];
    assert.equal(row.price, 25_000); assert.equal(row.facing, null); assert.equal(row.postedAt, null);
    assert.deepEqual(row.imageUrls, []);
    assert.doesNotMatch(JSON.stringify([...state!.byPath.values()]), /private-name|private-phone|dealer.jpg/);
    assert.ok(prefix(text));
});
test('string-valued observed field shape without PRICE_IN_WORDS preserves price and flags an unknown rent period', () => {
    const record = { PD_URL: '/local-fixture-spid-R911000001', SPID: '911000001', PREFERENCE: 'R', MIN_PRICE: '25000',
        CARPET_AREA: '1000', CARPETAREA_UNIT: 'sq.ft.', BEDROOM_NUM: '2', BATHROOM_NUM: '2', FLOOR_NUM: '2' };
    const text = ld().replaceAll(new URL(url(1)).pathname, record.PD_URL) + open + JSON.stringify(record);
    const row = parse99Acres(text, job, readInitial99State(text))[0];
    assert.ok(prefix(text)); assert.equal(row.price, 25_000); assert.equal(row.area, 1000); assert.equal(row.areaUnit, 'sq.ft.');
    assert.equal(row.priceDisplay, 'INR 25000'); assert.equal(row.floor, '2');
});
test('own property photo and explicit MAP_DETAILS stay available without profile contamination', () => {
    const record = { ...own(), MAP_DETAILS: { LATITUDE: 19.12, LONGITUDE: 72.85 },
        PROPERTY_IMAGES: ['https://imagecdn.99acres.com/property.jpg'],
        profile: { LATITUDE: 0.5, LONGITUDE: 0.5, photo: 'https://imagecdn.99acres.com/dealer.jpg' } };
    const text = ld() + open + JSON.stringify(record), row = parse99Acres(text, job, readInitial99State(text))[0];
    assert.equal(row.latitude, 19.12); assert.equal(row.longitude, 72.85);
    assert.ok(row.imageUrls.includes('https://imagecdn.99acres.com/property.jpg'));
    assert.ok(!row.imageUrls.includes('https://imagecdn.99acres.com/dealer.jpg'));
});
for (const wrap of ['comment', 'style', 'string', 'attribute', 'quoted script attribute', 'textarea', 'title', 'xmp', 'external', 'wrong type', 'wrong global', 'expression', 'bare keys']) {
    test(`uncertain native frame (${wrap}) keeps full-response transport`, () => {
        const body = open + JSON.stringify(own()) + ']}};</script>';
        const html = wrap === 'comment' ? `<!--${body}-->` : wrap === 'style' ? `<style>${body}</style>`
            : wrap === 'string' ? `<script>const other = ${JSON.stringify(body).replace(/<\/script>/g, '<\\/script>')};</script>`
            : wrap === 'attribute' ? `<div data-initial="window.__initialData__">${JSON.stringify(own())}</div>`
            : wrap === 'quoted script attribute' ? `<div data-example='${body}'>No state</div>`
            : ['textarea', 'title', 'xmp'].includes(wrap) ? `<${wrap}>${body}</${wrap}>`
            : wrap === 'external' ? body.replace('<script>', '<script src="other.js">')
            : wrap === 'wrong type' ? body.replace('<script>', '<script type="application/ld+json">')
            : wrap === 'wrong global' ? body.replace('__initialData__', '__unknownState__')
            : wrap === 'expression' ? body.replace('= {', '= JSON.parse({') : body.replace('"search"', 'search');
        assert.equal(readInitial99State(ld() + html), null);
    });
}
for (const variant of ['foreign URL', 'credentials', 'port', 'project', 'missing price', 'invalid price']) {
    test(`native own-record guard: ${variant}`, () => {
        const record: Record<string, unknown> = own();
        if (variant === 'foreign URL') record.PD_URL = 'https://unrelated.example/flat-spid-1';
        if (variant === 'credentials') record.PD_URL = 'https://private:secret@www.99acres.com/flat-spid-1';
        if (variant === 'port') record.PD_URL = 'https://www.99acres.com:8443/flat-spid-1';
        if (variant === 'project') record.PD_URL = '/project-npxid-1';
        if (variant === 'missing price') delete record.MIN_PRICE;
        if (variant === 'invalid price') record.MIN_PRICE = 'not a price';
        assert.equal(readInitial99State(ld() + open + JSON.stringify(record)), null);
    });
}
test('published alphanumeric path is authoritative, not an internal SPID identifier', () => {
    const path = '/flat-in-mumbai-spid-R911000001';
    const text = ld().replaceAll(new URL(url(1)).pathname, path) + open + JSON.stringify({ ...own(), SPID: '911000001', PD_URL: path });
    const state = readInitial99State(text);
    assert.ok(state); assert.ok(prefix(text));
    const row = parse99Acres(text, job, state)[0];
    assert.equal(row.propertyId, 'R911000001'); assert.equal(row.price, 25_000);
    // A different published path never substitutes for an earlier eligible row.
    assert.equal(prefix(ld() + open + JSON.stringify({ ...own(), PD_URL: path })), null);
});
test('a duplicate own key, invalid JSON before the record or excessive nesting never qualifies', () => {
    assert.equal(readInitial99State(ld() + open + JSON.stringify(own()).replace('"MIN_PRICE":25000', '"MIN_PRICE":1,"MIN_PRICE":25000')), null);
    assert.equal(readInitial99State(ld() + open.replace('"properties":', '"bad":undefined,"properties":') + JSON.stringify(own())), null);
    assert.equal(readInitial99State(ld() + '<script>window.__initialData__ = ' + '{"a":'.repeat(65) + JSON.stringify(own())), null);
});
test('wrong preference or an inconsistent own price display does not stop the reader', () => {
    for (const changes of [{ PREFERENCE: 'S' }, { PREFERENCE: 'unknown' }, { PRICE_IN_WORDS: 'INR 90000/month' }]) {
        assert.equal(prefix(ld() + open + JSON.stringify({ ...own(), ...changes })), null);
    }
});
test('seen and price-filtered properties require the next complete own record', () => {
    assert.equal(prefix(first(), input, new Set(['99acres:1'])), null);
    assert.ok(prefix(full(), input, new Set(['99acres:1'])));
    const filter = normalizeInput({ source: '99acres', transactionType: 'rent', maxResults: 1, minPrice: 50_000 });
    assert.equal(prefix(first(), filter), null); assert.ok(prefix(full(), filter));
});
test('native reader cancels before the queued large state tail', async () => {
    let reads = 0, stops = 0;
    const chunks = [first(), full().slice(first().length)];
    const text = await readBoundedResponseText({ headers: { get: () => null }, body: { cancel: async () => {}, getReader: () => ({
        read: async () => ({ done: reads >= chunks.length, value: reads < chunks.length ? new TextEncoder().encode(chunks[reads++]) : undefined }),
        cancel: async () => {}, releaseLock: () => {},
    }) } }, 1_000_000, { completePrefix: text => prefix(text), onEarlyStop: () => { stops += 1; } });
    assert.equal(reads, 1); assert.equal(stops, 1); assert.equal(text, first());
});
test('actual collector uses native prefix only for one needed row, with no change to batch transport', async () => {
    for (const limit of [1, 2]) {
        const rows: PropertyRecord[] = [], values = new Map<string, unknown>();
        const runtime: PropertyScrapeRuntime = {
            createProxy: async () => ({ newUrl: async () => 'http://127.0.0.1:9999' }), remainingChargeCount: () => Infinity,
            fetchPage: async (_url, _proxy, options) => {
                options.onRequestAttempt?.();
                const html = await readBoundedResponseText(new Response(full()), 1_000_000, options);
                options.validate?.(html); return html;
            },
            pushRecord: async row => { rows.push(row); return { eventChargeLimitReached: false, chargedCount: 1 }; },
            setValue: async (key, value) => { values.set(key, value); }, setStatus: async () => {},
            saveMonitor: async () => { throw new Error('No monitor requested'); }, wait: async () => {},
        };
        await scrapeProperties({ source: '99acres', transactionType: 'rent', maxResults: limit }, runtime);
        assert.equal(rows.length, limit);
        const summary = values.get('RUN_SUMMARY') as Record<string, unknown>;
        assert.equal(summary.earlyStoppedPages, limit === 1 ? 1 : 0);
        assert.equal(summary.primary99StatePages, limit === 1 ? 1 : 0);
        assert.equal(summary.failedPages, 0);
    }
});
test('a retry cannot reuse a prior response property snapshot or its old price', async () => {
    const rows: PropertyRecord[] = [], values = new Map<string, unknown>();
    let requests = 0;
    const runtime: PropertyScrapeRuntime = {
        createProxy: async () => ({ newUrl: async () => 'http://127.0.0.1:9999' }), remainingChargeCount: () => Infinity,
        fetchPage: (url, proxy, options) => fetchHtml(url, proxy, options, {
            fetch: (async () => new Response(++requests === 1
                ? open + JSON.stringify(own()) + ']}};</script>Unrecognized temporary response'
                : ld().replace('"price":25000', '"price":75000') + open + JSON.stringify(own(1, 75_000)))) as typeof fetch,
            delay: async () => {},
        }),
        pushRecord: async row => { rows.push(row); return { eventChargeLimitReached: false, chargedCount: 1 }; },
        setValue: async (key, value) => { values.set(key, value); }, setStatus: async () => {},
        saveMonitor: async () => { throw new Error('No monitor requested'); }, wait: async () => {},
    };
    await scrapeProperties({ source: '99acres', transactionType: 'rent', maxResults: 1 }, runtime);
    assert.equal(requests, 2); assert.equal(rows.length, 1); assert.equal(rows[0].price, 75_000);
    assert.equal((values.get('RUN_SUMMARY') as Record<string, unknown>).requestAttempts, 2);
});
for (const nativeFirst of [true, false]) for (const split of [true, false]) {
    test(`mixed primary frames are chunk-independent: nativeFirst=${nativeFirst}, split=${split}`, async () => {
        const next = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: {
            listings: [own(1, 90_000)],
        } }, page: '/search' })}</script>`;
        const native = open + JSON.stringify(own()) + ']}};</script>';
        const frames = nativeFirst ? [native, next] : [next, native];
        const chunks = split ? [ld() + frames[0], frames[1]] : [ld() + frames.join('')];
        const rows: PropertyRecord[] = [];
        const runtime: PropertyScrapeRuntime = {
            createProxy: async () => undefined, remainingChargeCount: () => Infinity,
            fetchPage: (url, proxy, options) => fetchHtml(url, proxy, options, {
                fetch: (async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
                    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close();
                } }))) as typeof fetch, delay: async () => {},
            }),
            pushRecord: async row => { rows.push(row); return { eventChargeLimitReached: false, chargedCount: 1 }; },
            setValue: async () => {}, setStatus: async () => {}, saveMonitor: async () => {}, wait: async () => {},
        };
        await scrapeProperties({ source: '99acres', transactionType: 'rent', maxResults: 1,
            proxyConfiguration: { useApifyProxy: false } }, runtime);
        assert.equal(rows.length, 1); assert.equal(rows[0].price, nativeFirst ? 25_000 : 90_000);
    });
}
