// Browser URL adaptation; no telemetry SDK is initialized here.
export const EARLY_PATCH = `<script>(function(){
function rel(u){
  try{
    if(typeof u!=="string") return u;
    var x=new URL(u,location.href);
    if(x.hostname==="chatgpt.com"||x.hostname.endsWith(".chatgpt.com")||x.hostname==="chat.openai.com"){
      x.protocol=location.protocol;
      x.host=location.host;
      return x.href;
    }
  }catch(e){}
  return u;
}
function wrapFetch(delegate){
  function storedToken(){
    return localStorage.getItem('mirror_access_token')||localStorage.getItem('mirror_session_token');
  }
  function rememberToken(token,previous,rotatedSessionToken){
    if(rotatedSessionToken)localStorage.setItem('mirror_session_token',rotatedSessionToken);
    else if(previous&&previous!==token&&!localStorage.getItem('mirror_session_token'))localStorage.setItem('mirror_session_token',previous);
    localStorage.setItem('mirror_access_token',token);
    var cookieToken=localStorage.getItem('mirror_session_token')||token;
    document.cookie='mirror_asset_session='+encodeURIComponent(cookieToken)+'; Path=/api/asset-content; SameSite=Strict'+(location.protocol==='https:'?'; Secure':'');
  }
  function send(input,init){
    var mirrorRequest=false;
    try{
      var token=storedToken();
      var url=typeof input==='string'?input:(input&&typeof input.url==='string'?input.url:String(input));
      if(token&&new URL(url,location.href).origin===location.origin){
        mirrorRequest=true;
        var opts=Object.assign({},init||{});
        var headers=new Headers(opts.headers||(input&&input.headers)||undefined);
        headers.set('authorization','Bearer '+token);
        var sessionToken=localStorage.getItem('mirror_session_token');
        headers.delete('x-mirror-session-token');
        if(sessionToken)headers.set('x-mirror-session-token',sessionToken);
        opts.headers=headers;init=opts;
      }
    }catch(e){}
    var sentToken='';try{sentToken=storedToken();}catch(e){}
    return Promise.resolve(delegate.call(this,input,init)).then(function(response){
      try{var accessToken=mirrorRequest&&response.headers.get('x-mirror-access-token');if(accessToken)rememberToken(accessToken,sentToken,response.headers.get('x-mirror-session-token'));}catch(e){}
      return response;
    });
  }
  var wrapped=function(input,init){
    try{
      if(typeof input==="string")input=rel(input);
      else if(input instanceof URL)input=rel(input.href);
      else if(input&&typeof input==="object"&&typeof input.url==="string"){
        var rewritten=rel(input.url);
        if(rewritten!==input.url){
          // Reconstruct fetch options explicitly instead of cloning Request.
          // A Request carrying a streaming/consumed body can throw when used as
          // the init argument to another Request, which previously caused the
          // catch path to send the original cross-origin URL unchanged.
          var base={
            method:input.method,headers:input.headers,mode:input.mode,
            credentials:input.credentials,cache:input.cache,redirect:input.redirect,
            referrer:input.referrer,referrerPolicy:input.referrerPolicy,
            integrity:input.integrity,keepalive:input.keepalive,signal:input.signal
          };
          if(input.method!=="GET"&&input.method!=="HEAD"){
            // Earlier versions handed a live ReadableStream (input.clone().body)
            // to the reconstructed Request, with an unconditional duplex:"half".
            // That actually broke these requests outright: Chrome's fetch only
            // allows a ReadableStream upload body over a connection it can
            // multiplex (h2/h3), and our proxy is plain HTTP/1.1 -- Chrome's
            // attempt to satisfy that requirement by negotiating an alternate
            // protocol against our origin is exactly what surfaced as
            // net::ERR_ALPN_NEGOTIATION_FAILED on every one of these POSTs
            // (Statsig's telemetry beacon, /backend-api/f/conversation/prepare,
            // composer interaction logging, ...) -- a real, hard failure, not
            // just console noise. A fully-buffered body (ArrayBuffer) needs no
            // duplex option and no streaming upload support at all, so we read
            // the clone to completion here instead of handing over its stream.
            // This does mean the rewrite path is now async; wrapped becomes an
            // async function below, which still satisfies fetch's contract of
            // "returns a Promise that resolves to a Response".
            return input.clone().arrayBuffer().then(function(buf){
              base.body=buf;
              if(init)for(var key in init)base[key]=init[key];
              return send.call(this,rewritten,base);
            }.bind(this));
          }
          if(init)for(var key in init)base[key]=init[key];
          input=rewritten;init=base;
        }
      }
    }catch(e){}
    return send.call(this,input,init);
  };
  try{Object.defineProperty(wrapped,"__mirrorProxyPatch",{value:true});}catch(e){}
  return wrapped;
}
var currentFetch=window.fetch;
if(currentFetch){
  var patchedFetch=wrapFetch(currentFetch);
  try{
    Object.defineProperty(window,"fetch",{
      // ChatGPT's instrumentation replaces (and sometimes deletes) fetch while
      // booting. Keep this accessor in place so every replacement is wrapped.
      configurable:false,enumerable:true,
      get:function(){return patchedFetch;},
      set:function(next){
        if(typeof next==="function"&&!next.__mirrorProxyPatch){
          currentFetch=next;
          patchedFetch=wrapFetch(next);
        }
      }
    });
  }catch(e){window.fetch=patchedFetch;}
}
var open=XMLHttpRequest.prototype.open;
var xhrSetRequestHeader=XMLHttpRequest.prototype.setRequestHeader;
XMLHttpRequest.prototype.setRequestHeader=function(name,value){
  try{if(this.__mirrorSameOrigin&&(/^(authorization|x-mirror-session-token)$/i).test(name)&&(localStorage.getItem('mirror_access_token')||localStorage.getItem('mirror_session_token')))return;}catch(e){}
  return xhrSetRequestHeader.call(this,name,value);
};
XMLHttpRequest.prototype.open=function(method,url){
  var args=Array.prototype.slice.call(arguments);
  try{if(typeof url==="string")args[1]=rel(url);}catch(e){}
  try{this.__mirrorSameOrigin=typeof args[1]==='string'&&new URL(args[1],location.href).origin===location.origin;}catch(e){this.__mirrorSameOrigin=false;}
  try{if(typeof url==="string"&&url.indexOf("prepare")!==-1){window.__mirrorDebugXhr=window.__mirrorDebugXhr||[];window.__mirrorDebugXhr.push({method:method,url:url});}}catch(e){}
  return open.apply(this,args);
};
var xhrSend=XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send=function(){
  try{
    var token=localStorage.getItem('mirror_access_token')||localStorage.getItem('mirror_session_token');
    if(token&&this.__mirrorSameOrigin){
      this.__mirrorSentToken=token;
      xhrSetRequestHeader.call(this,'Authorization','Bearer '+token);
      var sessionToken=localStorage.getItem('mirror_session_token');
      if(sessionToken)xhrSetRequestHeader.call(this,'x-mirror-session-token',sessionToken);
      this.addEventListener('loadend',function(){
        try{
          var accessToken=this.getResponseHeader('x-mirror-access-token');
          if(!accessToken)return;
          var rotatedSessionToken=this.getResponseHeader('x-mirror-session-token');
          if(rotatedSessionToken)localStorage.setItem('mirror_session_token',rotatedSessionToken);
          else if(this.__mirrorSentToken!==accessToken&&!localStorage.getItem('mirror_session_token'))localStorage.setItem('mirror_session_token',this.__mirrorSentToken);
          localStorage.setItem('mirror_access_token',accessToken);
          var cookieToken=localStorage.getItem('mirror_session_token')||accessToken;
          document.cookie='mirror_asset_session='+encodeURIComponent(cookieToken)+'; Path=/api/asset-content; SameSite=Strict'+(location.protocol==='https:'?'; Secure':'');
        }catch(e){}
      });
    }
  }catch(e){}
  return xhrSend.apply(this,arguments);
};
var OrigWorker=window.Worker;
if(OrigWorker){
  window.Worker=function(url,opts){
    try{window.__mirrorWorkers=window.__mirrorWorkers||[];window.__mirrorWorkers.push(String(url));}catch(e){}
    try{url=rel(String(url));}catch(e){}
    return opts!==undefined?new OrigWorker(url,opts):new OrigWorker(url);
  };
  window.Worker.prototype=OrigWorker.prototype;
}
var sb=navigator.sendBeacon;
if(sb)navigator.sendBeacon=function(url,data){try{if(typeof url==="string")url=rel(url);}catch(e){}return sb.call(navigator,url,data);};
// Remove this script's own node from <head> immediately after it has run.
// It has already installed its patches via closures/property overrides at
// this point, so the DOM node itself serves no further purpose -- but left
// in place it is one more unexpected <head> child during the app's own
// hydration pass (see the comment above the removed INJECT constant).
try{
  if(document.currentScript&&document.currentScript.parentNode){
    document.currentScript.parentNode.removeChild(document.currentScript);
  }
}catch(e){}
function mirrorAddInjectAssets(){
  try{
    var l=document.createElement("link");
    l.rel="stylesheet";l.href="/mirror/inject.css";
    var s=document.createElement("script");
    s.defer=true;s.src="/mirror/inject.js";
    var head=document.head||document.documentElement;
    head.appendChild(l);
    head.appendChild(s);
  }catch(e){}
}
if(document.readyState==="complete"){
  mirrorAddInjectAssets();
}else{
  window.addEventListener("load",mirrorAddInjectAssets,{once:true});
}

})();</script>`;
