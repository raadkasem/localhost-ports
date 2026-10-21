# Changelog

Notable changes to Localhost Ports Dashboard are documented here.

## 1.2.1 - 2026-10-21

### Fixed

- Repeated popup scan flashes: restore validated results checked within the last minute from session memory, then recheck quietly. Refresh no longer clears existing cards before new checks finish.
- Apple AirPlay Receiver appearing as a development app on port 5000 with an empty HTTP 403 response. Exclude responses identified as AirPlay/AirTunes, not all 403 responses or every service on port 5000.

### Added

- Eight regression tests for cache expiry/validation and distinguishing AirPlay from genuine HTTP 403 applications, bringing the automated suite to 29 tests.
- Real-browser coverage for quiet cached reopening, fresh background checks, and stable refresh/focus.

### Upgrade notes

- Update the files and reload the extension in `chrome://extensions`; confirm version **1.2.1**.
- No new permissions. Saved ports are preserved, and the session cache is cleared by reloading.
- The first open or an expired cache still requires a scan. Results checked within the last minute can appear immediately on reopening, then update as fresh checks finish.

## 1.2.0 - 2026-10-20

### Added

- HTTP and HTTPS probing, remembered local origins, and IPv6 loopback discovery.
- Discovery of existing local tabs and implicit HTTP/HTTPS ports 80 and 443.
- Manual refresh, progressive results, visible error feedback, and retry handling.
- Persistent dismissal of discovered ports and live updates to suggestions and badges.
- Keyboard-accessible service links, labeled controls, focus preservation, and reduced-motion support.
- A documented audit, 21 automated regression tests, and isolated real-Chrome integration tests.

### Changed

- Show only confirmed online services. Offline and pending ports are hidden, while saved ports remain configured and are rechecked on refresh or reopening.
- Treat authentication errors, redirects, and other HTTP responses as reachable without following redirects.
- Limit scans to four ports and at most eight requests at once, with one-second request/body deadlines and a 64 KiB title-read limit.
- Cancel stale scans and unused response bodies; batch progressive rendering and avoid redundant badge updates.
- Request only storage and explicit local HTTP(S) host permissions, removing broad `tabs` access.
- Document supported ports, detection limits, privacy, installation, and verification.

### Fixed

- Unsafe HTML rendering of local page titles.
- Lost updates when tab discovery and popup actions modify storage concurrently.
- Stalled or oversized responses delaying scans and consuming unnecessary resources.
- Duplicate custom ports, partial or out-of-range port input, and incorrect active counts.
- Forgotten origins, inconsistent badges, and repeatedly suggested dismissed ports.
- Unhandled asynchronous failures, delayed event binding, row overflow, and focus loss.

### Upgrade notes

- Reload the extension in `chrome://extensions` after updating the files.
- Chrome may request approval for the added HTTPS/IPv6 host permissions.
- Existing saved custom ports are retained. Offline saved ports are intentionally hidden.
- HTTPS certificates must be trusted by Chrome; production scans never bypass TLS validation.
