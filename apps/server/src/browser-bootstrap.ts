import { createBrowserCredentials } from "@mirror/protocol/browser-credentials";
/** The public shell collects a browser-local credential before requesting the
 * protected document. Only an owner-verified response may replace this shell. */
export const BROWSER_BOOTSTRAP = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect to Mirror</title>
<style>html{color-scheme:light dark;font:16px system-ui,sans-serif}body{margin:0;padding:24px}main{max-width:440px;margin:10vh auto}h1{font-size:28px}p{line-height:1.5}label{display:block;font-weight:600;margin-bottom:8px}input,button{box-sizing:border-box;width:100%;font:inherit;padding:12px;border:1px solid #888;border-radius:8px}button{margin-top:12px;cursor:pointer}button:disabled{cursor:wait}small{display:block;line-height:1.5;margin:16px 0}#status{min-height:3em}</style>
</head><body><main><h1>Connect to Mirror</h1><p>Use a ChatGPT accessToken or sessionToken for the owner's account.</p>
<form id="connect"><label for="credential">ChatGPT credential</label><input id="credential" type="password" autocomplete="off" spellcheck="false" required><button id="submit" type="submit">Connect</button></form>
<small>Your credential stays in this browser for this Mirror address and is sent to Mirror to authenticate with ChatGPT.</small><p id="status" role="status" aria-live="polite">Enter your credential to continue.</p><noscript>JavaScript is required to connect.</noscript></main><script>
(async function(){
  var __name=function(fn){return fn;};
  var mirrorCredentials=(${createBrowserCredentials.toString()})(localStorage,{read:function(){return document.cookie;},write:function(value){document.cookie=value;}});
  var form=document.getElementById('connect'),input=document.getElementById('credential'),button=document.getElementById('submit'),status=document.getElementById('status');
  var attempt=0;
  function stored(){return mirrorCredentials.sync();}
  function credentialsMatch(pair){var current=stored();return current[0]===pair[0]&&current[1]===pair[1];}
  function failureMessage(response,authStatus){
    if(authStatus==='owner_mismatch')return "This account is not the allowed owner. Use the owner's ChatGPT credential.";
    if(authStatus==='credential_rejected')return 'Credential not accepted. Enter a current ChatGPT credential and try again.';
    if(authStatus==='owner_verified')return 'Your credential was verified, but the requested page could not load (HTTP '+response.status+'). Reload to retry with your saved credential.';
    if(authStatus==='upstream_failure'&&response.status===403)return "ChatGPT blocked Mirror's connection before your credential could be verified (HTTP 403). Mirror's operator should check upstream connectivity before you replace your token.";
    if(response.status===429)return 'Too many connection attempts. Wait a moment, then reload. Your saved credential has been kept.';
    if(response.status>=500)return 'The upstream connection is temporarily unavailable (HTTP '+response.status+'). Your saved credential has been kept. Try again later.';
    return 'Mirror could not confirm your connection (HTTP '+response.status+'). Reload this Mirror address and try again. Your saved credential has been kept.';
  }
  async function load(candidate){
    var currentAttempt=++attempt;
    button.disabled=true;
    status.textContent='Connecting…';
    try{
      var previous=stored(),token=candidate||previous[0]||previous[1],sessionToken=candidate?'':previous[1];
      if(!token){status.textContent='Enter your credential to continue.';return;}
      var headers=new Headers({'accept':'text/html','x-mirror-document':'1','authorization':'Bearer '+token});
      if(sessionToken)headers.set('x-mirror-session-token',sessionToken);
      var response=await fetch(location.href,{headers:headers,cache:'no-store',redirect:'error'});
      if(currentAttempt!==attempt||!credentialsMatch(previous)){
        await response.body?.cancel();
        if(currentAttempt===attempt)status.textContent='Credentials changed while connecting. Reload to continue.';
        return;
      }
      var authStatus=response.headers.get('x-mirror-auth-status');
      // Failed owner checks never authorize storage, even if an exchange ran.
      // A verified owner refresh survives failures fetching the document.
      if(response.ok||authStatus==='owner_verified'){
        var accessToken=response.headers.get('x-mirror-access-token');
        var rotatedSession=response.headers.get('x-mirror-session-token');
        if(candidate){localStorage.setItem('mirror_access_token',candidate);localStorage.removeItem('mirror_session_token');}
        if(rotatedSession)localStorage.setItem('mirror_session_token',rotatedSession);
        else if(accessToken&&accessToken!==token&&!sessionToken)localStorage.setItem('mirror_session_token',token);
        if(accessToken)localStorage.setItem('mirror_access_token',accessToken);
        mirrorCredentials.publish();
      }
      if(!response.ok){
        if(!candidate&&(authStatus==='credential_rejected'||authStatus==='owner_mismatch')){
          mirrorCredentials.clear();
        }
        status.textContent=failureMessage(response,authStatus);
        await response.body?.cancel();
        return;
      }
      // Retain an accepted refresh on an interrupted body, but never render
      // a previous identity's document after another attempt or tab replaces it.
      var accepted=stored();
      var body=await response.text();
      if(currentAttempt!==attempt||!credentialsMatch(accepted)){
        if(currentAttempt===attempt)status.textContent='Credentials changed while connecting. Reload to continue.';
        return;
      }
      if((response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase()==='text/html'){
        document.open();document.write(body);document.close();
      }else{
        // OpenAPI JSON/YAML and other data documents must never execute as HTML.
        var pre=document.createElement('pre');pre.textContent=body;
        pre.style.whiteSpace='pre-wrap';document.title='Mirror document';
        document.body.replaceChildren(pre);
      }
    }catch(error){if(currentAttempt===attempt)status.textContent='Connection interrupted. Try again, or reload to use your saved credential.';}
    finally{if(currentAttempt===attempt)button.disabled=false;}
  }
  form.onsubmit=async function(event){event.preventDefault();var token=input.value.trim();input.value='';if(!token){status.textContent='Enter your credential to continue.';return;}await load(token);};
  await load();
})();
</script></body></html>`;
