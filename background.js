importScripts("shared.js");

// All read/modify/write operations pass through this worker, including popup edits.
let mutationQueue = Promise.resolve();
let badgeSyncQueued = false;
let lastBadgeCount;
function enqueue(task) {
  const pending = mutationQueue.then(task);
  mutationQueue = pending.catch(() => {});
  return pending;
}

async function updateBadge(count) {
  if (count === lastBadgeCount) return;
  try {
    await chrome.action.setBadgeText({ text: count ? String(count) : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#6D5BD0" });
    if (chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ color: "#FFFFFF" });
    }
    lastBadgeCount = count;
  } catch (error) {
    console.warn("Could not update the discovery badge:", error);
  }
}

function discover(state, endpoint) {
  state.portEndpoints[endpoint.port] = endpoint.url;
  if (!LocalPorts.DEFAULT_PORTS.includes(endpoint.port) &&
      !state.customPorts.includes(endpoint.port) &&
      !state.dismissedPorts.includes(endpoint.port) &&
      !state.detectedPorts.includes(endpoint.port)) {
    state.detectedPorts.push(endpoint.port);
  }
}

async function transact(edit) {
  const stored = await chrome.storage.local.get(LocalPorts.STORAGE_KEYS);
  const state = LocalPorts.normalizeState(stored);
  await edit(state);
  const next = LocalPorts.normalizeState(state);
  if (LocalPorts.STORAGE_KEYS.some((key) => JSON.stringify(stored[key]) !== JSON.stringify(next[key]))) {
    await chrome.storage.local.set(next);
  }
  await updateBadge(next.detectedPorts.length);
  return next;
}

async function discoverExisting(state) {
  const tabs = await chrome.tabs.query({ url: LocalPorts.HOST_PATTERNS });
  for (const tab of tabs) {
    const endpoint = LocalPorts.parseEndpoint(tab.pendingUrl || tab.url);
    if (endpoint) discover(state, endpoint);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || (["loading", "complete"].includes(changeInfo.status) ? tab.pendingUrl || tab.url : null);
  const endpoint = LocalPorts.parseEndpoint(url);
  if (!endpoint) return;
  enqueue(() => transact((state) => discover(state, endpoint)))
    .catch((error) => console.warn("Could not save a discovered port:", error));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.type !== "local-ports") return false;
  enqueue(() => transact(async (state) => {
    if (message.action === "getState") {
      await discoverExisting(state);
      return;
    }
    const port = LocalPorts.parsePort(message.port);
    if (port === null) throw new Error("Enter a whole port number from 1 to 65535.");
    if (message.action === "add") {
      if (!LocalPorts.DEFAULT_PORTS.includes(port)) state.customPorts.push(port);
      state.detectedPorts = state.detectedPorts.filter((value) => value !== port);
      state.dismissedPorts = state.dismissedPorts.filter((value) => value !== port);
    } else if (message.action === "remove" || message.action === "dismiss") {
      if (message.action === "remove") {
        state.customPorts = state.customPorts.filter((value) => value !== port);
      }
      state.detectedPorts = state.detectedPorts.filter((value) => value !== port);
      state.dismissedPorts.push(port);
      delete state.portEndpoints[port];
    } else {
      throw new Error("Unknown dashboard action.");
    }
  })).then(
    (state) => sendResponse({ ok: true, state }),
    (error) => sendResponse({ ok: false, error: error.message || "Could not save ports. Please try again." })
  );
  return true;
});

// Storage events also keep badges correct if state is changed outside the popup.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || badgeSyncQueued ||
      !["customPorts", "detectedPorts", "dismissedPorts"].some((key) => key in changes)) return;
  badgeSyncQueued = true;
  enqueue(async () => {
    try {
      const stored = await chrome.storage.local.get(LocalPorts.STORAGE_KEYS);
      await updateBadge(LocalPorts.normalizeState(stored).detectedPorts.length);
    } finally {
      badgeSyncQueued = false;
    }
  }).catch((error) => console.warn("Could not restore the discovery badge:", error));
});

function initialize() {
  return enqueue(() => transact(discoverExisting))
    .catch((error) => console.warn("Could not initialize local ports:", error));
}
chrome.runtime.onStartup.addListener(initialize);
chrome.runtime.onInstalled.addListener(initialize);
