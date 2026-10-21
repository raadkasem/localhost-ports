globalThis.PortScanner = (() => {
  const TIMEOUT_MS = 1000;
  const MAX_TITLE_BYTES = 64 * 1024;
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
    const controller = new AbortController();
    const abort = () => controller.abort();
    let response;
    const timeout = setTimeout(abort, TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      response = await fetch(url, {
        signal: controller.signal,
        cache: "no-store",
        credentials: "omit",
        redirect: "manual",
      });
      // macOS AirPlay Receiver also listens on development ports (notably 5000).
      // Identify the service, not its port/status: real apps can legitimately return 403.
      if (/^(?:AirTunes|AirPlay)(?:\/|\s|$)/i.test((response.headers.get("server") || "").trim())) return null;
      const label = await readLabel(response, port);
      return {
        alive: true, url, label, status: response.status,
        ok: response.ok, redirect: response.type === "opaqueredirect",
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
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

  return { scan, probePort, fallbackURL, TIMEOUT_MS, MAX_TITLE_BYTES, CONCURRENCY };
})();
