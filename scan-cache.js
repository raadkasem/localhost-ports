/* A short-lived, validated UI snapshot; never a substitute for a new scan. */
globalThis.PortScanCache = (() => {
  const KEY = "recentPortScan";
  const MAX_AGE_MS = 60 * 1000;

  function restore(cached, entries, now = Date.now()) {
    const restored = new Map();
    if (cached?.version !== 1 || !Array.isArray(cached.results)) return restored;
    const configured = new Map(entries.map((entry) => [entry.port, entry]));
    for (const result of cached.results) {
      if (!result || typeof result !== "object") continue;
      const port = LocalPorts.parsePort(result.port);
      const entry = configured.get(port);
      if (!entry || result.preferredOrigin !== (entry.url || null) ||
          !Number.isFinite(result.checkedAt) || result.checkedAt > now ||
          now - result.checkedAt >= MAX_AGE_MS || typeof result.alive !== "boolean") continue;
      const endpoint = LocalPorts.parseEndpoint(result.url);
      if (!endpoint || endpoint.port !== port) continue;
      const redirect = result.redirect === true;
      if (result.alive && !(Number.isInteger(result.status) &&
          ((result.status >= 200 && result.status <= 599) || (result.status === 0 && redirect)))) continue;
      restored.set(port, {
        ...entry, alive: result.alive, url: endpoint.url,
        label: typeof result.label === "string" ? result.label.slice(0, 80) : `Port ${port}`,
        status: result.alive ? result.status : undefined,
        ok: result.alive && result.status >= 200 && result.status < 300,
        redirect: result.alive && redirect,
        checkedAt: result.checkedAt, preferredOrigin: result.preferredOrigin,
      });
    }
    return restored;
  }

  function snapshot(results) {
    return { version: 1, results: [...results.values()] };
  }

  return { KEY, MAX_AGE_MS, restore, snapshot };
})();
