const DEFAULT_PORTS = [
  3000, 3001, 4000, 4200, 5000, 5173, 5500,
  8000, 8080, 8443, 8888, 9000, 9090,
];

document.addEventListener("DOMContentLoaded", async () => {
  const scanStatus = document.getElementById("scan-status");
  const portList = document.getElementById("port-list");
  const customPortInput = document.getElementById("custom-port");
  const addBtn = document.getElementById("add-btn");

  // External links
  document.querySelectorAll("a[target='_blank']").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: link.href });
    });
  });

  // Load custom ports from storage
  const stored = await chrome.storage.local.get("customPorts");
  const customPorts = stored.customPorts || [];

  // Build full list to scan
  const allPorts = [
    ...DEFAULT_PORTS.map((p) => ({ port: p, custom: false })),
    ...customPorts.map((p) => ({ port: p, custom: true })),
  ];

  // Scan all ports concurrently — detect title for active ones
  const results = await Promise.all(allPorts.map((entry) => probePort(entry)));
  const active = results.filter((r) => r.alive);

  scanStatus.classList.add("hidden");

  // Show active count in header
  const activeCountEl = document.getElementById("active-count");
  if (active.length > 0) {
    activeCountEl.textContent = `${active.length} active`;
    activeCountEl.classList.add("visible");
  }

  if (active.length === 0) {
    portList.innerHTML = `
      <div class="empty-state">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
        </svg>
        <div>No active services found.<br>Start a local server or add a custom port.</div>
      </div>`;
  } else {
    renderPorts(active);
  }

  // Add custom port
  addBtn.addEventListener("click", () => addCustomPort());
  customPortInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addCustomPort();
  });

  async function addCustomPort() {
    const val = parseInt(customPortInput.value, 10);
    if (!val || val < 1 || val > 65535) return;
    if (allPorts.some((p) => p.port === val)) {
      customPortInput.value = "";
      return;
    }

    customPorts.push(val);
    await chrome.storage.local.set({ customPorts });

    const entry = { port: val, custom: true };
    const result = await probePort(entry);
    active.push(result);
    renderPorts(active);
    customPortInput.value = "";
  }

  function renderPorts(ports) {
    portList.innerHTML = ports
      .map((p) => {
        const dotClass = p.alive ? "active" : "custom";
        return `
          <div class="port-card" data-url="${p.url}">
            <div class="port-dot ${dotClass}"></div>
            <div class="port-info">
              <div class="port-number">:${p.port}</div>
              <div class="port-url">${p.url}</div>
            </div>
            <span class="port-label">${p.label}</span>
            ${p.custom ? `<button class="port-remove" data-port="${p.port}" title="Remove">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>` : ""}
            <button class="port-open" data-url="${p.url}" title="Open">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            </button>
          </div>`;
      })
      .join("");

    // Click card to open
    portList.querySelectorAll(".port-card").forEach((card) => {
      card.addEventListener("click", (e) => {
        if (e.target.closest(".port-remove") || e.target.closest(".port-open")) return;
        chrome.tabs.create({ url: card.dataset.url });
      });
    });

    // Open button
    portList.querySelectorAll(".port-open").forEach((btn) => {
      btn.addEventListener("click", () => {
        chrome.tabs.create({ url: btn.dataset.url });
      });
    });

    // Remove custom port
    portList.querySelectorAll(".port-remove").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const port = parseInt(btn.dataset.port, 10);
        const idx = customPorts.indexOf(port);
        if (idx > -1) customPorts.splice(idx, 1);
        await chrome.storage.local.set({ customPorts });

        const activeIdx = active.findIndex((p) => p.port === port);
        if (activeIdx > -1) active.splice(activeIdx, 1);

        if (active.length === 0) {
          portList.innerHTML = `<div class="empty-state">No active services found.</div>`;
        } else {
          renderPorts(active);
        }
      });
    });
  }
});

const HOSTS = ["127.0.0.1", "localhost"];

/**
 * Probe a port on both 127.0.0.1 and localhost in parallel.
 * Uses a real fetch (not no-cors) so we can tell which actually responds.
 */
async function probePort(entry) {
  const results = await Promise.allSettled(
    HOSTS.map(async (host) => {
      const url = `http://${host}:${entry.port}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);

      try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        return { url, host, res };
      } catch (err) {
        clearTimeout(timeout);
        throw err;
      }
    })
  );

  // Pick the first host that succeeded
  for (const r of results) {
    if (r.status === "fulfilled") {
      const { url } = r.value;
      const label = await detectLabel(url, entry.port);
      return { ...entry, alive: true, label, url };
    }
  }

  // If normal fetch failed for both, try no-cors as fallback (some servers block CORS)
  for (const host of HOSTS) {
    const url = `http://${host}:${entry.port}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);

    try {
      await fetch(url, { mode: "no-cors", signal: controller.signal });
      clearTimeout(timeout);
      return { ...entry, alive: true, label: `Port ${entry.port}`, url };
    } catch {
      clearTimeout(timeout);
    }
  }

  return { ...entry, alive: false, label: `Port ${entry.port}`, url: `http://localhost:${entry.port}` };
}

/**
 * Fetch the HTML and extract <title> to identify what's running.
 */
async function detectLabel(url, port) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      return guessLabel(port, res);
    }

    const text = await res.text();
    const match = text.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (match && match[1].trim()) {
      return match[1].trim().substring(0, 30);
    }

    return guessLabel(port, res);
  } catch {
    clearTimeout(timeout);
    return `Port ${port}`;
  }
}

function guessLabel(port, res) {
  const server = res?.headers?.get("server") || "";
  if (server) return server.substring(0, 25);

  const fallbacks = {
    8888: "Jupyter",
    9090: "Prometheus",
  };

  return fallbacks[port] || `Port ${port}`;
}
