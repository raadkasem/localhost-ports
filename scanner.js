globalThis.PortScanner = (() => {
  const TIMEOUT_MS = 1000;
  const MAX_TITLE_BYTES = 64 * 1024;
  const MAX_REDIRECTS = 3;
  const CONCURRENCY = 4; // At most eight requests (two hosts per port) at once.

  function fallbackURL(port) {
    return `${port === 443 || port === 8443 ? "https" : "http"}://localhost:${port}`;
  }

  async function readLabel(response, port) {
    const fallback = (response.headers.get("server") || `Port ${port}`).slice(0, 80);
    if (!/text\/html/i.test(response.headers.get("content-type") || "") || !response.body) return fallback;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    try {
      while (bytes < MAX_TITLE_BYTES) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = value.subarray(0, MAX_TITLE_BYTES - bytes);
        bytes += chunk.byteLength;
        text += decoder.decode(chunk, { stream: true });
        if (/<\/title\s*>|<\/head\s*>/i.test(text)) break;
      }
      text += decoder.decode();
      const title = text.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1];
      if (title?.trim()) {
        // A detached, inert parser decodes entities. Its result is rendered as text only.
        const decoded = new DOMParser().parseFromString(`<title>${title}</title>`, "text/html").title;
        return decoded.replace(/\s+/g, " ").trim().slice(0, 80) || fallback;
      }
    } catch {
      // Headers already prove reachability even if a body stalls or is truncated.
    } finally {
      reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return fallback;
  }

  async function probeURL(url, port, signal) {
    const endpoint = LocalPorts.parseEndpoint(url);
    if (!endpoint || endpoint.port !== port) return null;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const headersEvent = globalThis.chrome?.webRequest?.onHeadersReceived;
    let current = new URL(url);
    let requestURL = url;
    let redirectLocation;
    let listening = false;
    let reachable = null;
    let response;
    // Fetch's opaque redirect response hides Location, even for a local /login.
    // Observe only this extension's matching scan; never let fetch follow blindly.
    const onHeaders = (details) => {
      if (details.initiator !== `chrome-extension://${globalThis.chrome?.runtime?.id}` ||
          details.url !== current.href || ![301, 302, 303, 307, 308].includes(details.statusCode)) return;
      redirectLocation = details.responseHeaders?.find((header) => header.name.toLowerCase() === "location")?.value;
    };
    const timeout = setTimeout(abort, TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      try {
        headersEvent?.addListener(onHeaders, {
          urls: LocalPorts.HOST_PATTERNS, types: ["xmlhttprequest"],
        }, ["responseHeaders"]);
        listening = Boolean(headersEvent);
      } catch {
        // Without permission/header access, retain the safe Redirect fallback.
      }
      const visited = new Set([current.href]);
      for (let hops = 0; ; hops++) {
        redirectLocation = undefined;
        response = await fetch(requestURL, {
          signal: controller.signal,
          cache: "no-store",
          credentials: "omit",
          redirect: "manual",
        });
        // Identify AirPlay, not its port/status: real apps can legitimately return 403.
        if (/^(?:AirTunes|AirPlay)(?:\/|\s|$)/i.test((response.headers.get("server") || "").trim())) return null;
        const redirect = response.type === "opaqueredirect" || [301, 302, 303, 307, 308].includes(response.status);
        reachable = {
          alive: true, url, label: (response.headers.get("server") || `Port ${port}`).slice(0, 80),
          status: response.status, ok: response.ok, redirect,
        };
        if (!redirect) {
          reachable.label = await readLabel(response, port);
          return reachable;
        }
        const location = response.headers.get("location") || redirectLocation;
        if (!location || hops >= MAX_REDIRECTS || controller.signal.aborted) return reachable;
        let next;
        try { next = new URL(location, current); } catch { return reachable; }
        next.hash = "";
        // No host aliases, port changes, protocol upgrades/downgrades, or credentials.
        if (next.origin !== endpoint.url || next.username || next.password || visited.has(next.href)) return reachable;
        visited.add(next.href);
        response.body?.cancel().catch(() => {});
        response = undefined;
        current = next;
        requestURL = next.href;
      }
    } catch {
      // A blocked/failed/slow destination does not undo the responding root.
      return reachable;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (listening) headersEvent.removeListener(onHeaders);
      if (response?.body && !response.body.locked) response.body.cancel().catch(() => {});
      controller.abort();
    }
  }

  async function probePort(entry, signal) {
    const offline = { ...entry, alive: false, url: entry.url || fallbackURL(entry.port), label: "Offline" };
    if (signal?.aborted) return offline;
    // A visited origin retains its protocol and host (including IPv6/0.0.0.0).
    if (entry.url) {
      const remembered = await probeURL(entry.url, entry.port, signal);
      if (remembered) return { ...entry, ...remembered };
    }
    const schemes = entry.port === 443 || entry.port === 8443 ? ["https", "http"] : ["http", "https"];
    let responding;
    for (const scheme of schemes) {
      if (signal?.aborted) break;
      const urls = ["127.0.0.1", "localhost"]
        .map((host) => `${scheme}://${host}:${entry.port}`)
        .filter((url) => LocalPorts.parseEndpoint(url)?.url !== entry.url);
      const results = (await Promise.all(urls.map((url) => probeURL(url, entry.port, signal)))).filter(Boolean);
      const pick = results.find((result) => result.ok) || results[0];
      if (pick?.ok) return { ...entry, ...pick };
      responding ||= pick;
    }
    return responding ? { ...entry, ...responding } : offline;
  }

  async function scan(entries, { signal, onResult = () => {} } = {}) {
    let index = 0;
    async function worker() {
      while (!signal?.aborted && index < entries.length) {
        const entry = entries[index++];
        const result = await probePort(entry, signal);
        if (!signal?.aborted) onResult(result);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker));
  }

  return { scan, probePort, fallbackURL, TIMEOUT_MS, MAX_TITLE_BYTES, MAX_REDIRECTS, CONCURRENCY };
})();
