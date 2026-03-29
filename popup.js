const DEFAULT_PORTS = [
  3000, 3001, 4000, 4200, 5000, 5173, 5500,
  8000, 8080, 8443, 8888, 9000, 9090,
];

const HOSTS = ["127.0.0.1", "localhost"];

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

  const stored = await chrome.storage.local.get(["customPorts", "detectedPorts"]);
  const customPorts = stored.customPorts || [];
  const detectedPorts = stored.detectedPorts || [];

  const allPorts = [
    ...DEFAULT_PORTS.map((p) => ({ port: p, custom: false })),
    ...customPorts.map((p) => ({ port: p, custom: true })),
  ];

  // Scan all ports concurrently — single fetch per port per host
  const results = await Promise.all(allPorts.map((entry) => probePort(entry)));
  const active = results.filter((r) => r.alive);

  scanStatus.classList.add("hidden");

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

  // Show detected ports
  renderDetected();

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

    activeCountEl.textContent = `${active.length} active`;
    activeCountEl.classList.add("visible");

    customPortInput.value = "";
  }

  function renderDetected() {
    const detectedSection = document.getElementById("detected-section");
    const detectedList = document.getElementById("detected-list");

    if (detectedPorts.length === 0) {
      detectedSection.classList.add("hidden");
      return;
    }

    detectedSection.classList.remove("hidden");
    detectedList.innerHTML = detectedPorts
      .map((port) => `
        <div class="detected-row">
          <span class="detected-port">:${port}</span>
          <div class="detected-actions">
            <button class="detected-add" data-port="${port}" title="Add to list">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              Add
            </button>
            <button class="detected-dismiss" data-port="${port}" title="Dismiss">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>`)
      .join("");

    // Add button — move to custom ports and re-scan
    detectedList.querySelectorAll(".detected-add").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const port = parseInt(btn.dataset.port, 10);

        // Move from detected to custom
        const idx = detectedPorts.indexOf(port);
        if (idx > -1) detectedPorts.splice(idx, 1);
        customPorts.push(port);
        await chrome.storage.local.set({ customPorts, detectedPorts });
        updateExtBadge(detectedPorts.length);

        // Probe and add to active list
        const result = await probePort({ port, custom: true });
        active.push(result);
        renderPorts(active);
        activeCountEl.textContent = `${active.length} active`;
        activeCountEl.classList.add("visible");
        renderDetected();
      });
    });

    // Dismiss button — remove from detected
    detectedList.querySelectorAll(".detected-dismiss").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const port = parseInt(btn.dataset.port, 10);
        const idx = detectedPorts.indexOf(port);
        if (idx > -1) detectedPorts.splice(idx, 1);
        await chrome.storage.local.set({ detectedPorts });
        updateExtBadge(detectedPorts.length);
        renderDetected();
      });
    });
  }

  function updateExtBadge(count) {
    if (count > 0) {
      chrome.action.setBadgeText({ text: String(count) });
    } else {
      chrome.action.setBadgeText({ text: "" });
    }
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

    portList.querySelectorAll(".port-card").forEach((card) => {
      card.addEventListener("click", (e) => {
        if (e.target.closest(".port-remove") || e.target.closest(".port-open")) return;
        chrome.tabs.create({ url: card.dataset.url });
      });
    });

    portList.querySelectorAll(".port-open").forEach((btn) => {
      btn.addEventListener("click", () => {
        chrome.tabs.create({ url: btn.dataset.url });
      });
    });

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
          activeCountEl.classList.remove("visible");
        } else {
          renderPorts(active);
          activeCountEl.textContent = `${active.length} active`;
        }
      });
    });
  }
});

/**
 * Probe a port — fetches both 127.0.0.1 and localhost in parallel.
 * Prefers 2xx responses over error codes (e.g. 403).
 * If both succeed, prefers 127.0.0.1.
 */
async function probePort(entry) {
  const results = await Promise.allSettled(
    HOSTS.map(async (host) => {
      const url = `http://${host}:${entry.port}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 800);

      try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        return { url, res, ok: res.ok };
      } catch (err) {
        clearTimeout(timeout);
        throw err;
      }
    })
  );

  const fulfilled = results
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value);

  if (fulfilled.length === 0) {
    return { ...entry, alive: false, label: `Port ${entry.port}`, url: "" };
  }

  // Prefer a 2xx response, fall back to any response
  const pick = fulfilled.find((r) => r.ok) || fulfilled[0];

  // Only show as alive if we got a 2xx
  if (!pick.ok) {
    return { ...entry, alive: false, label: `Port ${entry.port}`, url: "" };
  }

  const label = await extractLabel(pick.res, entry.port);
  return { ...entry, alive: true, label, url: pick.url };
}

/**
 * Extract label from the already-fetched response (no extra request).
 */
async function extractLabel(res, port) {
  try {
    const contentType = res.headers.get("content-type") || "";
    const server = res.headers.get("server") || "";

    if (contentType.includes("text/html")) {
      const text = await res.text();
      const match = text.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (match && match[1].trim()) {
        return match[1].trim().substring(0, 25);
      }
    }

    if (server) return server.substring(0, 25);
  } catch {}

  return `Port ${port}`;
}
