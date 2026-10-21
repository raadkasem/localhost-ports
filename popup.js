document.addEventListener("DOMContentLoaded", () => {
  const scanStatus = document.getElementById("scan-status");
  const portList = document.getElementById("port-list");
  const input = document.getElementById("custom-port");
  const addButton = document.getElementById("add-btn");
  const refreshButton = document.getElementById("refresh-btn");
  const message = document.getElementById("feedback");
  const detectedSection = document.getElementById("detected-section");
  const detectedList = document.getElementById("detected-list");
  const activeCount = document.getElementById("active-count");
  let state = LocalPorts.normalizeState();
  const results = new Map();
  let scanController;
  let renderFrame;
  let cacheTimer;
  let editing = false;
  let initialized = false;
  let refreshing = false;

  function feedback(text = "", invalid = false) {
    message.textContent = text;
    input.setAttribute("aria-invalid", String(invalid));
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className, text, label, port) {
    const node = element("button", className, text);
    node.type = "button";
    node.title = label;
    node.setAttribute("aria-label", label);
    node.dataset.port = port;
    node.dataset.focusKey = `${className}-${port}`;
    node.disabled = editing;
    return node;
  }

  function replaceContents(container, fragment) {
    const active = document.activeElement;
    const key = container.contains(active) ? active.dataset.focusKey : null;
    container.replaceChildren(fragment);
    if (key) {
      const replacement = [...container.querySelectorAll("[data-focus-key]")]
        .find((node) => node.dataset.focusKey === key);
      (replacement || input).focus({ preventScroll: true });
    }
  }

  function entries() {
    const customPorts = new Set(state.customPorts);
    return [...LocalPorts.DEFAULT_PORTS, ...state.customPorts].sort((a, b) => a - b)
      .map((port) => ({ port, custom: customPorts.has(port), url: state.portEndpoints[port] }));
  }

  function renderPorts() {
    const fragment = document.createDocumentFragment();
    const online = entries().filter(({ port }) => results.get(port)?.alive);
    activeCount.textContent = `${online.length} active`;
    activeCount.classList.toggle("visible", online.length > 0);
    for (const entry of online) {
      const result = results.get(entry.port);
      const url = result.url;
      const card = element("div", "port-card");
      const link = element("a", "port-link");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.dataset.focusKey = `port-link-${entry.port}`;
      link.setAttribute("aria-label", `Open ${url}`);
      const dot = element("span", "port-dot active");
      dot.setAttribute("aria-hidden", "true");
      const info = element("span", "port-info");
      info.append(element("span", "port-number", `:${entry.port}`), element("span", "port-url", url));
      link.append(dot, info);
      let label = result.label;
      if (result.redirect) label = "Redirect";
      else if (!result.ok) label = `HTTP ${result.status}`;
      const labelNode = element("span", "port-label", label);
      labelNode.title = `${result.label} · ${result.redirect ? "Redirect" : `HTTP ${result.status}`}`;
      link.append(labelNode);
      card.append(link);
      if (entry.custom) card.append(button("port-remove", "×", `Remove port ${entry.port}`, entry.port));
      const open = element("a", "port-open", "↗");
      open.href = url;
      open.target = "_blank";
      open.rel = "noopener noreferrer";
      open.dataset.focusKey = `port-open-${entry.port}`;
      open.title = `Open port ${entry.port}`;
      open.setAttribute("aria-label", open.title);
      card.append(open);
      fragment.append(card);
    }
    if (!fragment.childNodes.length) {
      fragment.append(element("div", "empty-state", !initialized || (scanController && !scanController.signal.aborted)
        ? "Looking for local HTTP(S) services…"
        : "No active services found. Start a local server or add a custom port."));
    }
    replaceContents(portList, fragment);
  }

  function renderDetected() {
    detectedSection.classList.toggle("hidden", !state.detectedPorts.length);
    const fragment = document.createDocumentFragment();
    for (const port of state.detectedPorts) {
      const row = element("div", "detected-row");
      row.append(element("span", "detected-port", `:${port}`));
      const actions = element("div", "detected-actions");
      actions.append(
        button("detected-add", "✓ Add", `Save port ${port}`, port),
        button("detected-dismiss", "×", `Dismiss port ${port}`, port)
      );
      row.append(actions);
      fragment.append(row);
    }
    replaceContents(detectedList, fragment);
  }

  function scheduleRender() {
    if (renderFrame) return;
    renderFrame = requestAnimationFrame(() => {
      renderFrame = undefined;
      renderPorts();
    });
  }

  function saveCache() {
    clearTimeout(cacheTimer);
    cacheTimer = undefined;
    // Session storage is optional and disposable; cache failures must not block scans.
    try {
      chrome.storage.session?.set({ [PortScanCache.KEY]: PortScanCache.snapshot(results) }).catch(() => {});
    } catch {
      // Closing/reloading the extension can invalidate this popup's API context.
    }
  }

  async function readCache() {
    try {
      return await chrome.storage.session?.get(PortScanCache.KEY);
    } catch {
      return {};
    }
  }

  function scheduleCache() {
    if (!cacheTimer) cacheTimer = setTimeout(saveCache, 150);
  }

  async function startScan(recheck = false, quiet = results.size > 0) {
    scanController?.abort();
    const controller = new AbortController();
    scanController = controller;
    // Keep last-checked cards in place until each new result confirms or removes it.
    const pending = entries().filter(({ port }) => recheck || !results.has(port));
    scanStatus.classList.toggle("hidden", quiet || !pending.length);
    portList.setAttribute("aria-busy", String(pending.length > 0));
    renderPorts();
    try {
      await PortScanner.scan(pending, {
        signal: controller.signal,
        onResult(result) {
          if (controller !== scanController) return;
          results.set(result.port, {
            ...result, checkedAt: Date.now(), preferredOrigin: state.portEndpoints[result.port] || null,
          });
          scheduleRender();
          scheduleCache();
        },
      });
    } catch {
      if (!controller.signal.aborted) feedback("Scanning failed. Use Refresh to try again.");
    } finally {
      if (controller === scanController) {
        scanController = undefined;
        if (renderFrame) cancelAnimationFrame(renderFrame);
        renderFrame = undefined;
        scanStatus.classList.add("hidden");
        portList.setAttribute("aria-busy", "false");
        renderPorts();
        saveCache();
      }
    }
  }

  function applyState(stored, rescan = true) {
    const previous = JSON.stringify(entries());
    const oldEndpoints = state.portEndpoints;
    state = LocalPorts.normalizeState(stored);
    const configured = entries();
    const configuredPorts = new Set(configured.map((entry) => entry.port));
    for (const port of results.keys()) {
      if (!configuredPorts.has(port) || oldEndpoints[port] !== state.portEndpoints[port]) {
        results.delete(port);
      }
    }
    renderDetected();
    if (rescan && initialized && previous !== JSON.stringify(configured)) {
      // A configuration edit must not abandon the rest of an in-progress recheck.
      void startScan(Boolean(scanController));
    } else {
      renderPorts();
    }
  }

  async function command(action, port) {
    const response = await chrome.runtime.sendMessage({ type: "local-ports", action, port });
    if (!response?.ok) throw new Error(response?.error || "The extension could not respond. Reload it and try again.");
    return response.state;
  }

  async function edit(action, port) {
    if (editing) return;
    const focusKey = document.activeElement.dataset.focusKey;
    editing = true;
    addButton.disabled = true;
    renderDetected();
    renderPorts();
    feedback();
    try {
      applyState(await command(action, port));
      if (action === "add") {
        input.value = "";
        input.focus();
      }
    } catch (error) {
      feedback(error.message || "Could not save ports. Please try again.");
    } finally {
      editing = false;
      addButton.disabled = false;
      renderDetected();
      renderPorts();
      if (focusKey && document.activeElement === document.body) {
        const replacement = [...document.querySelectorAll("[data-focus-key]")]
          .find((node) => node.dataset.focusKey === focusKey);
        (replacement || input).focus({ preventScroll: true });
      }
    }
  }

  async function refresh(restore = false) {
    if (refreshing) return;
    refreshing = true;
    refreshButton.disabled = true;
    feedback();
    try {
      if (restore) {
        const [stored, cached] = await Promise.all([
          chrome.storage.local.get(LocalPorts.STORAGE_KEYS),
          readCache(),
        ]);
        applyState(stored, false);
        for (const [port, result] of PortScanCache.restore(cached?.[PortScanCache.KEY], entries())) {
          results.set(port, result);
        }
        renderPorts();
      }
      applyState(await command("getState"), false);
      initialized = true;
      await startScan(true);
    } catch (error) {
      initialized = true;
      scanStatus.classList.add("hidden");
      portList.setAttribute("aria-busy", "false");
      renderPorts();
      feedback(error.message || "Could not load ports. Use Refresh to try again.");
    } finally {
      refreshing = false;
      refreshButton.disabled = false;
    }
  }

  // Bind controls before any storage read or network request.
  document.getElementById("add-port-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const port = LocalPorts.parsePort(input.value);
    if (port === null) {
      feedback("Enter a whole port number from 1 to 65535.", true);
      input.focus();
    } else if (entries().some((entry) => entry.port === port)) {
      feedback(`Port ${port} is already in the scan list.`);
    } else {
      void edit("add", port);
    }
  });
  input.addEventListener("input", () => feedback());
  refreshButton.addEventListener("click", () => void refresh());
  detectedList.addEventListener("click", (event) => {
    const target = event.target.closest("button[data-port]");
    if (target) void edit(target.classList.contains("detected-add") ? "add" : "dismiss", Number(target.dataset.port));
  });
  portList.addEventListener("click", (event) => {
    const target = event.target.closest(".port-remove");
    if (target) void edit("remove", Number(target.dataset.port));
  });
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[target='_blank']");
    if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    chrome.tabs.create({ url: link.href }).catch(() => feedback("Could not open the tab. Please try again."));
  });
  function onStorageChanged(changes, area) {
    if (!initialized || area !== "local" || !LocalPorts.STORAGE_KEYS.some((key) => key in changes)) return;
    const next = { ...state };
    for (const key of LocalPorts.STORAGE_KEYS) {
      if (key in changes) next[key] = changes[key].newValue;
    }
    applyState(next);
  }
  chrome.storage.onChanged.addListener(onStorageChanged);
  window.addEventListener("pagehide", () => {
    scanController?.abort();
    if (renderFrame) cancelAnimationFrame(renderFrame);
    if (initialized) saveCache();
    chrome.storage.onChanged.removeListener(onStorageChanged);
  }, { once: true });
  void refresh(true);
});
