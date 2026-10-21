const test = require("node:test");
const assert = require("node:assert/strict");
const { load, plain } = require("./helpers.cjs");
const { PortScanCache } = load(["shared.js", "scan-cache.js"]);
const now = 1000000;
const entries = [{ port: 3000 }, { port: 1234, custom: true, url: "https://localhost:1234" }];
const result = {
  port: 3000, alive: true, url: "http://127.0.0.1:3000", label: "App",
  status: 200, ok: true, redirect: false, checkedAt: now - 1000, preferredOrigin: null,
};
const restore = (results, configured = entries) => PortScanCache.restore({ version: 1, results }, configured, now);

test("recent results round-trip without changing their original check time", () => {
  const cached = PortScanCache.snapshot(new Map([[3000, result]]));
  const restored = PortScanCache.restore(cached, entries, now);
  assert.equal(restored.size, 1);
  assert.equal(restored.get(3000).label, "App");
  assert.equal(restored.get(3000).checkedAt, result.checkedAt);
  assert.equal(PortScanCache.restore(PortScanCache.snapshot(restored), entries, now + PortScanCache.MAX_AGE_MS).size, 0);
});

test("expired, future, corrupt, and unversioned snapshots are ignored", () => {
  for (const checkedAt of [now - PortScanCache.MAX_AGE_MS, now + 1, "recent", null]) {
    assert.equal(restore([{ ...result, checkedAt }]).size, 0);
  }
  for (const cached of [undefined, null, {}, { results: [result] }, { version: 1, results: {} }]) {
    assert.equal(PortScanCache.restore(cached, entries, now).size, 0);
  }
  assert.equal(restore([null, 0, {}, { ...result, alive: "true" }]).size, 0);
});

test("removed ports and changed remembered origins invalidate cached cards", () => {
  assert.equal(restore([result], []).size, 0);
  assert.equal(restore([result], [{ port: 3000, url: "https://localhost:3000" }]).size, 0);
  const remembered = { ...result, port: 1234, url: "https://localhost:1234", preferredOrigin: "https://localhost:1234" };
  assert.equal(restore([remembered]).size, 1);
  assert.equal(restore([{ ...remembered, preferredOrigin: null }]).size, 0);
});

test("cached launch URLs and status values are validated instead of trusted", () => {
  for (const url of ["https://example.com:3000", "javascript:alert(1)", "http://localhost:4000", "http://user:pass@localhost:3000"]) {
    assert.equal(restore([{ ...result, url }]).size, 0);
  }
  for (const status of [undefined, 0, 199, 600, "200"]) {
    assert.equal(restore([{ ...result, status }]).size, 0);
  }
  assert.equal(restore([{ ...result, status: 403, ok: true }]).get(3000).ok, false);
  assert.equal(restore([{ ...result, status: 0, redirect: true }]).size, 1);
});

test("offline results are cached without becoming active and labels stay bounded", () => {
  const offline = restore([{ ...result, alive: false, status: undefined, ok: true }]).get(3000);
  assert.equal(offline.alive, false);
  assert.equal(offline.ok, false);
  assert.equal(offline.status, undefined);
  assert.equal(restore([{ ...result, label: "x".repeat(1000) }]).get(3000).label.length, 80);
  assert.deepEqual(plain(PortScanCache.snapshot(new Map())), { version: 1, results: [] });
});
