import assert from 'node:assert/strict';
import test from 'node:test';
import { readCanonical99State } from './99acres-state.js';
import { readInitial99State } from './99acres-initial-state.js';
import { complete99Prefix, fetchHtml, parse99Acres, readBoundedResponseText } from './routes.js';
import { normalizeInput } from './input.js';
import { propertyKey, squareFeet } from './property-intelligence.js';
import type { ScrapeJob } from './types.js';
import { Response, type fetch } from 'undici';
import { createServer } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

const url = (id: number) => `https://www.99acres.com/2-bhk-flat-in-andheri-mumbai-spid-${id}`;
const job: ScrapeJob = { source: '99acres', transactionType: 'rent', city: 'Mumbai', citySlug: 'mumbai', page: 1,
    url: 'https://www.99acres.com/property-for-rent-in-mumbai-ffid', searchKey: '99acres:rent:mumbai', isCustomUrl: false };
const input = normalizeInput({ source: '99acres', transactionType: 'rent', maxResults: 1 });
function offer(id: number, price = 25_000) {
    return { '@type': 'Apartment', name: `2 BHK Flat ${id} in Andheri, Mumbai`, url: url(id),
        offers: { price, priceCurrency: 'INR' }, floorSize: { value: 1000, unitText: 'sqft' },
        description: 'Carpet Area 1000 sqft. Furnished. Posted by Owner. Lift. Gymnasium.',
        address: { name: 'Project One', streetAddress: 'Andheri', addressLocality: 'Mumbai', addressCountry: 'IN' } };
}
function state(id: number, price = 25_000): Record<string, unknown> {
    return { PD_URL: new URL(url(id)).pathname, MIN_PRICE: price, PRICE_IN_WORDS: `INR ${price}/month`,
        CARPET_AREA: 1000, CARPETAREA_UNIT: 'sqft', LOCALIZED_AREA_TYPE: 'Carpet Area', BEDROOM_NUM: 2,
        BATHROOM_NUM: 2, FURNISH_LABEL: 'Furnished', FLOOR_NUMBER: 3, PROP_TYPE_LABEL: 'Apartment',
        POSTED_BY: 'Owner', IS_VERIFIED: true, IS_FEATURED: false, POSTING_DATE: 'today', AGE_LABEL: '5 years old',
        FACING_LABEL: 'East', OWNERSHIP: 'Freehold', PARKING: 'Covered parking', RERA_ID: 'ABC1234',
        MAINTENANCE: 'INR 1000/month', LATITUDE: 19.12, LONGITUDE: 72.85,
        image: `https://imagecdn.99acres.com/property${id}.jpg` };
}
const ld = (offers = [offer(1), offer(2, 85_000)]) => `<script type="application/ld+json">${JSON.stringify(offers)}</script>`;
const primary = (states: Record<string, unknown>[] = [state(1), state(2, 85_000)]) =>
    `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { listings: states } }, page: '/search' })}</script>`;
const ready = () => ld() + primary() + '<div>' + 'x'.repeat(14_000) + '</div>';
const comparable = (row: ReturnType<typeof parse99Acres>[number]) => ({ ...row, scrapedAt: null });

test('complete primary snapshot isolates each listing and supports numeric state fields', () => {
    const rows = parse99Acres(ready(), job);
    assert.equal(rows[0].price, 25_000);
    assert.equal(rows[1].price, 85_000);
    assert.equal(rows[0].bathrooms, 2);
    assert.equal(rows[0].floor, '3');
    assert.equal(rows[0].latitude, 19.12);
    assert.equal(rows[0].longitude, 72.85);
    assert.equal(rows[0].verified, true);
    assert.equal(rows[0].featured, false);
    assert.equal(rows[0].listedBy, 'Owner');
    assert.equal(rows[0].area, 1000);
    assert.equal(rows[0].areaType, 'Carpet Area');
    assert.deepEqual(rows[0].imageUrls, ['https://imagecdn.99acres.com/property1.jpg']);
});

test('closed primary snapshot outranks unrelated later PD_URL state and does not borrow neighbour fields', () => {
    const first = state(1); delete first.BATHROOM_NUM; delete first.image;
    const second = state(2, 9_000_000); second.BATHROOM_NUM = 8;
    const prefix = ld() + primary([first, second]) + 'x'.repeat(14_000);
    const tail = `<script>const unrelated = ${JSON.stringify(state(1, 90_000_000))};</script>`;
    const rows = parse99Acres(prefix + tail, job);
    assert.equal(rows[0].price, 25_000);
    assert.equal(rows[0].bathrooms, null);
    assert.equal(rows[0].imageUrls.length, 0);
    assert.deepEqual(comparable(rows[0]), comparable(parse99Acres(prefix, job)[0]));
});

