import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOpenApiDocument } from '../dist/openapi-document.js';
import { ConversationsQuery } from '../dist/api-schemas.js';

test.describe('server / openapi-contract', () => {
  test('request validation defaults and generated schemas preserve the public contract', () => {
    assert.deepEqual(ConversationsQuery.parse({}), { limit: 50, offset: 0, sync: true, resync: false });
    assert.equal(ConversationsQuery.parse({ sync: 'false', resync: 'true' }).sync, false);
    assert.throws(() => ConversationsQuery.parse({ sync: 'invalid' }));
    const document = buildOpenApiDocument();
    const schemas = document.components.schemas;
    assert.ok(schemas.CompletionRequest);
    assert.ok(schemas.ChatMessage);
    const events = schemas.NormalizedConversationEvent;
    assert.equal(events.discriminator.propertyName, 'kind');
    for (const entry of events.oneOf) assert.ok(schemas[entry.$ref.split('/').at(-1)]);
    const params = document.paths['/api/conversations'].get.parameters;
    assert.deepEqual(params.find((p) => p.name === 'sync').schema.enum, ['true', 'false']);
  });
});
