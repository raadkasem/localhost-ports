const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { root, load, plain } = require("./helpers.cjs");
const { LocalPorts } = load(["shared.js"]);

test("strict port parsing accepts only whole ports in range", () => {
  for (const value of [1, 65535, "3000", " 8080 ", "03000"]) assert.notEqual(LocalPorts.parsePort(value), null);
  for (const value of [0, -1, 65536, 1.5, "3000abc", "1e3", "1.5", "", null, true, {}, []]) {
    assert.equal(LocalPorts.parsePort(value), null, String(value));
  }
});

test("endpoint parsing is limited to HTTP(S) loopback origins and includes implicit ports", () => {
  for (const [url, port, origin] of [
    ["http://localhost/path?token=secret", 80, "http://localhost"],
    ["https://localhost/", 443, "https://localhost"],
    ["https://127.0.0.1:9443/test", 9443, "https://127.0.0.1:9443"],
    ["http://[::1]:1234/", 1234, "http://[::1]:1234"],
    ["http://0.0.0.0:8081/", 8081, "http://0.0.0.0:8081"],
  ]) assert.deepEqual(plain(LocalPorts.parseEndpoint(url)), { port, url: origin });
  for (const url of ["ftp://localhost:1234", "ws://localhost:1234", "http://localhost.evil:1234", "http://example.com", "http://user:pass@localhost:3000", "http://localhost:0", "not a URL"]) {
    assert.equal(LocalPorts.parseEndpoint(url), null);
  }
});

test("legacy and corrupt storage is normalized and deduplicated without trusting URLs", () => {
  assert.deepEqual(plain(LocalPorts.normalizeState({
    customPorts: [3000, 1234, "1234", 2345, "<img>", null],
    detectedPorts: [1234, 3456, 4567, 3456],
    dismissedPorts: [4567, 3000],
    portEndpoints: { 1234: "https://localhost:1234/path", 2345: "https://evil.test:2345", 3456: "http://localhost:9999" },
  })), {
    customPorts: [1234, 2345], detectedPorts: [3456], dismissedPorts: [4567],
    portEndpoints: { 1234: "https://localhost:1234" },
  });
  assert.deepEqual(plain(LocalPorts.normalizeState({ customPorts: {}, detectedPorts: "bad" })).customPorts, []);
});

test("manifest uses exact local hosts, no tabs permission, and valid icon sizes", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json")));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.deepEqual(manifest.host_permissions.sort(), plain(LocalPorts.HOST_PATTERNS).sort());
  for (const [size, file] of Object.entries(manifest.icons)) {
    const png = fs.readFileSync(path.join(root, file));
    assert.equal(png.toString("hex", 0, 8), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), Number(size));
    assert.equal(png.readUInt32BE(20), Number(size));
  }
});
