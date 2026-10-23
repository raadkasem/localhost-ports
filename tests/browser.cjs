// Optional integration test: no packages, private Chrome profile, real extension APIs.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const https = require("node:https");
const { spawn, execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { root } = require("./helpers.cjs");

const executable = process.argv[2] || process.env.CHROME_PATH;
if (!executable) {
  console.error("Usage: npm run test:browser -- '/path/to/Chrome for Testing executable'");
  process.exit(1);
}

class CDP {
  constructor(socket) {
    this.socket = socket;
    this.pending = new Map();
    this.errors = [];
    this.next = 0;
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.method === "Runtime.exceptionThrown") this.errors.push(message.params);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
  }
  call(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  async evaluate(session, expression) {
    const response = await this.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session);
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  }
  close() {
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.socket.close();
  }
}

async function until(fn, label, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function main() {
  const base = path.join(os.tmpdir(), "opencode");
  fs.mkdirSync(base, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(base, "localhost-dashboard-"));
  const servers = [];
  let browser;
  let cdp;
  let logs = "";
  async function serve(handler, tls = false, host = "127.0.0.1") {
    const options = tls ? {
      key: fs.readFileSync(path.join(temporary, "key.pem")),
      cert: fs.readFileSync(path.join(temporary, "cert.pem")),
    } : undefined;
    const server = tls ? https.createServer(options, handler) : http.createServer(handler);
    server.on("clientError", (error, socket) => socket.destroy());
    servers.push(server);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, resolve);
    });
    return server.address().port;
  }
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=localhost", "-keyout", path.join(temporary, "key.pem"), "-out", path.join(temporary, "cert.pem")], { stdio: "ignore" });
    const title = '<img src=x onerror="globalThis.injected=true"> & Café';
    let holdHTML = false;
    let htmlRequests = 0;
    const heldResponses = [];
    function sendHTML(response) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<title>${title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</title>`);
    }
    function releaseHTML() {
      holdHTML = false;
      for (const response of heldResponses.splice(0)) sendHTML(response);
    }
    const htmlPort = await serve((request, response) => {
      htmlRequests++;
      if (holdHTML) heldResponses.push(response);
      else sendHTML(response);
    });
    const authPort = await serve((request, response) => { response.writeHead(401); response.end("Sign in"); });
    const forbiddenPort = await serve((request, response) => { response.writeHead(403); response.end(); });
    const airplayPort = await serve((request, response) => {
      response.writeHead(403, { server: "AirTunes/980.77.5", "X-Apple-ProcessingTime": "0" }); response.end();
    });
    let remoteRedirectRequests = 0;
    const destinationPort = await serve((request, response) => {
      remoteRedirectRequests++;
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<title>Discovered</title>");
    });
    const redirectPort = await serve((request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${destinationPort}/` }); response.end();
    });
    let loginRequests = 0;
    const redirectCookies = [];
    const loginPort = await serve((request, response) => {
      if (request.url === "/") {
        response.writeHead(302, { location: "/login", "set-cookie": "scanSession=must-not-send; Path=/" });
        response.end();
      } else {
        loginRequests++;
        redirectCookies.push(request.headers.cookie || "");
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<title>Local app &amp; Login</title>");
      }
    });
    const chainPort = await serve((request, response) => {
      if (request.url === "/auth/login") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<title>Chained login</title>");
      } else {
        response.writeHead(request.url === "/" ? 302 : 307, { location: request.url === "/" ? "/auth/start" : "login" });
        response.end();
      }
    });
    const escapePort = await serve((request, response) => {
      response.writeHead(302, { location: request.url === "/" ? "/login" : `http://127.0.0.1:${destinationPort}/` });
      response.end();
    });
    const loopPort = await serve((request, response) => {
      response.writeHead(302, { location: request.url === "/" ? "/loop" : "/" }); response.end();
    });
    const stalledPort = await serve((request, response) => {
      response.writeHead(200, { "content-type": "text/html", server: "Streaming API" });
      response.flushHeaders();
    });
    const tlsPort = await serve((request, response) => { response.end("TLS works"); }, true);
    const ipv6Port = await serve((request, response) => { response.end("IPv6 works"); }, false, "::1");
    const offlinePort = await serve((request, response) => response.end());
    const offlineServer = servers.at(-1);
    await new Promise((resolve) => offlineServer.close(resolve));
    const customPorts = [htmlPort, authPort, forbiddenPort, airplayPort, redirectPort, loginPort, chainPort,
      escapePort, loopPort, stalledPort, tlsPort, ipv6Port, offlinePort];

    browser = spawn(executable, [
      "--headless=new", "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking", "--disable-component-update", "--disable-sync",
      "--no-proxy-server",
      `--user-data-dir=${path.join(temporary, "profile")}`, "--remote-debugging-port=0",
      `--disable-extensions-except=${root}`, `--load-extension=${root}`,
      // Test fixture only: production never bypasses TLS certificate validation.
      "--ignore-certificate-errors", "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Chrome did not start: ${logs}`)), 10000);
      browser.once("error", (error) => { clearTimeout(timer); reject(error); });
      browser.stderr.on("data", (data) => {
        logs += data.toString();
        const match = logs.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    const socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    cdp = new CDP(socket);
    console.log(`Testing ${(await cdp.call("Browser.getVersion")).product}`);
    const extensionId = createHash("sha256").update(fs.realpathSync(root)).digest("hex").slice(0, 32)
      .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)));
    const target = await until(async () => {
      const { targetInfos } = await cdp.call("Target.getTargets");
      return targetInfos.find((target) => target.type === "service_worker" && target.url === `chrome-extension://${extensionId}/background.js`);
    }, "extension service worker");
    const extensionOrigin = new URL(target.url).origin;
    // URL.origin is 'null' for chrome-extension in Node; preserve the actual origin.
    const origin = extensionOrigin === "null" ? target.url.replace(/\/background.js$/, "") : extensionOrigin;
    const workerSession = (await cdp.call("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
    await cdp.call("Runtime.enable", {}, workerSession);
    await cdp.call("Runtime.runIfWaitingForDebugger", {}, workerSession);
    await until(() => cdp.evaluate(workerSession, "typeof mutationQueue !== 'undefined'"), "worker initialization");
    await cdp.evaluate(workerSession, `mutationQueue.then(() => chrome.storage.local.set(${JSON.stringify({
      customPorts, detectedPorts: [12345],
      portEndpoints: { [ipv6Port]: `http://[::1]:${ipv6Port}` },
    })}))`);
    const page = await cdp.call("Target.createTarget", { url: "about:blank" });
    const session = (await cdp.call("Target.attachToTarget", { targetId: page.targetId, flatten: true })).sessionId;
    await cdp.call("Page.enable", {}, session);
    await cdp.call("Emulation.setDeviceMetricsOverride", { width: 400, height: 600, deviceScaleFactor: 1, mobile: false }, session);
    await cdp.call("Page.addScriptToEvaluateOnNewDocument", {
      source: "globalThis.testErrors=[]; addEventListener('error', e => testErrors.push(e.message)); addEventListener('unhandledrejection', e => testErrors.push(String(e.reason)));",
    }, session);
    await cdp.call("Page.navigate", { url: `${origin}/popup.html` }, session);
    const evaluate = (expression) => cdp.evaluate(session, expression);
    await until(() => evaluate("document.querySelector('#port-list')?.getAttribute('aria-busy') === 'false' && document.querySelector('#refresh-btn')?.disabled === false"), "initial scan");
    const snapshot = await evaluate(`({
      errors: testErrors,
      count: document.querySelector('#active-count').textContent,
      rows: [...document.querySelectorAll('.port-card')].map(card => ({
        port: Number(card.querySelector('.port-number').textContent.slice(1)),
        label: card.querySelector('.port-label').textContent,
        url: card.querySelector('a').href,
        online: Boolean(card.querySelector('.port-dot.active')),
      })),
      injectedImages: document.querySelectorAll('.port-card img').length,
      injected: globalThis.injected || false,
      overflow: document.documentElement.scrollWidth > innerWidth,
      feedback: document.querySelector('#feedback').textContent,
    })`);
    assert.deepEqual(snapshot.errors, []);
    assert.equal(snapshot.feedback, "");
    assert.equal(snapshot.injectedImages, 0);
    assert.equal(snapshot.injected, false);
    assert.equal(snapshot.overflow, false);
    const row = (port) => snapshot.rows.find((row) => row.port === port);
    assert.equal(row(htmlPort).label, title);
    assert.equal(row(authPort).label, "HTTP 401");
    assert.equal(row(forbiddenPort).label, "HTTP 403");
    assert.equal(row(airplayPort), undefined);
    assert.equal(row(redirectPort).label, "Redirect");
    assert.equal(row(loginPort).label, "Local app & Login");
    assert.equal(row(loginPort).url, `http://127.0.0.1:${loginPort}/`);
    assert.equal(row(chainPort).label, "Chained login");
    assert.equal(row(escapePort).label, "Redirect");
    assert.equal(row(loopPort).label, "Redirect");
    assert.ok(loginRequests > 0);
    assert.ok(redirectCookies.every((cookie) => cookie === ""));
    assert.equal(await evaluate("chrome.webRequest.onHeadersReceived.hasListeners()"), false);
    assert.equal(remoteRedirectRequests, 0);
    assert.equal(row(stalledPort).label, "Streaming API");
    assert.ok(row(tlsPort).url.startsWith("https:"));
    assert.ok(row(ipv6Port).url.includes("[::1]"));
    assert.equal(row(offlinePort), undefined);
    assert.ok(snapshot.rows.every((row) => row.online));
    assert.equal(snapshot.count, `${snapshot.rows.length} active`);
    if (process.env.BROWSER_SCREENSHOT) {
      const { data } = await cdp.call("Page.captureScreenshot", { format: "png" }, session);
      fs.writeFileSync(process.env.BROWSER_SCREENSHOT, Buffer.from(data, "base64"));
    }
    await cdp.call("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    }, session);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.port-dot.active'), '::after').animationName"), "none");
    holdHTML = true;
    const requestsBeforeRefresh = htmlRequests;
    await evaluate(`document.querySelector('a[data-focus-key="port-link-${htmlPort}"]').focus();
      document.querySelector('#refresh-btn').click();`);
    await until(() => htmlRequests > requestsBeforeRefresh, "refresh revalidation request");
    assert.equal(await evaluate(`Boolean(document.querySelector('a[data-focus-key="port-link-${htmlPort}"]'))`), true);
    assert.equal(await evaluate("document.querySelector('#scan-status').classList.contains('hidden')"), true);
    assert.equal(await evaluate("document.activeElement.dataset.focusKey"), `port-link-${htmlPort}`);
    releaseHTML();
    await until(() => evaluate("!document.querySelector('#refresh-btn').disabled"), "keyboard focus after refresh");
    assert.equal(await evaluate("document.activeElement.dataset.focusKey"), `port-link-${htmlPort}`);
    console.log("PASS real extension loading, HTTP/HTTPS/IPv6, AirPlay exclusion, legitimate 403s, injection safety, stable refresh, counts and layout");
    console.log("PASS same-origin redirect titles/chains, root launch URLs, omitted cookies, redirect loops and blocked cross-origin hops");

    await until(() => evaluate(`chrome.storage.session.get(PortScanCache.KEY).then(data =>
      data[PortScanCache.KEY]?.results.some(result => result.port === ${htmlPort} && result.alive))`), "session snapshot");
    holdHTML = true;
    const requestsBeforeReload = htmlRequests;
    await cdp.call("Page.reload", {}, session);
    await until(() => htmlRequests > requestsBeforeReload, "reopened popup revalidation request");
    assert.equal(await evaluate(`Boolean(document.querySelector('a[data-focus-key="port-link-${htmlPort}"]'))`), true);
    assert.equal(await evaluate("document.querySelector('#scan-status').classList.contains('hidden')"), true);
    assert.equal(await evaluate("document.querySelector('#port-list').getAttribute('aria-busy')"), "true");
    releaseHTML();
    await until(() => evaluate("!document.querySelector('#refresh-btn').disabled"), "quiet reopen revalidation");
    console.log("PASS recent results survive reopening while fresh checks run without a flashing scan banner");

    for (const value of ["1e3", "1.5", "0", "65536", ""]) {
      const error = await evaluate(`document.querySelector('#custom-port').value=${JSON.stringify(value)};
        document.querySelector('#add-port-form').dispatchEvent(new Event('submit', {bubbles:true, cancelable:true}));
        document.querySelector('#feedback').textContent`);
      assert.match(error, /whole port number/);
    }
    await evaluate(`document.querySelector('.port-remove[data-port="${authPort}"]').focus();
      document.querySelector('.port-remove[data-port="${authPort}"]').click()`);
    await until(() => evaluate(`!document.querySelector('.port-remove[data-port="${authPort}"]') && !document.querySelector('#add-btn').disabled`), "online custom port removal");
    assert.equal(await evaluate("document.activeElement.id"), "custom-port");
    await evaluate(`document.querySelector('#custom-port').value='${authPort}';
      document.querySelector('#add-port-form').dispatchEvent(new Event('submit', {bubbles:true, cancelable:true}));
      document.querySelector('#add-port-form').dispatchEvent(new Event('submit', {bubbles:true, cancelable:true}));`);
    await until(() => evaluate(`document.querySelector('.port-remove[data-port="${authPort}"]') && !document.querySelector('#add-btn').disabled && document.querySelector('#scan-status').classList.contains('hidden')`), "saved online port");
    assert.equal(await evaluate(`document.querySelectorAll('.port-remove[data-port="${authPort}"]').length`), 1);
    assert.equal(await evaluate(`document.querySelectorAll('.port-remove[data-port="${offlinePort}"]').length`), 0);
    assert.equal(await evaluate(`chrome.storage.local.get('customPorts').then(state => state.customPorts.filter(port => port === ${authPort}).length)`), 1);
    console.log("PASS strict validation, online removal, hidden offline saves and rapid duplicate submissions");

    const livePort = destinationPort;
    const livePage = await cdp.call("Target.createTarget", { url: "about:blank" });
    const liveSession = (await cdp.call("Target.attachToTarget", { targetId: livePage.targetId, flatten: true })).sessionId;
    await cdp.call("Page.enable", {}, liveSession);
    const navigation = await cdp.call("Page.navigate", { url: `http://127.0.0.1:${livePort}/visited?secret=yes` }, liveSession);
    assert.equal(navigation.errorText, undefined);
    await until(() => evaluate(`Boolean(document.querySelector('.detected-add[data-port="${livePort}"]'))`), "live discovery");
    assert.equal(await cdp.evaluate(workerSession, "chrome.action.getBadgeText({})"), "2");
    await evaluate(`document.querySelector('.detected-dismiss[data-port="${livePort}"]').click()`);
    await until(() => evaluate(`!document.querySelector('.detected-add[data-port="${livePort}"]') && !document.querySelector('#add-btn').disabled`), "dismissal");
    await cdp.call("Page.navigate", { url: `http://127.0.0.1:${livePort}/again` }, liveSession);
    await evaluate("document.querySelector('#refresh-btn').click()");
    await until(() => evaluate("!document.querySelector('#refresh-btn').disabled"), "refresh");
    assert.equal(await evaluate(`Boolean(document.querySelector('.detected-add[data-port="${livePort}"]'))`), false);
    await cdp.call("Page.reload", {}, session);
    await until(() => evaluate("document.querySelector('#port-list')?.getAttribute('aria-busy') === 'false' && document.querySelector('#refresh-btn')?.disabled === false"), "popup reload");
    assert.equal(await evaluate(`document.querySelectorAll('.port-remove[data-port="${offlinePort}"]').length`), 0);
    assert.equal(await evaluate(`chrome.storage.local.get('customPorts').then(state => state.customPorts.includes(${offlinePort}))`), true);
    assert.equal(await evaluate(`Boolean(document.querySelector('.detected-add[data-port="${livePort}"]'))`), false);
    await new Promise((resolve) => offlineServer.listen(offlinePort, "127.0.0.1", resolve));
    await evaluate("document.querySelector('#refresh-btn').click()");
    await until(() => evaluate(`!document.querySelector('#refresh-btn').disabled && Boolean(document.querySelector('.port-remove[data-port="${offlinePort}"]'))`), "saved port becoming online");
    offlineServer.closeAllConnections();
    await new Promise((resolve) => offlineServer.close(resolve));
    await evaluate("document.querySelector('#refresh-btn').click()");
    await until(() => evaluate("!document.querySelector('#refresh-btn').disabled"), "saved port going offline");
    assert.equal(await evaluate(`document.querySelectorAll('.port-remove[data-port="${offlinePort}"]').length`), 0);
    assert.deepEqual(await evaluate("testErrors"), []);
    assert.deepEqual(cdp.errors, []);
    console.log("PASS live discovery, persistent saves/dismissal, refresh/reopen, and online/offline visibility transitions");
    console.log("Browser integration tests passed.");
  } catch (error) {
    if (cdp) console.error(JSON.stringify(cdp.errors));
    console.error(logs.slice(-5000));
    throw error;
  } finally {
    if (cdp) {
      try { await cdp.call("Browser.close"); } catch {}
      cdp.close();
    }
    if (browser && browser.exitCode === null) {
      const exited = new Promise((resolve) => browser.once("exit", resolve));
      browser.kill("SIGTERM");
      await exited;
    }
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    // Only remove the disposable directory created by this invocation.
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
