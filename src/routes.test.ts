import assert from 'node:assert/strict';
import test from 'node:test';
import { parseIndianMoney, redactSensitiveText } from './routes.js';

test('parses crore and lakh prices into INR numbers', () => {
    assert.equal(parseIndianMoney('INR 1.25 Crore'), 12_500_000);
    assert.equal(parseIndianMoney('Rs. 85 Lakh'), 8_500_000);
});

test('parses plain INR prices and missing values', () => {
    assert.equal(parseIndianMoney('INR 6,250,000'), 6_250_000);
    assert.equal(parseIndianMoney(null), null);
});

test('redacts Indian phone numbers and email addresses', () => {
    const redacted = redactSensitiveText('Call +91 9876543210 or email owner@example.com');

    assert.equal(redacted.includes('9876543210'), false);
    assert.equal(redacted.includes('owner@example.com'), false);
    assert.match(redacted, /\[redacted phone\]/);
    assert.match(redacted, /\[redacted email\]/);
});