test('first-property early stop preserves every full-response field with a large unrelated tail', () => {
    const prefix = ready();
    const full = prefix + '<footer>' + 'unrelated bundle '.repeat(60_000) + '</footer>';
    assert.ok(complete99Prefix(prefix, job, input, 1, new Set()));
    assert.deepEqual(comparable(parse99Acres(prefix, job)[0]), comparable(parse99Acres(full, job)[0]));
});

for (const label of ['no primary', 'partial JSON', 'open script', 'unknown frame', 'duplicate identity', 'foreign URL', 'credential URL', 'wrong type']) {
    test(`${label}: no early stop; keep full-response fallback`, () => {
        const data = label === 'no primary' ? '' : label === 'partial JSON'
            ? '<script id="__NEXT_DATA__" type="application/json">{"props":</script>'
            : label === 'open script' ? primary().replace('</script>', '')
            : label === 'unknown frame' ? '<script id="__NEXT_DATA__" type="application/json">{"listings":[]}</script>'
            : label === 'duplicate identity' ? primary([state(1), state(1)])
            : label === 'foreign URL' ? primary([{ ...state(1), PD_URL: 'https://unrelated.example/spid-1' }])
            : label === 'credential URL' ? primary([{ ...state(1), PD_URL: 'https://private:secret@www.99acres.com/spid-1' }])
            : primary().replace('application/json', 'text/javascript');
        const html = ld() + data + 'x'.repeat(14_000);
        assert.equal(readCanonical99State(html), null);
        assert.equal(complete99Prefix(html, job, input, 1, new Set()), null);
    });
}

test('raw comments, scripts, styles and attribute-like strings cannot masquerade as primary state', () => {
    for (const hidden of [`<!--${primary()}-->`, `<style>${primary()}</style>`,
        `<script>const text = ${JSON.stringify(primary()).replace(/<\/script>/g, '<\\/script>')};</script>`,
        primary().replace('id="__NEXT_DATA__"', 'data-id="__NEXT_DATA__"'),
        primary().replace('id="__NEXT_DATA__"', 'id="__NEXT_DATA__" id="another"')]) {
        assert.equal(readCanonical99State(hidden), null);
    }
});

test('quoted/unquoted primary attributes and escaped primary strings are recognized without changing row text', () => {
    const own = state(1); own.PROP_NAME = 'Project "A" {B} ₹';
    const html = ld([offer(1)]) + primary([own]).replace('id="__NEXT_DATA__"', "id='__NEXT_DATA__'")
        .replace('type="application/json"', 'type=application/json') + 'x'.repeat(14_000);
    assert.ok(readCanonical99State(html));
    assert.equal(parse99Acres(html, job)[0].projectName, 'Project One');
    assert.ok(complete99Prefix(html, job, input, 1, new Set()));
});

test('primary snapshot late in response must finish before any prefix is accepted', () => {
    const before = ld() + '<main>' + 'x'.repeat(14_000) + '</main>';
    assert.equal(complete99Prefix(before, job, input, 1, new Set()), null);
    assert.ok(complete99Prefix(before + primary(), job, input, 1, new Set()));
});

test('complete own snapshot and JSON-LD do not require downloading unrelated DOM lookahead', () => {
    const prefix = ld() + primary();
    assert.ok(complete99Prefix(prefix, job, input, 1, new Set()));
    assert.deepEqual(comparable(parse99Acres(prefix, job)[0]), comparable(parse99Acres(prefix + 'x'.repeat(14_000), job)[0]));
});

test('seen or price-excluded first rows are respected, rather than charged again', () => {
    const html = ready(), rows = parse99Acres(html, job);
    assert.ok(complete99Prefix(html, job, input, 1, new Set([propertyKey(rows[0])])));
    assert.equal(complete99Prefix(html, job, input, 1, new Set(rows.map(propertyKey))), null);
    const excluded = normalizeInput({ source: '99acres', minPrice: 90_000, maxResults: 1 });
    assert.equal(complete99Prefix(html, job, excluded, 1, new Set()), null);
    const matching = normalizeInput({ source: '99acres', minPrice: 50_000, maxResults: 1 });
    assert.ok(complete99Prefix(html, job, matching, 1, new Set()));
});

test('missing first own record or missing price/normalized area keeps the normal reader', () => {
    assert.equal(complete99Prefix(ld() + primary([state(2)]) + 'x'.repeat(14_000), job, input, 1, new Set()), null);
    const noArea = state(1); delete noArea.CARPET_AREA;
    const noAreaOffer = offer(1); noAreaOffer.floorSize.unitText = 'unsupported'; noAreaOffer.description = 'Unknown dimensions';
    assert.equal(complete99Prefix(ld([noAreaOffer]) + primary([noArea]) + 'x'.repeat(14_000), job, input, 1, new Set()), null);
    const badPrice = state(1, -1);
    assert.equal(complete99Prefix(ld() + primary([badPrice]) + 'x'.repeat(14_000), job, input, 1, new Set()), null);
});

