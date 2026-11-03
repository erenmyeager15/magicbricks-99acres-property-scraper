import test from 'node:test';
import assert from 'node:assert/strict';
import { portalCityName } from './city-aliases.js';
import { buildJobs } from './routes.js';
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
