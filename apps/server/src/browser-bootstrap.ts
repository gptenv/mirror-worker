/** Navigation cannot attach a credential from localStorage. Fetch the document
 * in the browser first, then let its scripts execute with the authenticated HTML. */
export const BROWSER_BOOTSTRAP = `<!doctype html><html><head><meta charset="utf-8"><title>Mirror</title></head><body><p id="status">Loading ChatGPT…</p><script>
(async function(){
  try{
    var headers=new Headers({'accept':'text/html','x-mirror-document':'1'});
    var token=localStorage.getItem('mirror_access_token')||localStorage.getItem('mirror_session_token');
    var sessionToken=localStorage.getItem('mirror_session_token');
    if(token)headers.set('authorization','Bearer '+token);
    if(sessionToken)headers.set('x-mirror-session-token',sessionToken);
    var response=await fetch(location.href,{headers:headers,cache:'no-store'});
    var accessToken=response.headers.get('x-mirror-access-token');
    var rotatedSession=response.headers.get('x-mirror-session-token');
    if(rotatedSession)localStorage.setItem('mirror_session_token',rotatedSession);
    else if(accessToken&&accessToken!==token&&!sessionToken)localStorage.setItem('mirror_session_token',token);
    if(accessToken)localStorage.setItem('mirror_access_token',accessToken);
    var html=await response.text();
    if(!response.ok)throw Error(html||('HTTP '+response.status));
    document.open();document.write(html);document.close();
  }catch(error){document.getElementById('status').textContent=error.message||String(error);}
})();
</script></body></html>`;