test('batch, zero-capacity and wrong-portal paths are not enabled by the one-row prefix helper', () => {
    for (const required of [0, 2, 5, 25, 50, 500]) assert.equal(complete99Prefix(ready(), job, input, required, new Set()), null);
    assert.equal(complete99Prefix(ready(), { ...job, source: 'magicbricks' }, input, 1, new Set()), null);
});

for (const [unit, normalized] of [['sq.m.', 10_763.9], ['sq.yd.', 9000], ['square feet', 1000], ['unsupported', null]] as const) {
    test(`own state area unit ${unit} is preserved and normalized without a square-foot guess`, () => {
        const own = state(1); own.CARPETAREA_UNIT = unit;
        const html = ld([offer(1)]) + primary([own]);
        const row = parse99Acres(html, job)[0];
        assert.equal(row.areaUnit, unit);
        assert.equal(complete99Prefix(html, job, input, 1, new Set()) !== null, normalized !== null);
        // The collector attaches normalized intelligence to this preserved source unit.
        assert.equal(squareFeet(row.area, row.areaUnit), normalized);
    });
}

test('conflicting own price display or foreign structured URL prevents early cancellation', () => {
    const own = state(1); own.PRICE_IN_WORDS = 'INR 85000/month';
    assert.equal(complete99Prefix(ld([offer(1)]) + primary([own]), job, input, 1, new Set()), null);
    const foreign = { ...offer(1), url: url(1).replace('www.99acres.com', 'unrelated.example') };
    assert.equal(complete99Prefix(ld([foreign]) + primary([state(1)]), job, input, 1, new Set()), null);
});

test('ID-prefix matches and project IDs cannot borrow another property primary record', () => {
    const near = state(10); near.PD_URL = '/different-title-spid-10';
    const project = state(1, 90_000_000); project.PD_URL = '/project-npxid-1';
    const html = ld([offer(1)]) + primary([near, project]);
    const row = parse99Acres(html, job)[0];
    assert.equal(row.price, 25_000);
    assert.equal(row.priceDisplay, 'INR 25000');
    assert.equal(complete99Prefix(html, job, input, 1, new Set()), null);
});

test('bounded reader captures required fields then cancels without reading the queued tail', async () => {
    const chunks = [ld(), primary(), 'x'.repeat(14_000), 'x'.repeat(1_000_000)];
    let reads = 0, bytes = 0, cancelled = false, released = false, stops = 0;
    const encoder = new TextEncoder();
    const response = { headers: { get: () => null }, body: { cancel: async () => {}, getReader: () => ({
        read: async () => ({ done: reads >= chunks.length, value: reads < chunks.length ? encoder.encode(chunks[reads++]) : undefined }),
        cancel: async () => { cancelled = true; }, releaseLock: () => { released = true; },
    }) } };
    const prefix = await readBoundedResponseText(response, 2_000_000, {
        completePrefix: html => complete99Prefix(html, job, input, 1, new Set()),
        onChunk: count => { bytes += count; }, onEarlyStop: () => { stops += 1; },
    });
    assert.equal(reads, 2); assert.equal(stops, 1); assert.equal(cancelled, true); assert.equal(released, true);
    assert.equal(bytes, encoder.encode(chunks.slice(0, 2).join('')).byteLength);
    assert.deepEqual(comparable(parse99Acres(prefix, job)[0]), comparable(parse99Acres(chunks.join(''), job)[0]));
});

test('split UTF-8 primary state is decoded completely before early cancellation', async () => {
    const content = ready().replace('Furnished.', 'Furnished ₹.');
    const bytes = new TextEncoder().encode(content), split = bytes.indexOf(0xE2);
    let stopped = false;
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(bytes.slice(0, split + 1)); controller.enqueue(bytes.slice(split + 1));
        controller.enqueue(new TextEncoder().encode('x'.repeat(100_000))); controller.close();
    } });
    const prefix = await readBoundedResponseText(new Response(stream), 1_000_000, {
        completePrefix: html => complete99Prefix(html, job, input, 1, new Set()), onEarlyStop: () => { stopped = true; },
    });
    assert.equal(stopped, true); assert.match(prefix, /Furnished ₹/);
    assert.deepEqual(comparable(parse99Acres(prefix, job)[0]), comparable(parse99Acres(content, job)[0]));
});

