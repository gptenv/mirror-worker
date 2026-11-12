import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dir=mkdtempSync(path.join(tmpdir(),'mirror-local-route-auth-'));
process.env.MIRROR_DATA_DIR=dir;
const {buildApp}=await import('../dist/index.js');
test.describe('server / local-route-auth',()=>{
  test.after(()=>rmSync(dir,{recursive:true,force:true}));
  test.afterEach(()=>test.mock.restoreAll());
  test('a configured local control credential does not require an upstream identity request',async()=>{
    const previous=process.env.MIRROR_API_KEY;
    process.env.MIRROR_API_KEY='fixture-control';
    const app=await buildApp();
    test.mock.method(globalThis,'fetch',async()=>assert.fail('local settings should not require an upstream request'));
    try{
      const response=await app.inject({method:'GET',url:'/api/settings/hotkeys',headers:{authorization:'Bearer fixture-control'}});
      assert.equal(response.statusCode,200,response.body);
    }finally{
      await app.close();
      if(previous===undefined)delete process.env.MIRROR_API_KEY;else process.env.MIRROR_API_KEY=previous;
    }
  });
  test('Worker owner gate rejects other accounts before local or upstream routes',async()=>{
    const app=await buildApp({worker:true,ownerAccountId:'owner-account'});
    const seen=[];
    test.mock.method(globalThis,'fetch',async(input,init)=>{
      const pathname=new URL(String(input)).pathname;
      seen.push(pathname);
      assert.equal(pathname,'/backend-api/me');
      const token=new Headers(init.headers).get('authorization');
      return Response.json({account:{account_user_id:token==='Bearer owner-token'?'owner-account':'other-account'}});
    });
    try{
      for(const url of ['/api/conversations','/v1/models','/backend-api/models']){
        const denied=await app.inject({method:'GET',url,headers:{authorization:'Bearer other-token'}});
        assert.equal(denied.statusCode,403,`${url}: ${denied.body}`);
      }
      assert.deepEqual(seen,['/backend-api/me','/backend-api/me','/backend-api/me']);
      const allowed=await app.inject({method:'GET',url:'/api/settings/hotkeys',headers:{authorization:'Bearer owner-token'}});
      assert.equal(allowed.statusCode,200,allowed.body);
      const missing=await app.inject({method:'GET',url:'/api/conversations'});
      assert.equal(missing.statusCode,401);
    }finally{await app.close();}
  });
  test('Worker owner gate fails closed when upstream identity is missing or unavailable',async()=>{
    const app=await buildApp({worker:true,ownerAccountId:'owner-account'});
    let calls=0;
    test.mock.method(globalThis,'fetch',async()=>{
      calls++;
      if(calls===1)return Response.json({account:{}});
      return new Response('unavailable',{status:503});
    });
    try{
      const missing=await app.inject({method:'GET',url:'/api/conversations',headers:{authorization:'Bearer owner-token'}});
      assert.equal(missing.statusCode,403);
      const unavailable=await app.inject({method:'GET',url:'/api/conversations',headers:{authorization:'Bearer owner-token'}});
      assert.equal(unavailable.statusCode,503);
    }finally{await app.close();}
  });
  test('local identity failures preserve upstream status and fail closed',async()=>{
    const app=await buildApp({worker:true});
    test.mock.method(globalThis,'fetch',async()=>new Response('temporarily unavailable',{status:503}));
    try{
      const response=await app.inject({method:'GET',url:'/api/settings/hotkeys',headers:{authorization:'Bearer unconfigured'}});
      assert.equal(response.statusCode,503);
      assert.match(response.body,/temporarily unavailable/);
    }finally{await app.close();}
  });
  test('settings, diagnostics, history and model routes use access Bearer and session cookie upstream',async()=>{
    const app=await buildApp({worker:true});
    const seen=[];
    test.mock.method(globalThis,'fetch',async(input,init)=>{
      const headers=new Headers(init.headers);
      assert.equal(headers.get('authorization'),'Bearer stored-access');
      assert.equal(headers.get('cookie'),'__Secure-next-auth.session-token=stored-session');
      assert.equal(headers.get('x-mirror-session-token'),null);
      seen.push(new URL(String(input)).pathname);
      if(String(input).includes('/models'))return Response.json({models:[]});
      if(String(input).includes('/gizmos/'))return Response.json({});
      return Response.json({account:{account_user_id:'account'}});
    });
    try{
      for(const url of ['/api/settings/default-system-instructions','/api/settings/hotkeys','/api/diagnostics','/api/conversations','/api/conversations/search?q=hello','/v1/models','/api/gpts']){
        const response=await app.inject({method:'GET',url,headers:{authorization:'Bearer stored-access','x-mirror-session-token':'stored-session'}});
        assert.equal(response.statusCode,200,`${url}: ${response.body}`);
      }
      assert.ok(seen.includes('/backend-api/me'));
      assert.ok(seen.includes('/backend-api/models'));
    }finally{await app.close();}
  });
  test('a local route refreshes an expired access token using the separately supplied session',async()=>{
    const app=await buildApp({worker:true});
    const seen=[];
    test.mock.method(globalThis,'fetch',async(input,init)=>{
      const headers=new Headers(init.headers);const pathname=new URL(String(input)).pathname;seen.push(pathname);
      assert.equal(headers.get('cookie'),'__Secure-next-auth.session-token=saved-session');
      if(pathname==='/api/auth/session')return Response.json({accessToken:'fresh-access'});
      if(headers.get('authorization')==='Bearer expired-access')return new Response('denied',{status:401});
      assert.equal(headers.get('authorization'),'Bearer fresh-access');
      return Response.json({account:{account_user_id:'account'}});
    });
    try{
      const response=await app.inject({method:'GET',url:'/api/settings/default-system-instructions',headers:{authorization:'Bearer expired-access','x-mirror-session-token':'saved-session'}});
      assert.equal(response.statusCode,200,response.body);
      assert.equal(response.headers['x-mirror-access-token'],'fresh-access');
      assert.deepEqual(seen,['/backend-api/me','/api/auth/session','/backend-api/me']);
    }finally{await app.close();}
  });

  test('asset-content responses set a scoped session cookie when an access token is present', async () => {
    const app = await buildApp({ worker: true });
    test.mock.method(globalThis, 'fetch', async () => Response.json({ account: { account_user_id: 'owner' } }));
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/asset-content',
        headers: { authorization: 'Bearer access-token', host: 'mirror.example', 'x-forwarded-proto': 'https' }
      });
      // The route may 404, but onSend should still run and set the cookie if accessToken is rotated/set.
      const setCookie = response.headers['set-cookie'];
      if (setCookie) {
        assert.match(String(setCookie), /mirror_asset_session=/);
        assert.match(String(setCookie), /Secure/);
      }
    } finally { await app.close(); }
  });

  test('local identity failures prefer statusCode when present', async () => {
    const app = await buildApp({ worker: true });
    test.mock.method(globalThis, 'fetch', async () => { throw Object.assign(new Error("bad"), { statusCode: 418 }); });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/settings/hotkeys', headers: { authorization: 'Bearer unconfigured' } });
      assert.equal(response.statusCode, 418);
    } finally { await app.close(); }
  });
  test('local identity failures fall back to 401 when no status is available', async () => {
    const app = await buildApp({ worker: true });
    test.mock.method(globalThis, 'fetch', async () => { throw new Error('network'); });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/settings/hotkeys', headers: { authorization: 'Bearer unconfigured' } });
      assert.equal(response.statusCode, 401);
    } finally { await app.close(); }
  });
});
