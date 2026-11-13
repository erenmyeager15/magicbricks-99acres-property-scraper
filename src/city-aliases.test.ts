import test from 'node:test';
import assert from 'node:assert/strict';
import { isIndianStateName, parseCityInput, portalCityName, suggestMagicBricksCity } from './city-aliases.js';
import { buildJobs, correctedCityJobs, parseMagicBricks, unknownCityFailure } from './routes.js';
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

test('a bare locality typed as the city searches its city with a Locality filter', () => {
    const mb = (raw: string) => parseCityInput('magicbricks', raw);
    assert.deepEqual(mb('Mira Road'), { city: 'Mumbai', locality: 'Mira Road' });
    assert.deepEqual(mb('Mira Road East'), { city: 'Mumbai', locality: 'Mira Road East' });
    assert.deepEqual(mb('Andheri West'), { city: 'Mumbai', locality: 'Andheri West' });
    assert.deepEqual(mb('whitefield'), { city: 'Bangalore', locality: 'whitefield' });
    assert.deepEqual(mb('Kharghar, Maharashtra'), { city: 'Navi Mumbai', locality: 'Kharghar' });
    assert.deepEqual(mb('Dombivli'), { city: 'Kalyan', locality: 'Dombivli' });
    assert.deepEqual(mb('Dwarka'), { city: 'New Delhi', locality: 'Dwarka' });
    assert.deepEqual(mb('Thane'), { city: 'Thane', locality: null });
    assert.deepEqual(parseCityInput('99acres', 'Dombivli').city, 'Mumbai');
    assert.deepEqual(parseCityInput('99acres', 'Dwarka').city, 'Delhi');
    assert.deepEqual(parseCityInput('99acres', 'Thane').city, 'Mumbai');

    const input = normalizeInput({ source: 'both', cities: ['Mira Road'], maxResults: 5 });
    const jobs = buildJobs(input, ['magicbricks', '99acres']).filter(job => job.page === 1);
    assert.match(jobs.find(j => j.source === 'magicbricks')!.url, /cityName=Mumbai&Locality=Mira-Road(?:&|$)/);
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

test('locality input keeps titles and locations clean and reports the portal city', () => {
    const job = buildJobs(normalizeInput({ source: 'magicbricks', cities: ['Whitefield, Bengaluru, Karnataka'], maxResults: 1 }), ['magicbricks'])[0];
    const html = '<div class="mb-srp__card"><a href="https://www.magicbricks.com/propertyDetails/2-BHK-1200-Sq-ft-Multistorey-Apartment-FOR-Sale-Whitefield-in-Bangalore&id=4d423737393337383930">'
        + '<h2>2 BHK Flat for Sale in Whitefield, Bangalore</h2></a><div>₹ 85 Lac ₹ 7,083 per sqft</div><div>Carpet Area 1200 sqft</div></div>';
    const [record] = parseMagicBricks(html, job);
    assert.ok(record);
    assert.equal(record.city, 'Bangalore');
    assert.equal(record.cityQuery, 'Whitefield, Bengaluru, Karnataka');
    assert.doesNotMatch(String(record.locality), /per sqft|^\d/);
});

test('misspelt cities map to one close known city; unrelated text and ties do not', () => {
    assert.equal(suggestMagicBricksCity('Banglore'), 'Bangalore');
    assert.equal(suggestMagicBricksCity('Hydrabad'), 'Hyderabad');
    assert.equal(suggestMagicBricksCity('Gurgoan'), 'Gurgaon');
    assert.equal(suggestMagicBricksCity('chenai'), 'Chennai');
    assert.equal(suggestMagicBricksCity('Ahmedbad'), 'Ahmedabad');
    assert.equal(suggestMagicBricksCity('Mumbai'), null, 'an exact name needs no correction');
    for (const text of ['Ghodbunder Road', 'Maharashtra', 'Xyzabad', 'Goa', 'abc']) {
        assert.equal(suggestMagicBricksCity(text), null, text);
    }
    assert.equal(isIndianStateName('Maharashtra'), true);
    assert.equal(isIndianStateName('Goa'), false, 'Goa is also a MagicBricks city');
});

test('a rejected misspelt city is retried once under the corrected city, keeping the original as cityQuery', () => {
    const jobs = buildJobs(normalizeInput({ source: 'both', cities: ['Banglore'], maxResults: 60 }), ['magicbricks', '99acres']);
    const mbIndex = jobs.findIndex(job => job.source === 'magicbricks' && job.page === 1);
    const before = jobs.length;
    assert.equal(correctedCityJobs(jobs, mbIndex, 500), 'Bangalore');
    assert.equal(jobs.length, before + 1);
    const retry = jobs[mbIndex + 1];
    assert.equal(retry.city, 'Bangalore'); assert.equal(retry.cityQuery, 'Banglore'); assert.equal(retry.page, 1);
    assert.match(retry.url, /cityName=Bangalore(?:&|$)/);
    const laterMb = jobs.slice(mbIndex + 2).filter(job => job.source === 'magicbricks');
    assert.ok(laterMb.length > 0 && laterMb.every(job => job.city === 'Bangalore' && job.searchKey === retry.searchKey));
    // Never corrected twice, never for another status or a later page.
    assert.equal(correctedCityJobs(jobs, mbIndex + 1, 500), null);
    const acresIndex = jobs.findIndex(job => job.source === '99acres' && job.page === 1);
    assert.equal(correctedCityJobs(jobs, acresIndex, 500), null, '99acres signals an unknown city with 404');
    assert.equal(correctedCityJobs(jobs, acresIndex, 404), 'Bangalore');
    assert.match(jobs[acresIndex + 1].url, /property-in-bangalore-ffid$/);
    const other = buildJobs(normalizeInput({ source: 'magicbricks', cities: ['Maharashtra'], maxResults: 5 }), ['magicbricks']);
    assert.equal(correctedCityJobs(other, 0, 500), null);
});

test('a state entered as a city gets a specific message', () => {
    const failure = unknownCityFailure([{ category: 'SOURCE_HTTP', message: 'HTTP 500', httpStatus: 500, source: 'magicbricks', city: 'Maharashtra' }], 1);
    assert.match(failure!.message, /"Maharashtra" is a state, not a city/);
});
