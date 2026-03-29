const LOCAL_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0"];

const DEFAULT_PORTS = new Set([
  3000, 3001, 4000, 4200, 5000, 5173, 5500,
  8000, 8080, 8443, 8888, 9000, 9090,
]);

// Watch for localhost tabs and detect new ports
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) return;

  const port = extractLocalPort(tab.url);
  if (port === null) return;

  // Skip if it's a default port
  if (DEFAULT_PORTS.has(port)) return;

  const stored = await chrome.storage.local.get(["customPorts", "detectedPorts"]);
  const customPorts = stored.customPorts || [];
  const detectedPorts = stored.detectedPorts || [];

  // Skip if already known
  if (customPorts.includes(port) || detectedPorts.includes(port)) return;

  // New port discovered — save it and show badge
  detectedPorts.push(port);
  await chrome.storage.local.set({ detectedPorts });

  updateBadge(detectedPorts.length);
});

function extractLocalPort(url) {
  try {
    const u = new URL(url);
    if (!LOCAL_HOSTS.includes(u.hostname)) return null;
    const port = parseInt(u.port, 10);
    if (!port || isNaN(port)) return null;
    return port;
  } catch {
    return null;
  }
}

async function updateBadge(count) {
  if (count > 0) {
    await chrome.action.setBadgeText({ text: String(count) });
    await chrome.action.setBadgeBackgroundColor({ color: "#6D5BD0" });
    await chrome.action.setBadgeTextColor({ color: "#FFFFFF" });
  } else {
    await chrome.action.setBadgeText({ text: "" });
  }
}

// Restore badge on startup
chrome.runtime.onStartup.addListener(async () => {
  const stored = await chrome.storage.local.get("detectedPorts");
  const detected = stored.detectedPorts || [];
  updateBadge(detected.length);
});

// Also on install
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get("detectedPorts");
  const detected = stored.detectedPorts || [];
  updateBadge(detected.length);
});
