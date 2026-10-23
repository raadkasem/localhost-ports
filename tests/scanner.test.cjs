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

test("AirPlay responses are hidden by identity, including remembered origins, and bodies are canceled", async () => {
  for (const server of ["AirTunes/980.77.5", "AirPlay/1.0"]) {
    let canceled = 0;
    const { PortScanner } = load(["shared.js", "scanner.js"], {
      fetch: async () => new Response(new ReadableStream({ cancel() { canceled++; } }), {
        status: 403, headers: { server },
      }),
    });
    assert.equal((await PortScanner.probePort({ port: 5000, url: "http://127.0.0.1:5000" })).alive, false);
    assert.ok(canceled > 0);
  }
});

test("real development apps on port 5000 remain visible even with an empty 403 body", async () => {
  const { PortScanner } = load(["shared.js", "scanner.js"], {
    fetch: async () => new Response(null, { status: 403, headers: { server: "Werkzeug/3.1.0" } }),
  });
  const result = await PortScanner.probePort({ port: 5000 });
  assert.equal(result.alive, true);
  assert.equal(result.status, 403);
});

test("an AirPlay listener on one host does not hide a real app on the other", async () => {
  const { PortScanner } = load(["shared.js", "scanner.js"], {
    fetch: async (url) => url.includes("127.0.0.1")
      ? new Response(null, { status: 403, headers: { server: "AirTunes/980.77.5" } }) : html("Flask app"),
  });
  const result = await PortScanner.probePort({ port: 5000 });
  assert.equal(result.alive, true);
  assert.equal(result.label, "Flask app");
  assert.equal(result.url, "http://localhost:5000");
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

test("same-origin redirects expose the destination title but retain the root launch URL", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const calls = [];
    const { PortScanner } = load(["shared.js", "scanner.js"], {
      fetch: async (url, options) => {
        calls.push(url);
        assert.equal(options.redirect, "manual");
        assert.equal(options.credentials, "omit");
        return calls.length === 1 ? new Response(null, { status, headers: { location: "/login?next=%2F#sign-in" } }) : html("Local app &amp; Login");
      },
    });
    const result = await PortScanner.probePort({ port: 8073, url: "http://0.0.0.0:8073" });
    assert.deepEqual(calls, ["http://0.0.0.0:8073", "http://0.0.0.0:8073/login?next=%2F"]);
    assert.equal(result.label, "Local app & Login");
    assert.equal(result.url, "http://0.0.0.0:8073");
    assert.equal(result.redirect, false);
    assert.equal(result.status, 200);
    assert.equal(result.ok, true);
  }
});

test("opaque redirects use extension-only response headers and remove the temporary listener", async () => {
  const listeners = new Set();
  const calls = [];
  const chrome = {
    runtime: { id: "test-extension" },
    webRequest: { onHeadersReceived: {
      addListener(listener, filter, options) {
        listeners.add(listener);
        assert.deepEqual([...filter.types], ["xmlhttprequest"]);
        assert.deepEqual([...options], ["responseHeaders"]);
        assert.ok(filter.urls.every((url) => !url.includes("<all_urls>")));
      },
      removeListener(listener) { listeners.delete(listener); },
    } },
  };
  const { PortScanner } = load(["shared.js", "scanner.js"], {
    chrome,
    fetch: async (url) => {
      calls.push(url);
      if (calls.length > 1) return html("Login page");
      for (const listener of listeners) {
        listener({ initiator: "chrome-extension://test-extension", url: `${url}/`, statusCode: 302,
          responseHeaders: [{ name: "Location", value: "/login" }] });
        listener({ initiator: "http://localhost:8073", url: `${url}/`, statusCode: 302,
          responseHeaders: [{ name: "Location", value: "/not-the-scan" }] });
      }
      return { status: 0, ok: false, type: "opaqueredirect", headers: new Headers(), body: null };
    },
  });
  const result = await PortScanner.probePort({ port: 8073, url: "http://localhost:8073" });
  assert.equal(result.label, "Login page");
  assert.deepEqual(calls, ["http://localhost:8073", "http://localhost:8073/login"]);
  assert.equal(listeners.size, 0);
});

