const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
function load(files, extra = {}) {
  const context = vm.createContext({
    URL, AbortController, TextDecoder, setTimeout, clearTimeout, console,
    // Browser smoke tests exercise real DOMParser/entity decoding.
    DOMParser: class {
      parseFromString(html) {
        return { title: html.match(/<title>([\s\S]*)<\/title>/i)?.[1].replace(/&amp;/g, "&") || "" };
      }
    },
    ...extra,
  });
  for (const file of files) vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
  return context;
}
const plain = (value) => JSON.parse(JSON.stringify(value));
function event() {
  const listeners = [];
  return {
    listeners,
    addListener(fn) { listeners.push(fn); },
    emit(...args) { return listeners.map((fn) => fn(...args)); },
  };
}

function worker(initial = {}, tabs = []) {
  let data = plain(initial);
  let failWrite = false;
  const badges = [];
  const changed = event();
  const chrome = {
    runtime: { id: "test-extension", onMessage: event(), onStartup: event(), onInstalled: event() },
    tabs: { onUpdated: event(), query: async () => tabs },
    action: {
      setBadgeText: async ({ text }) => { badges.push(text); },
      setBadgeBackgroundColor: async () => {},
    },
    storage: {
      onChanged: changed,
      local: {
        async get() {
          await new Promise((resolve) => setImmediate(resolve));
          return plain(data);
        },
        async set(next) {
          if (failWrite) { failWrite = false; throw new Error("Storage unavailable"); }
          const changes = {};
          for (const [key, value] of Object.entries(next)) {
            if (JSON.stringify(data[key]) !== JSON.stringify(value)) changes[key] = { oldValue: data[key], newValue: value };
          }
          data = { ...data, ...plain(next) };
          changed.emit(changes, "local");
        },
      },
    },
  };
  const context = load(["shared.js"], { chrome, importScripts() {} });
  vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), context);
  return {
    context, chrome, badges,
    data: () => data,
    failNextWrite() { failWrite = true; },
    async flush() {
      // A write can enqueue a badge sync while a transaction is being processed.
      for (let i = 0; i < 4; i++) await vm.runInContext("mutationQueue", context);
    },
    command(action, port) {
      return new Promise((resolve) => chrome.runtime.onMessage.emit(
        { type: "local-ports", action, port }, { id: chrome.runtime.id }, resolve
      ));
    },
  };
}

module.exports = { root, load, plain, worker };
