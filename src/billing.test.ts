import assert from 'node:assert/strict';
import test from 'node:test';
import { wasPushedRecordSaved } from './billing.js';

test('counts an explicitly charged property as saved', () => {
    assert.equal(wasPushedRecordSaved({
        chargedCount: 1,
        eventChargeLimitReached: true,
    }), true);
});

test('does not count a property rejected at the spending limit', () => {
    assert.equal(wasPushedRecordSaved({
        chargedCount: 0,
        eventChargeLimitReached: true,
    }), false);
});

test('counts a free or non-monetized dataset push as saved', () => {
    assert.equal(wasPushedRecordSaved({
        chargedCount: 0,
        eventChargeLimitReached: false,
    }), true);
});