test('truncated proxy response uses immediate dispatcher destruction rather than draining the tunnel', async () => {
    let destroyed = 0, closed = 0, requested = 0;
    const result = await fetchHtml(job.url, { newUrl: async () => 'http://127.0.0.1:9999' }, {
        completePrefix: html => complete99Prefix(html, job, input, 1, new Set()), validate: html => parse99Acres(html, job).length ? 'listings' : 'unrecognized',
    }, {
        fetch: (async (_url, options) => {
            requested += 1;
            const dispatcher = options?.dispatcher;
            assert.ok(dispatcher);
            const originalDestroy = dispatcher.destroy.bind(dispatcher);
            dispatcher.destroy = (async () => {
                destroyed += 1;
                await new Promise<void>(resolve => originalDestroy(null, resolve));
            }) as typeof dispatcher.destroy;
            dispatcher.close = (async () => { closed += 1; }) as typeof dispatcher.close;
            return new Response(ready() + 'x'.repeat(50_000));
        }) as typeof fetch,
        delay: async () => { throw new Error('Successful prefix must not retry'); },
    });
    assert.equal(requested, 1); assert.equal(destroyed, 1); assert.equal(closed, 0);
    assert.ok(parse99Acres(result, job).length > 0);
});

for (const format of ['next', 'initial-data'] as const) for (const optimize of [true, false]) {
    test(`local CONNECT tunnel ${format}: ${optimize ? 'cancels after own snapshot' : 'reads full uncertain response'}`, { timeout: 10_000 }, async context => {
        // Local loopback only: real Undici streaming/ProxyAgent cleanup, not a paid proxy or portal request.
        const sockets = new Set<Duplex>();
        let tailSent = false, wireBytes = 0, closed = false;
        let signalOriginClosed = () => {};
        const originClosed = new Promise<void>(resolve => { signalOriginClosed = resolve; });
        const ownState = (text: string) => format === 'initial-data' ? readInitial99State(text) : readCanonical99State(text);
        const snapshot = format === 'initial-data' ? `<script>window.__initialData__ = ${JSON.stringify({
            search: { properties: [{ ...state(1), PREFERENCE: 'R' }] },
        })};</script>` : primary([state(1)]);
        const head = ld([offer(1)]) + (optimize ? snapshot : '');
        const tail = '<footer>' + 'unused '.repeat(100_000) + '</footer>';
        const origin = createServer((_request, response) => {
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            response.write(head);
            const timer = setTimeout(() => { tailSent = true; response.end(tail); }, 200);
            response.on('close', () => { closed = true; clearTimeout(timer); signalOriginClosed(); });
        });
        await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
        const originPort = (origin.address() as AddressInfo).port;
        const proxy = createServer();
        proxy.on('connect', (_request, client, buffered) => {
            sockets.add(client); client.on('error', () => {}); client.on('close', () => sockets.delete(client));
            const upstream = connect(originPort, '127.0.0.1', () => {
                client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (buffered.length) upstream.write(buffered);
                client.pipe(upstream).pipe(client);
            });
            sockets.add(upstream); upstream.on('error', () => {}); upstream.on('close', () => sockets.delete(upstream));
            upstream.on('data', chunk => { wireBytes += chunk.length; });
            client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy());
        });
        await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
        context.after(async () => {
            for (const socket of sockets) socket.destroy();
            origin.closeAllConnections(); proxy.closeAllConnections();
            await Promise.all([new Promise<void>(resolve => origin.close(() => resolve())), new Promise<void>(resolve => proxy.close(() => resolve()))]);
        });
        const proxyPort = (proxy.address() as AddressInfo).port;
        let stops = 0, attempts = 0;
        const html = await fetchHtml(`http://127.0.0.1:${originPort}/listings`, {
            newUrl: async () => `http://127.0.0.1:${proxyPort}`,
        }, { completePrefix: text => complete99Prefix(text, job, input, 1, new Set(), ownState(text)),
            validate: text => parse99Acres(text, job, ownState(text)).length ? 'listings' : 'unrecognized',
            onEarlyStop: () => { stops += 1; }, onRequestAttempt: () => { attempts += 1; } });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(attempts, 1); assert.equal(stops, optimize ? 1 : 0);
        assert.deepEqual(comparable(parse99Acres(html, job, ownState(html))[0]), comparable(parse99Acres(head + tail, job, ownState(head + tail))[0]));
        if (optimize) {
            // Destruction is awaited locally; the remote loopback server receives
            // the TCP close asynchronously. Wait for that event, not one tick.
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Origin tunnel did not close')), 1_000);
                void originClosed.then(() => { clearTimeout(timer); resolve(); });
            });
            assert.equal(tailSent, false); assert.ok(wireBytes < Buffer.byteLength(tail) / 10);
            assert.equal(closed, true);
        } else {
            assert.equal(tailSent, true); assert.ok(wireBytes > Buffer.byteLength(tail)); assert.ok(html.endsWith('</footer>'));
        }
    });
}
