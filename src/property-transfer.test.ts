import assert from 'node:assert/strict';
import test from 'node:test';
import { completeMagicCards, completeMagicPrefix, extractPriceDisplay, parseMagicBricks, readBoundedResponseText } from './routes.js';
import { normalizeInput } from './input.js';
import { propertyKey } from './property-intelligence.js';
import type { ScrapeJob } from './types.js';

const url = (id: number) => `https://www.magicbricks.com/propertyDetails/2-BHK-flat-for-Sale-in-Mumbai&id=${id}.htm`;
const title = (id: number) => `2 BHK Flat in Project ${id}, Andheri, Mumbai`;
const job: ScrapeJob = { source: 'magicbricks', transactionType: 'sale', city: 'Mumbai', citySlug: 'mumbai',
    page: 1, url: 'https://www.magicbricks.com/property-for-sale/residential-real-estate?cityName=Mumbai',
    searchKey: 'magicbricks-mumbai', isCustomUrl: false };
const input = normalizeInput({ maxResults: 1 });
const ld = (ids = [1, 2]) => `<script type="application/ld+json">${JSON.stringify({
    '@type': 'ItemList', itemListElement: ids.map(id => ({ '@type': 'ListItem', item: { name: title(id), url: url(id) } })),
})}</script>`;
function card(id: number, price = id === 1 ? '85 Lakh' : '1.5 Crore', area = '1000 sqft'): string {
    return `<div class="mb-srp__card card"><div class="mb-srp__card__container" data-hint="x > y"><a href="https://www.magicbricks.com/profile">Profile</a><a href="${url(id).replace('&', '&amp;')}">${title(id)}</a><div>INR ${price}</div><div>Carpet Area ${area}</div><div>Bathroom 2 Balcony 1</div><div>Furnished Ready to Move Posted by Owner East facing Freehold RERA ID: ABC1234 Maintenance: INR 1000/month Lift Gymnasium</div><img src="https://img.staticmb.com/photo${id}.jpg"></div></div>`;
}
function comparable(row: ReturnType<typeof parseMagicBricks>[number]) {
    return { ...row, scrapedAt: null };
}

