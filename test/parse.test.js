import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInvoiceLine, startsInvoiceLine } from '../src/parse.js';

const expected = { client: 'Sarah', amount: 50, currency: 'USD', description: 'logo design' };

test('understands natural ways to ask for an invoice', () => {
  for (const line of [
    'invoice Sarah $50 logo design',
    'Invoice Sarah $50 for logo design',
    'invoice to Sarah $50 for logo design',
    'make me an invoice to Sarah $50 for logo design',
    'Please create an invoice for Sarah for $50 for logo design',
    'can you send a new invoice to Sarah $50 logo design',
    'invoice $50 to Sarah for logo design',
  ]) {
    assert.deepEqual(parseInvoiceLine(line), expected, line);
    assert.equal(startsInvoiceLine(line), true, line);
  }
});

test('keeps other currencies and refuses a line with no client', () => {
  assert.deepEqual(parseInvoiceLine('bill Bright Studio ₦75000 flyer design'), { client: 'Bright Studio', amount: 75000, currency: 'NGN', description: 'flyer design' });
  assert.equal(parseInvoiceLine('invoice $50 logo design'), null);
  assert.equal(startsInvoiceLine('what is an invoice'), false);
});
