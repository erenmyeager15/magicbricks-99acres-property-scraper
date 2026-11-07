import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCityInput, portalCityName } from './city-aliases.js';
import { buildJobs, unknownCityFailure } from './routes.js';
import { normalizeInput } from './input.js';

test('each portal gets the city spelling it accepts', () => {
    assert.equal(portalCityName('magicbricks', 'Delhi'), 'New Delhi');
    assert.equal(portalCityName('magicbricks', ' bengaluru '), 'Bangalore');
    assert.equal(portalCityName('magicbricks', 'Gurugram'), 'Gurgaon');
    assert.equal(portalCityName('magicbricks', 'Pune'), 'Pune');
    assert.equal(portalCityName('99acres', 'New Delhi'), 'Delhi');
    assert.equal(portalCityName('99acres', 'Bengaluru'), 'Bangalore');
    assert.equal(portalCityName('99acres', 'Delhi'), 'Delhi');
});

test('request URLs use portal names while jobs keep the user city', () => {
    const input = normalizeInput({ source: 'both', cities: ['Delhi', 'Bengaluru'], maxResults: 5 });
    const jobs = buildJobs(input, ['magicbricks', '99acres']).filter(job => job.page === 1);
    const url = (source: string, city: string) => jobs.find(job => job.source === source && job.city === city)!.url;
    assert.match(url('magicbricks', 'Delhi'), /cityName=New%20Delhi(?:&|$)/);
    assert.match(url('magicbricks', 'Bengaluru'), /cityName=Bangalore(?:&|$)/);
    assert.match(url('99acres', 'Delhi'), /\/property-in-delhi-ffid$/);
    assert.match(url('99acres', 'Bengaluru'), /\/property-in-bangalore-ffid$/);
    assert.ok(jobs.every(job => ['Delhi', 'Bengaluru'].includes(job.city)));
});

test('cleans state, pincode and "City"/"Urban" suffixes MagicBricks rejects with HTTP 500', () => {
    const mb = (raw: string) => parseCityInput('magicbricks', raw);
    assert.deepEqual(mb('Mumbai, Maharashtra'), { city: 'Mumbai', locality: null });
    assert.deepEqual(mb('Mumbai Maharashtra'), { city: 'Mumbai', locality: null });
    assert.deepEqual(mb('Mumbai, India'), { city: 'Mumbai', locality: null });
    assert.deepEqual(mb('Mumbai City'), { city: 'Mumbai', locality: null });
    assert.deepEqual(mb('Greater Mumbai'), { city: 'Mumbai', locality: null });
    assert.deepEqual(mb('Pune 411001'), { city: 'Pune', locality: null });
    assert.deepEqual(mb('Bangalore Urban'), { city: 'Bangalore', locality: null });
    assert.deepEqual(mb('Hyderabad, Telangana'), { city: 'Hyderabad', locality: null });
    assert.deepEqual(mb('Bhopal, MP'), { city: 'Bhopal', locality: null });
    assert.deepEqual(mb('Prayagraj'), { city: 'Allahabad', locality: null });
    assert.deepEqual(mb('Tiruchirappalli'), { city: 'Trichy', locality: null });
    assert.deepEqual(mb('Delhi NCR'), { city: 'New Delhi', locality: null });
    assert.deepEqual(mb('Goa'), { city: 'Goa', locality: null });
    assert.deepEqual(mb('Navi Mumbai'), { city: 'Navi Mumbai', locality: null });
    assert.deepEqual(mb('Andheri West, Mumbai'), { city: 'Mumbai', locality: 'Andheri West' });
    assert.deepEqual(mb('Whitefield, Bengaluru, Karnataka'), { city: 'Bangalore', locality: 'Whitefield' });
    assert.deepEqual(parseCityInput('99acres', 'Gurugram, Haryana'), { city: 'Gurgaon', locality: null });
});

test('locality input adds a Locality filter to the MagicBricks URL only', () => {
    const input = normalizeInput({ source: 'both', cities: ['Andheri West, Mumbai'], maxResults: 5 });
    const jobs = buildJobs(input, ['magicbricks', '99acres']).filter(job => job.page === 1);
    assert.match(jobs.find(j => j.source === 'magicbricks')!.url, /cityName=Mumbai&Locality=Andheri-West(?:&|$)/);
    assert.match(jobs.find(j => j.source === '99acres')!.url, /\/property-in-mumbai-ffid$/);
});

test('an all-unknown-city failure names the city instead of a generic HTTP 500', () => {
    const failure = unknownCityFailure([
        { category: 'SOURCE_HTTP', message: 'HTTP 500', httpStatus: 500, source: 'magicbricks', city: 'Mira Road' },
    ], 1);
    assert.ok(failure);
    assert.equal(failure.info.category, 'SOURCE_HTTP');
    assert.match(failure.message, /"Mira Road"/);
    assert.match(failure.message, /Locality, City/);
    assert.equal(unknownCityFailure([{ category: 'SOURCE_HTTP', message: 'HTTP 403', httpStatus: 403, source: 'magicbricks', city: 'Mumbai' }], 1), null);
    assert.equal(unknownCityFailure([{ category: 'SOURCE_HTTP', message: 'HTTP 500', httpStatus: 500, source: 'magicbricks' }], 1), null);
});
