const test = require("node:test");
const assert = require("node:assert/strict");
const { worker } = require("./helpers.cjs");

test("simultaneous tab discoveries and edits cannot overwrite each other", async () => {
  const w = worker();
  for (let port = 10000; port < 10020; port++) {
    w.chrome.tabs.onUpdated.emit(port, { url: `http://localhost:${port}/` }, {});
  }
  const saved = await w.command("add", 10030);
  await w.flush();
  assert.equal(saved.ok, true);
  assert.equal(w.data().detectedPorts.length, 20);
  assert.deepEqual(w.data().customPorts, [10030]);
  assert.equal(w.badges.at(-1), "20");
});

test("add/dismiss/remove are idempotent, persist dismissal, and synchronize the badge", async () => {
  const w = worker({ detectedPorts: [1234] });
  await Promise.all([w.command("add", 1234), w.command("add", 1234)]);
  assert.deepEqual(w.data().customPorts, [1234]);
  assert.deepEqual(w.data().detectedPorts, []);
  await w.command("remove", 1234);
  w.chrome.tabs.onUpdated.emit(1, { status: "complete" }, { url: "https://localhost:1234/" });
  await w.flush();
  assert.deepEqual(w.data().detectedPorts, []);
  assert.deepEqual(w.data().dismissedPorts, [1234]);
  await w.command("add", 1234);
  await w.command("add", 3000);
  await w.flush();
  assert.deepEqual(w.data().customPorts, [1234]);
  assert.deepEqual(w.data().dismissedPorts, []);
  assert.equal(w.badges.at(-1), "");
});

test("existing tabs and default-port HTTPS origins are discovered without storing paths", async () => {
  const w = worker({}, [
    { url: "https://localhost:8443/private?secret=yes" },
    { url: "http://[::1]:1234/" },
    { url: "https://localhost/" },
    { url: "ftp://localhost:2345" },
    { url: "https://example.com" },
  ]);
  const result = await w.command("getState");
  assert.equal(result.ok, true);
  assert.deepEqual(w.data().detectedPorts, [443, 1234]);
  assert.equal(w.data().portEndpoints[8443], "https://localhost:8443");
  assert.equal(w.data().portEndpoints[1234], "http://[::1]:1234");
});

test("bad input and a storage failure do not poison the mutation queue", async () => {
  const w = worker();
  assert.equal((await w.command("add", "1.5")).ok, false);
  assert.equal((await w.command("unknown", 1234)).ok, false);
  w.failNextWrite();
  const failed = await w.command("add", 1234);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /Storage/);
  assert.equal((await w.command("add", 2345)).ok, true);
  assert.deepEqual(w.data().customPorts, [2345]);
});

test("install/startup migrate legacy data and ignore nonlocal navigation", async () => {
  const w = worker({ customPorts: [1234, 1234, 3000], detectedPorts: [1234, 2345] });
  w.chrome.runtime.onInstalled.emit();
  w.chrome.runtime.onStartup.emit();
  w.chrome.tabs.onUpdated.emit(1, { url: "https://example.com:7777/" }, {});
  await w.flush();
  assert.deepEqual(w.data().customPorts, [1234]);
  assert.deepEqual(w.data().detectedPorts, [2345]);
  assert.equal(w.badges.at(-1), "1");
});

test("pending local navigation is discovered even when a page never finishes loading", async () => {
  const w = worker();
  w.chrome.tabs.onUpdated.emit(1, { status: "loading" }, { pendingUrl: "http://localhost:1234/" });
  await w.flush();
  assert.deepEqual(w.data().detectedPorts, [1234]);
});

test("external saves or dismissals also recompute the normalized badge count", async () => {
  const w = worker({ detectedPorts: [1234, 1235] });
  await w.chrome.storage.local.set({ customPorts: [1234] });
  await w.flush();
  assert.equal(w.badges.at(-1), "1");
  await w.chrome.storage.local.set({ dismissedPorts: [1235] });
  await w.flush();
  assert.equal(w.badges.at(-1), "");
});