test('identity matching pairs reordered JSON-LD with the correct card prices', () => {
    const rows = parseMagicBricks(ld([2, 1]) + card(1) + card(2), job);
    assert.equal(rows[0].propertyUrl, url(1));
    assert.equal(rows[0].title, title(1));
    assert.equal(rows[0].price, 8_500_000);
    assert.equal(rows[1].title, title(2));
    assert.equal(rows[1].price, 15_000_000);
});
test('no-link cards can match one exact published title, never a positional guess', () => {
    const noLinks = card(1).replace(/<a[^>]+href="[^"]+"[^>]*>/g, '<span>').replace(/<\/a>/g, '</span>');
    const rows = parseMagicBricks(ld([2, 1]) + noLinks, job);
    assert.equal(rows[0].title, title(1));
    assert.equal(rows[0].propertyUrl, url(1));
    assert.equal(rows[0].price, 8_500_000);
    assert.equal(completeMagicPrefix(ld([2, 1]) + noLinks, job, input, 1, new Set()), null);
});
test('ambiguous no-link titles never join price data to a listing by array position', () => {
    const noLinks = card(1).replace(/<a[^>]+href="[^"]+"[^>]*>/g, '<span>').replace(/<\/a>/g, '</span>')
        .replace('</div></div>', `<p>${title(2)}</p></div></div>`);
    const rows = parseMagicBricks(ld([2, 1]) + noLinks, job);
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.price === null));
});
test('a balanced first card retains all existing fields with a large unrelated tail', () => {
    const full = ld() + card(1) + card(2) + '<footer>Contact Agent INR 99 Crore 99999 sqft</footer>';
    const prefix = completeMagicPrefix(full, job, input, 1, new Set());
    assert.ok(prefix);
    assert.ok(prefix.length < full.length);
    const fullRow = parseMagicBricks(full, job)[0];
    assert.deepEqual(comparable(parseMagicBricks(prefix, job)[0]), comparable(fullRow));
    assert.equal(fullRow.area, 1000);
    assert.equal(fullRow.listedBy, 'Owner');
    assert.equal(fullRow.imageUrls.length, 1);
    assert.equal(fullRow.reraId, 'ABC1234');
});
test('footer content cannot contaminate the final property card', () => {
    const rows = parseMagicBricks(ld([1]) + card(1) + '<footer>Posted by Agent INR 99 Crore 20000 sqft</footer>', job);
    assert.equal(rows[0].price, 8_500_000);
    assert.equal(rows[0].listedBy, 'Owner');
    assert.doesNotMatch(rows[0].description ?? '', /99 Crore|20000/);
});
test('maintenance, deposits, EMI and booking fees cannot masquerade as listing prices', () => {
    assert.equal(extractPriceDisplay('INR 85 Lakh Carpet Area 1000 sqft Maintenance: INR 1000/month'), 'INR 85 Lakh');
    assert.equal(extractPriceDisplay('INR 6,250,000 Carpet Area 1000 sqft Deposit: INR 200000'), 'INR 6,250,000');
    assert.equal(extractPriceDisplay('INR 30000/month Security deposit: INR 200000 EMI: INR 5000/month'), 'INR 30000/month');
    assert.equal(extractPriceDisplay('Price on request Maintenance: INR 1000/month'), null);
    assert.equal(extractPriceDisplay('Deposit: 20000 per month'), null);
    assert.equal(extractPriceDisplay('Maintenance: INR 1 Lakh EMI: INR 4000/month'), null);
    assert.equal(extractPriceDisplay('Rs. 9000 per sqft INR 85 Lakh'), 'INR 85 Lakh');
});
test('does not stop when the ItemList is absent or arrives later', () => {
    assert.equal(completeMagicPrefix(card(1), job, input, 1, new Set()), null);
    assert.equal(completeMagicPrefix(card(1) + ld([1]), job, input, 1, new Set()), null);
});
test('never truncates a 99acres state-based response using MagicBricks rules', () => {
    assert.equal(completeMagicPrefix(ld() + card(1), { ...job, source: '99acres' }, input, 1, new Set()), null);
});
test('does not stop in the middle of a card or an open script/style/comment', () => {
    const half = card(1).slice(0, -6);
    assert.equal(completeMagicCards(half).length, 0);
    assert.equal(completeMagicPrefix(ld() + half, job, input, 1, new Set()), null);
    for (const raw of ['<script>', '<style>', '<!--']) {
        assert.equal(completeMagicCards(raw + card(1)).length, 0);
    }
});
test('ignores fake card tags in complete scripts, styles and comments', () => {
    const full = `<script>${JSON.stringify(card(1))}</script><style>/*${card(1)}*/</style><!--${card(1)}-->${card(2)}`;
    assert.equal(completeMagicCards(full).length, 1);
    assert.equal(parseMagicBricks(ld([2]) + full, job)[0].propertyUrl, url(2));
});
test('class-looking attribute values are not real card containers', () => {
    assert.equal(completeMagicCards('<div data-class="mb-srp__card">text</div>').length, 0);
    assert.equal(completeMagicCards(`<div data-label='class="mb-srp__card"'>text</div>`).length, 0);
    assert.equal(completeMagicCards('<div class=mb-srp__card>text</div>').length, 1);
});
test('price filters require enough matching, complete records before stopping', () => {
    const filtered = normalizeInput({ maxResults: 1, minPrice: 10_000_000 });
    assert.equal(completeMagicPrefix(ld() + card(1), job, filtered, 1, new Set()), null);
    const full = ld() + card(1) + card(2) + '<footer>tail</footer>';
    assert.equal(completeMagicPrefix(full, job, filtered, 1, new Set()), ld() + card(1) + card(2));
});
test('seen and repeated identities do not count toward requested new rows', () => {
    const seen = new Set([propertyKey(parseMagicBricks(ld() + card(1), job)[0])]);
    assert.equal(completeMagicPrefix(ld() + card(1), job, input, 1, seen), null);
    assert.equal(completeMagicPrefix(ld() + card(1) + card(1), job, input, 2, new Set()), null);
    assert.ok(completeMagicPrefix(ld() + card(1) + card(2), job, input, 1, seen));
});
test('unknown/missing area, price or card identity keeps the normal full-response path', () => {
    for (const content of [card(1, 'Price on request'), card(1, '85 Lakh', 'unknown'), card(3)]) {
        assert.equal(completeMagicPrefix(ld() + content, job, input, 1, new Set()), null);
    }
    assert.equal(completeMagicPrefix(ld() + card(1), job, input, 0, new Set()), null);
});
test('stream cancels after a verified complete prefix without reading the queued tail', async () => {
    const encoder = new TextEncoder();
    const chunks = [ld() + card(1), card(2) + 'x'.repeat(50_000)];
    let reads = 0;
    let cancelled = false;
    let released = false;
    let bytes = 0;
    let earlyStops = 0;
    const response = {
        headers: { get: () => null },
        body: { cancel: async () => {}, getReader: () => ({
            read: async () => ({ done: reads >= chunks.length, value: reads < chunks.length ? encoder.encode(chunks[reads++]) : undefined }),
            cancel: async () => { cancelled = true; }, releaseLock: () => { released = true; },
        }) },
    };
    const html = await readBoundedResponseText(response, 100_000, {
        completePrefix: text => completeMagicPrefix(text, job, input, 1, new Set()),
        onChunk: count => { bytes += count; }, onEarlyStop: () => { earlyStops += 1; },
    });
    assert.equal(html, chunks[0]);
    assert.equal(reads, 1);
    assert.equal(cancelled, true);
    assert.equal(released, true);
    assert.equal(bytes, encoder.encode(chunks[0]).byteLength);
    assert.equal(earlyStops, 1);
});
test('uncertain input reads the full response and retains split UTF-8 data', async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode('₹ listings without card identities');
    let stopped = false;
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(bytes.slice(0, 1)); controller.enqueue(bytes.slice(1)); controller.close();
    } });
    const full = await readBoundedResponseText(new Response(stream), 100_000, {
        completePrefix: text => completeMagicPrefix(text, job, input, 1, new Set()),
        onEarlyStop: () => { stopped = true; },
    });
    assert.equal(full, '₹ listings without card identities');
    assert.equal(stopped, false);
});