test("redirects to other hosts, ports, schemes, credentials, and malformed URLs are never fetched", async () => {
  for (const location of [
    "https://example.com/login", "//example.com/login", "http://127.0.0.1:8073/login",
    "http://localhost:8074/login", "https://localhost:8073/login", "http://user:pass@localhost:8073/login",
    "javascript:alert(1)", "data:text/html,<title>External</title>", "http://[",
  ]) {
    const calls = [];
    const { PortScanner } = load(["shared.js", "scanner.js"], {
      fetch: async (url) => {
        calls.push(url);
        return new Response(null, { status: 302, headers: { location } });
      },
    });
    const result = await PortScanner.probePort({ port: 8073, url: "http://localhost:8073" });
    assert.equal(result.alive, true);
    assert.equal(result.redirect, true);
    assert.deepEqual(calls, ["http://localhost:8073"], location);
  }
});

test("redirect chains resolve relative paths and cancel every intermediate body", async () => {
  let canceled = 0;
  const calls = [];
  const { PortScanner } = load(["shared.js", "scanner.js"], {
    fetch: async (url) => {
      calls.push(url);
      if (calls.length === 3) return html("Dashboard");
      return new Response(new ReadableStream({ cancel() { canceled++; } }), {
        status: 302, headers: { location: calls.length === 1 ? "http://localhost:8073/auth/start" : "../login" },
      });
    },
  });
  const result = await PortScanner.probePort({ port: 8073, url: "http://localhost:8073" });
  assert.equal(result.label, "Dashboard");
  assert.equal(canceled, 2);
  assert.deepEqual(calls, ["http://localhost:8073", "http://localhost:8073/auth/start", "http://localhost:8073/login"]);
});

test("redirect loops and long chains stop at the shared hop limit", async () => {
  for (const loop of [true, false]) {
    let requests = 0;
    const { PortScanner } = load(["shared.js", "scanner.js"], {
      fetch: async () => {
        requests++;
        return new Response(null, { status: 302, headers: { location: loop && requests === 2 ? "/" : `/hop-${requests}` } });
      },
    });
    const result = await PortScanner.probePort({ port: 8073, url: "http://localhost:8073" });
    assert.equal(result.redirect, true);
    assert.equal(requests, loop ? 2 : PortScanner.MAX_REDIRECTS + 1);
  }
});

test("a failed redirect destination preserves the reachable root", async () => {
  let requests = 0;
  const { PortScanner } = load(["shared.js", "scanner.js"], {
    fetch: async () => {
      if (++requests > 1) throw new Error("Connection closed");
      return new Response(null, { status: 302, headers: { location: "/login" } });
    },
  });
  const result = await PortScanner.probePort({ port: 8073, url: "http://localhost:8073" });
  assert.equal(result.alive, true);
  assert.equal(result.redirect, true);
  assert.equal(requests, 2);
});

test("one deadline covers the entire redirect chain and removes its header listener", async () => {
  let requests = 0;
  const listeners = new Set();
  const { PortScanner } = load(["shared.js", "scanner.js"], {
    chrome: { webRequest: { onHeadersReceived: {
      addListener(listener) { listeners.add(listener); }, removeListener(listener) { listeners.delete(listener); },
    } } },
    fetch: async (url, { signal }) => {
      requests++;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 650);
        signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
      });
      return new Response(null, { status: 302, headers: { location: `/hop-${requests}` } });
    },
  });
  const start = Date.now();
  const result = await PortScanner.probePort({ port: 8073, url: "http://localhost:8073" });
  assert.equal(result.alive, true);
  assert.equal(result.redirect, true);
  assert.equal(requests, 2);
  assert.ok(Date.now() - start < 2000);
  assert.equal(listeners.size, 0);
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
