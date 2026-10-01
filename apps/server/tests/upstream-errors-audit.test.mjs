import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChatGptBackendClient, mintAccessToken } from '@mirror/protocol';
import { stubBackend } from './helpers/backend.mjs';
const dir = mkdtempSync(path.join(tmpdir(), 'mirror-error-audit-'));
process.env.MIRROR_DATA_DIR = dir;
const { buildApp } = await import('../dist/index.js');
const { sealAssetTicket } = await import('../dist/store.js');
const { createAssetLinks } = await import('../dist/asset-content.js');
const { apiError } = await import('../dist/api-errors.js');
const json = '{\n "error": {"message":"denied", "extra":"keep everything ☃"}\n}\n';
const streamBody = 'data: {"p":"","o":"add","v":{"error_code":"upstream_denied","detail":"keep this"}}\r\n\r\ndata: [DONE]\r\n\r\n';
test.describe('server / upstream-errors-audit', () => {
  test.after(() => rmSync(dir, {recursive:true, force:true}));
  test.afterEach(() => test.mock.restoreAll());
  test('local errors are not substituted with fabricated diagnostics', () => {
    assert.equal(apiError(502, 'storage.transactionSync is not a function', 'r').error.message, 'storage.transactionSync is not a function');
  });
  for (const status of [400,401,403,404,409,422,429,500,502,503,504]) test(`protocol HTTP ${status} preserves the complete body`, async () => {
    test.mock.method(globalThis, 'fetch', async () => new Response(json,{status}));
    await assert.rejects(new ChatGptBackendClient({accessToken:'access',deviceId:'device'}).fetchMe(), error => error.upstreamResponseText === json && error.status === status);
  });
  test('session exchange preserves complete upstream body', async () => {
    test.mock.method(globalThis, 'fetch', async () => new Response(json,{status:403}));
    await assert.rejects(mintAccessToken('session'), error => error.upstreamResponseText === json);
  });
  for (const endpoint of ["/v1/chat/completions", "/v1/responses"]) for (const stream of [false,true]) test(`${endpoint} ${stream ? 'SSE' : 'JSON'} preserves the entire upstream error stream`, async () => {
    const app = await buildApp({worker:true});
    const backend = stubBackend('audit');
    test.mock.method(globalThis, 'fetch', async (input, init) => new URL(String(input)).pathname.endsWith('/f/conversation') ? new Response(streamBody,{headers:{'content-type':'text/event-stream'}}) : backend(input,init));
    try {
      const response = await app.inject({method:'POST',url:endpoint,headers:{authorization:'Bearer access'},payload:{model:'auto', ...(endpoint.endsWith('/responses') ? {input:'hello'} : {messages:[{role:'user',content:'hello'}]}),store:false,stream}});
      const error = stream ? response.body.split('\n').filter(line => line.startsWith('data: {')).map(line=>JSON.parse(line.slice(6))).find(chunk=>chunk.error || chunk.type === 'error' || chunk.response?.error) : response.json();
      const message = error.error?.message ?? error.response?.error?.message ?? error.message; 
      assert.equal(message,streamBody);
    } finally { await app.close(); }
  });
  for (const endpoint of ['/api/gpts', '/v1/models']) test(`${endpoint} forwards optional GPT lookup failures`, async () => {
    const app=await buildApp({worker:true});
    const backend=stubBackend('audit');
    test.mock.method(globalThis,'fetch',async(input,init)=>new URL(String(input)).pathname.includes('/gizmos/') ? new Response(json,{status:503}) : backend(input,init));
    try {
      const response=await app.inject({method:'GET',url:endpoint,headers:{authorization:'Bearer access'}});
      assert.equal(response.statusCode,503,response.body);assert.equal(response.json().error.message,json);
    } finally {await app.close();}
  });
  test('typed and plain JSON stream errors preserve the full response', async () => {
    for (const payload of [{type:'error',error:{message:'details',extra:'retained'}},{error:{message:'details'}},{error_code:'plain_error'}]) {
      const body = `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`;
      const backend = stubBackend('audit');
      test.mock.method(globalThis,'fetch',async(input,init)=>new URL(String(input)).pathname.endsWith('/f/conversation') ? new Response(body) : backend(input,init));
      await assert.rejects(new ChatGptBackendClient({accessToken:'access',deviceId:'device'}).sendMessage({model:'auto',prompt:'hi'}),error=>error.upstreamResponseText===body);
      test.mock.restoreAll();
    }
  });
  test('asset download returns upstream status and complete raw body', async () => {
    const app = await buildApp({worker:true});
    test.mock.method(ChatGptBackendClient.prototype,'resolveAssetDownloadMetadata',async()=>({url:'https://files.oaiusercontent.com/file'}));
    test.mock.method(ChatGptBackendClient.prototype,'fetchAssetContent',async()=>new Response(json,{status:403,headers:{'content-type':'application/json'}}));
    const ticket=sealAssetTicket({pointer:'file-service://file',conversationId:null,messageId:null,fileName:'file.txt'});
    try {
      const response=await app.inject({method:'GET',url:`/api/asset-content?ticket=${encodeURIComponent(ticket)}`,headers:{authorization:'Bearer access'}});
      assert.equal(response.statusCode,403,response.body);assert.equal(response.body,json);
    } finally {await app.close();}
  });
  test('preview HTTP errors propagate instead of becoming unavailable flags', async () => {
    const client=new ChatGptBackendClient({accessToken:'access',deviceId:'device'});
    test.mock.method(client,'resolveAssetDownloadMetadata',async()=>({url:'https://files.oaiusercontent.com/file',fileName:'image.png'}));
    test.mock.method(client,'fetchAssetContent',async()=>new Response(json,{status:403}));
    await assert.rejects(createAssetLinks(client,'https://mirror.example','file-service://file',null,null,undefined,true),error=>error.upstreamResponseText===json);
  });
});
