const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeListingUrl,
  findUnitByListingUrl,
} = require('../src/utils/listingUrl');

test('trailing slash and bare URL normalize to the same value', () => {
  assert.equal(
    normalizeListingUrl('https://taneresidence.com/product/bonham-strand-west-studio-a-2/'),
    normalizeListingUrl('https://taneresidence.com/product/bonham-strand-west-studio-a-2')
  );
});

test('http and https normalize to the same value', () => {
  assert.equal(
    normalizeListingUrl('http://taneresidence.com/product/bonham-strand-west-studio-a-2/'),
    normalizeListingUrl('https://taneresidence.com/product/bonham-strand-west-studio-a-2/')
  );
});

test('www and bare host normalize to the same value', () => {
  assert.equal(
    normalizeListingUrl('https://www.taneresidence.com/product/bonham-strand-west-studio-a-2/'),
    normalizeListingUrl('https://taneresidence.com/product/bonham-strand-west-studio-a-2/')
  );
});

test('fbclid query string is stripped before comparison', () => {
  const units = [
    { unit_id: 7, listing_url: 'https://taneresidence.com/product/bonham-strand-west-studio-a-2/' },
  ];

  assert.deepEqual(
    findUnitByListingUrl(units, 'https://taneresidence.com/product/bonham-strand-west-studio-a-2/?fbclid=IwAR123'),
    { status: 'match', unit_id: '7' }
  );
});

test('fragment is stripped before comparison', () => {
  assert.equal(
    normalizeListingUrl('https://taneresidence.com/product/bonham-strand-west-studio-a-2/#section'),
    normalizeListingUrl('https://taneresidence.com/product/bonham-strand-west-studio-a-2/')
  );
});

test('mixed case normalizes to lowercase', () => {
  assert.equal(
    normalizeListingUrl('HTTPS://TaneResidence.com/Product/Bonham-Strand-West-Studio-A-2/'),
    'taneresidence.com/product/bonham-strand-west-studio-a-2'
  );
});

test('non-comparable values normalize to null', () => {
  for (const value of [null, '', '   ', {}, [], 42, true]) {
    assert.equal(normalizeListingUrl(value), null);
  }
});

test('empty unit listing URLs never match empty or junk lookup values', () => {
  // Production has many active units without a URL. Null/empty URLs must be
  // skipped, otherwise those units can all appear to match each other.
  const units = [
    { unit_id: 1, listing_url: null },
    { unit_id: 2, listing_url: '' },
    { unit_id: 3, listing_url: '   ' },
  ];

  assert.deepEqual(findUnitByListingUrl(units, null), { status: 'none', unit_id: null });
  assert.deepEqual(findUnitByListingUrl(units, ''), { status: 'none', unit_id: null });
  assert.deepEqual(findUnitByListingUrl(units, 'https://taneresidence.com/product/not-real/'), {
    status: 'none',
    unit_id: null,
  });
});

test('duplicate normalized listing URL is ambiguous and never guessed', () => {
  const units = [
    { unit_id: 10, listing_url: 'https://taneresidence.com/product/bonham-strand-west-studio-a-2/' },
    { unit_id: 11, listing_url: 'http://www.taneresidence.com/product/bonham-strand-west-studio-a-2' },
  ];

  assert.deepEqual(
    findUnitByListingUrl(units, 'https://taneresidence.com/product/bonham-strand-west-studio-a-2/?fbclid=IwAR123'),
    { status: 'ambiguous', unit_id: null }
  );
});

test('single genuine listing URL match returns a string id', () => {
  const units = [
    { unit_id: 20, listing_url: 'https://taneresidence.com/product/other/' },
    { unit_id: 21, listing_url: 'https://taneresidence.com/product/bonham-strand-west-studio-a-2/' },
  ];

  assert.deepEqual(
    findUnitByListingUrl(units, 'https://taneresidence.com/product/bonham-strand-west-studio-a-2'),
    { status: 'match', unit_id: '21' }
  );
});
