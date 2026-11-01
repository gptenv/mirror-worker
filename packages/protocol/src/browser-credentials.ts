/** Shared by the injected frontend, playground and Worker. Keep this function
 * self-contained: its compiled source is embedded in the public bootstrap. */
export function createBrowserCredentials(
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void } | undefined,
  cookies: { read(): string; write(value: string): void },
) {
  const name = "__Host-mirror_read";
  const attributes = "; Path=/; Secure; SameSite=Strict";
  const marker = "mirror_cookie_pair";
  const keys = ["mirror_access_token", "mirror_session_token"];
  function entries() { return cookies.read().split(";").map(part => part.trim().split(/=(.*)/s)).filter(part => part[0]); }
  function clearCookie(rejected = false) {
    for (const [key] of entries()) if (key === name || key!.startsWith(name + ".")) cookies.write(key + "=" + attributes + "; Max-Age=0");
    cookies.write("mirror_asset_session=; Path=/api/asset-content; Secure; SameSite=Strict; Max-Age=0");
    cookies.write("mirror_asset_session=" + attributes + "; Max-Age=0");
    if (rejected) cookies.write(name + "=rejected" + attributes);
  }
  function readCookie(): [string, string] | "rejected" | undefined {
    const values = new Map(entries().map(([key, value]) => [key!, value!]));
    const descriptor = values.get(name);
    if (descriptor === "rejected") return "rejected";
    if (!descriptor || !/^[a-z0-9]+:[1-9][0-9]?$/.test(descriptor)) return;
    const [generation, countText] = descriptor.split(":");
    const count = Number(countText);
    if (count > 16) return;
    let encoded = "";
    for (let i = 0; i < count; i++) {
      const chunk = values.get(name + "." + generation + "." + i);
      if (!chunk) return;
      encoded += chunk;
    }
    try {
      const pair: unknown = JSON.parse(decodeURIComponent(encoded));
      if (Array.isArray(pair) && pair.length === 2 && pair.every(value => typeof value === "string") && pair.some(Boolean)) return pair as [string, string];
    } catch { /* An incomplete/malformed cookie never authenticates. */ }
  }
  function writeCookie(pair: [string, string]) {
    const encoded = encodeURIComponent(JSON.stringify(pair));
    if (!pair.some(Boolean) || encoded.length > 48_000) { clearCookie(); return; }
    // Generation-specific chunks prevent concurrent responses mixing tokens.
    const generation = Math.random().toString(36).slice(2);
    const count = Math.ceil(encoded.length / 3000);
    clearCookie();
    for (let i = 0; i < count; i++) cookies.write(name + "." + generation + "." + i + "=" + encoded.slice(i * 3000, (i + 1) * 3000) + attributes);
    cookies.write(name + "=" + generation + ":" + count + attributes);
    // Retain Node's existing exact-route native asset authentication.
    cookies.write("mirror_asset_session=" + encodeURIComponent(pair[1] || pair[0]) + "; Path=/api/asset-content; Secure; SameSite=Strict");
  }
  function stored(): [string, string] { return [storage!.getItem(keys[0]!) || "", storage!.getItem(keys[1]!) || ""]; }
  function save(pair: [string, string]) {
    keys.forEach((key, index) => pair[index] ? storage!.setItem(key, pair[index]!) : storage!.removeItem(key));
    storage!.setItem(marker, JSON.stringify(pair));
  }
  function sync(): [string, string] {
    const pair = stored(), previous = storage!.getItem(marker), serialized = JSON.stringify(pair), cookie = readCookie();
    // Explicit edits/logout in this or another tab win over an older response.
    if (previous !== serialized || !pair.some(Boolean)) {
      if (previous !== serialized || cookie) writeCookie(pair);
      storage!.setItem(marker, serialized);
      return pair;
    }
    if (cookie === "rejected") { save(["", ""]); clearCookie(); return ["", ""]; }
    if (cookie) { save(cookie); return cookie; }
    // A new browser session restores the already-saved credentials.
    writeCookie(pair);
    return pair;
  }
  function publish() { const pair = stored(); writeCookie(pair); storage!.setItem(marker, JSON.stringify(pair)); }
  function clear() { save(["", ""]); clearCookie(); }
  return { readCookie, writeCookie, clearCookie, sync, publish, clear };
}
