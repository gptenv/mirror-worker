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
    assert.deepEqual(schemas.CompletionResponse.properties.choices.items.properties.finish_reason.enum, ['stop', 'tool_calls']);
    const responseMessage = schemas.ChatMessageResponse;
    assert.deepEqual(responseMessage.properties.role.const, 'assistant');
    assert.deepEqual(responseMessage.properties.tool_calls.items.properties.type.const, 'function');
    assert.equal(responseMessage.properties.tool_calls.items.properties.function.properties.arguments.type, 'string');
    assert.ok(document.paths['/api/diagnostics'].get.responses['200']);
    assert.deepEqual(schemas.EgressStatus.properties.mode.enum, ['direct', 'worker']);
    assert.equal(schemas.EgressStatus.properties.verified.const, false);
    assert.deepEqual(schemas.EgressStatus.properties.checkedAt.type, 'null');
    assert.deepEqual(schemas.EgressStatus.properties.error.type, 'null');
    assert.deepEqual(schemas.DiagnosticResponse.properties.egress.properties.checkedAt.type, 'null');
    assert.equal(schemas.DiagnosticResponse.properties.storage.properties.schemaVersion.type, 'integer');
    const events = schemas.NormalizedConversationEvent;
    assert.equal(events.discriminator.propertyName, 'kind');
    for (const entry of events.oneOf) assert.ok(schemas[entry.$ref.split('/').at(-1)]);
    const params = document.paths['/api/conversations'].get.parameters;
    assert.deepEqual(params.find((p) => p.name === 'sync').schema.enum, ['true', 'false']);
    const responseSchema = document.paths['/v1/responses'].post.responses['200'].content['application/json'].schema;
    assert.ok(responseSchema.required.includes('completed_at'));
    assert.equal(responseSchema.properties.completed_at.type, 'integer');
  });
});
