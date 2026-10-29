import assert from 'node:assert/strict';
import test from 'node:test';
import { optionalCatalog } from '../dist/catalog.js';

test.describe('server / optional catalog', () => {
  test('preserves successful data and tolerates an unavailable optional catalog', async () => {
    const result = { items: [{ id: 'fixture' }] };
    assert.equal(await optionalCatalog(Promise.resolve(result)), result);
    assert.deepEqual(await optionalCatalog(Promise.reject(new Error('network failure'))), {});
    assert.deepEqual(await optionalCatalog(Promise.reject({ statusCode: 500 })), {});
  });
  test('does not hide authentication and permission failures', async () => {
    for (const error of [{ statusCode: 401 }, { status: 403 }]) {
      await assert.rejects(optionalCatalog(Promise.reject(error)), (received) => received === error);
    }
  });
});
