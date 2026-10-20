const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers.cjs");
const html = (title, status = 200) => new Response(`<html><head><title>${title}</title></head></html>`, {
  status, headers: { "content-type": "text/html" },
});

test("any HTTP response proves reachability and title text is decoded", async () => {
  for (const status of [200, 401, 403, 404, 500]) {
    const { PortScanner } = load(["shared.js", "scanner.js"], { fetch: async () => html("API &amp; UI", status) });
    const result = await PortScanner.probePort({ port: 3000 });
    assert.equal(result.alive, true);
    assert.equal(result.status, status);
    assert.equal(result.label, "API & UI");
  }
});

test("successful host is preferred over a responding error host", async () => {
  const { PortScanner } = load(["shared.js", "scanner.js"], {
    fetch: async (url) => html("Service", url.includes("127.0.0.1") ? 403 : 200),
  });
  const result = await PortScanner.probePort({ port: 3000 });
  assert.equal(result.url, "http://localhost:3000");
});

test("a plaintext HTTP error does not mask a working HTTPS service on the same port", async () => {
  const { PortScanner } = load(["shared.js", "scanner.js"], {
    fetch: async (url) => html("Service", url.startsWith("http:") ? 400 : 200),
  });
  assert.equal((await PortScanner.probePort({ port: 9443 })).url, "https://127.0.0.1:9443");
});

test("HTTPS fallback, HTTPS-first ports, and remembered IPv6 origins work", async () => {
  const calls = [];
  const { PortScanner } = load(["shared.js", "scanner.js"], {
    fetch: async (url, options) => {
      calls.push(url);
      assert.equal(options.cache, "no-store");
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "manual");
      if (url.startsWith("http:")) throw new Error("HTTPS only");
      return html("TLS");
    },
  });
  assert.equal((await PortScanner.probePort({ port: 9443 })).url, "https://127.0.0.1:9443");
  calls.length = 0;
  assert.equal((await PortScanner.probePort({ port: 8443 })).alive, true);
  assert.ok(calls.every((url) => url.startsWith("https:")));
  calls.length = 0;
  assert.equal((await PortScanner.probePort({ port: 1234, url: "https://[::1]:1234" })).url, "https://[::1]:1234");
  assert.deepEqual(calls, ["https://[::1]:1234"]);
});

test("redirects are reachable without following their destination", async () => {
  const { PortScanner } = load(["shared.js", "scanner.js"], {
    fetch: async () => ({ status: 0, ok: false, type: "opaqueredirect", headers: new Headers(), body: null }),
  });
  const result = await PortScanner.probePort({ port: 3000 });
  assert.equal(result.alive, true);
  assert.equal(result.redirect, true);
});

test("offline results retain a safe launch URL", async () => {
  const { PortScanner } = load(["shared.js", "scanner.js"], { fetch: async () => { throw new Error("offline"); } });
  const result = await PortScanner.probePort({ port: 1234, custom: true });
  assert.equal(result.alive, false);
  assert.equal(result.url, "http://localhost:1234");
});

test("large response bodies are capped and canceled on both hosts", async () => {
  let canceled = 0;
  let bytes = 0;
  const { PortScanner } = load(["shared.js", "scanner.js"], {
    fetch: async () => new Response(new ReadableStream({
      pull(controller) { bytes += 8192; controller.enqueue(new Uint8Array(8192).fill(65)); },
      cancel() { canceled++; },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/html" } }),
  });
  assert.equal((await PortScanner.probePort({ port: 3000 })).alive, true);
  assert.equal(canceled, 2);
  assert.ok(bytes <= 2 * PortScanner.MAX_TITLE_BYTES);
});

test("response body deadlines do not hide an already reachable service", async () => {
  const { PortScanner } = load(["shared.js", "scanner.js"], {
    fetch: async (url, { signal }) => new Response(new ReadableStream({
      start(controller) {
        signal.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
      },
    }), { headers: { "content-type": "text/html", server: "Streaming API" } }),
  });
  const start = Date.now();
  const result = await PortScanner.probePort({ port: 3000 });
  assert.equal(result.alive, true);
  assert.equal(result.label, "Streaming API");
  assert.ok(Date.now() - start < 3000);
});

test("scans cap request concurrency and report all results progressively", async () => {
  let inFlight = 0;
  let maximum = 0;
  const { PortScanner } = load(["shared.js", "scanner.js"], {
    fetch: async () => {
      maximum = Math.max(maximum, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return html("Service");
    },
  });
  const results = [];
  await PortScanner.scan(Array.from({ length: 30 }, (_, i) => ({ port: 10000 + i })), { onResult: (result) => results.push(result) });
  assert.equal(results.length, 30);
  assert.equal(maximum, 8);
  assert.equal(inFlight, 0);
});

test("cancellation stops queued ports and aborts in-flight requests", async () => {
  let requests = 0;
  const { PortScanner } = load(["shared.js", "scanner.js"], {
    fetch: async (url, { signal }) => {
      requests++;
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  });
  const controller = new AbortController();
  const results = [];
  const scanning = PortScanner.scan(Array.from({ length: 30 }, (_, i) => ({ port: 10000 + i })), {
    signal: controller.signal, onResult: (result) => results.push(result),
  });
  controller.abort();
  await scanning;
  assert.equal(requests, 8);
  assert.equal(results.length, 0);
});
