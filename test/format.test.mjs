import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactObject, compactList, pageInfo } from '../build/format.js';

test('compactObject lifts data fields to the top level', () => {
  const result = compactObject({
    key: 'ABCD1234',
    version: 7,
    library: { type: 'user', id: 1, links: {} },
    links: { self: { href: 'http://…' } },
    data: { key: 'ABCD1234', version: 7, itemType: 'book', title: 'Dune' },
  });
  assert.equal(result.title, 'Dune');
  assert.equal(result.itemType, 'book');
  assert.equal(result.key, 'ABCD1234');
  assert.equal(result.version, 7);
});

test('compactObject drops the envelope noise a local caller cannot use', () => {
  const result = compactObject({ key: 'A', data: { title: 'x' }, library: { id: 1 }, links: { self: {} } });
  assert.ok(!('library' in result), 'library block should be dropped');
  assert.ok(!('links' in result), 'links block should be dropped');
});

test('compactObject keeps useful meta but not the rest', () => {
  const result = compactObject({
    key: 'A',
    data: { title: 'x' },
    meta: { numChildren: 3, creatorSummary: 'Herbert', parsedDate: '1965', someOtherThing: 'noise' },
  });
  assert.equal(result.numChildren, 3);
  assert.equal(result.creatorSummary, 'Herbert');
  assert.equal(result.parsedDate, '1965');
  assert.ok(!('someOtherThing' in result));
});

test('compactObject omits zero-valued meta counters', () => {
  const result = compactObject({ key: 'A', data: {}, meta: { numChildren: 0, numItems: 0 } });
  assert.ok(!('numChildren' in result));
  assert.ok(!('numItems' in result));
});

test('compactObject strips empty relations, tags and collections', () => {
  const result = compactObject({ key: 'A', data: { title: 'x', relations: {}, tags: [], collections: [] } });
  assert.ok(!('relations' in result));
  assert.ok(!('tags' in result));
  assert.ok(!('collections' in result));
});

test('compactObject keeps non-empty tags and collections', () => {
  const result = compactObject({ key: 'A', data: { tags: [{ tag: 'read' }], collections: ['XYZ12345'] } });
  assert.deepEqual(result.tags, [{ tag: 'read' }]);
  assert.deepEqual(result.collections, ['XYZ12345']);
});

test('verbose returns the raw envelope untouched', () => {
  const envelope = { key: 'A', library: { id: 1 }, links: { self: {} }, data: { title: 'x' } };
  assert.deepEqual(compactObject(envelope, true), envelope);
});

test('compactList maps every entry', () => {
  const result = compactList([{ key: 'A', data: { title: 'one' } }, { key: 'B', data: { title: 'two' } }]);
  assert.deepEqual(result.map((r) => r.title), ['one', 'two']);
});

test('pageInfo reports a cursor when more results remain', () => {
  assert.deepEqual(pageInfo(50, 0, 137), { totalResults: 137, returned: 50, start: 0, nextStart: 50 });
});

test('pageInfo reports no cursor on the last page', () => {
  assert.deepEqual(pageInfo(37, 100, 137), { totalResults: 137, returned: 37, start: 100, nextStart: null });
});

test('pageInfo copes with an unknown total', () => {
  assert.deepEqual(pageInfo(10, 0, null), { totalResults: null, returned: 10, start: 0, nextStart: null });
});
