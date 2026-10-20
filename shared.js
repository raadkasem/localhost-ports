/* Shared by the popup and the MV3 service worker; no DOM dependencies. */
globalThis.LocalPorts = (() => {
  const DEFAULT_PORTS = Object.freeze([
    3000, 3001, 4000, 4200, 5000, 5173, 5500,
    8000, 8080, 8443, 8888, 9000, 9090,
  ]);
  const HOSTS = Object.freeze(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);
  const HOST_PATTERNS = HOSTS.flatMap((host) => [
    `http://${host}/*`, `https://${host}/*`,
  ]);
  const STORAGE_KEYS = ["customPorts", "detectedPorts", "dismissedPorts", "portEndpoints"];

  function parsePort(value) {
    if (typeof value !== "string" && typeof value !== "number") return null;
    const text = String(value).trim();
    if (!/^\d+$/.test(text)) return null;
    const port = Number(text);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
  }

  function parseEndpoint(value) {
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) ||
          !HOSTS.includes(url.hostname) || url.username || url.password) return null;
      const port = parsePort(url.port || (url.protocol === "https:" ? 443 : 80));
      return port === null ? null : { port, url: url.origin };
    } catch {
      return null;
    }
  }

  function normalizeState(stored = {}) {
    const ports = (value) => [...new Set((Array.isArray(value) ? value : [])
      .map(parsePort).filter((port) => port !== null))].sort((a, b) => a - b);
    const customPorts = ports(stored.customPorts).filter((port) => !DEFAULT_PORTS.includes(port));
    const known = new Set([...DEFAULT_PORTS, ...customPorts]);
    const dismissedPorts = ports(stored.dismissedPorts).filter((port) => !known.has(port));
    const dismissed = new Set(dismissedPorts);
    const detectedPorts = ports(stored.detectedPorts)
      .filter((port) => !known.has(port) && !dismissed.has(port));
    const portEndpoints = {};
    if (stored.portEndpoints && typeof stored.portEndpoints === "object") {
      for (const [key, value] of Object.entries(stored.portEndpoints)) {
        const port = parsePort(key);
        const endpoint = typeof value === "string" ? parseEndpoint(value) : null;
        if (endpoint && endpoint.port === port) portEndpoints[port] = endpoint.url;
      }
    }
    return { customPorts, detectedPorts, dismissedPorts, portEndpoints };
  }

  return { DEFAULT_PORTS, HOSTS, HOST_PATTERNS, STORAGE_KEYS, parsePort, parseEndpoint, normalizeState };
})();
