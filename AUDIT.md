# Extension audit

Review of the original 1.1.0 code, recorded before fixes. Severity describes the
original impact. All 15 findings below have been addressed; verification is listed
after the original findings.

| ID | Severity | Finding and impact | Planned fix |
| --- | --- | --- | --- |
| 01 | High | `popup.js` interpolates untrusted page titles and stored values into `innerHTML`. A local service can inject popup markup (MV3 CSP is not an HTML sanitizer). | Render dynamic content with DOM APIs and validate stored data. |
| 02 | High | Background and popup independently perform read/modify/write operations. Simultaneous discoveries or edits can overwrite each other. | Serialize mutations in the service worker; keep one storage writer. |
| 03 | High | Request timeouts end at response headers, but `res.text()` can wait forever or allocate an arbitrarily large response. Unselected response bodies are not canceled. | Apply deadlines through body reading, cap title reads, and cancel/abort every response. |
| 04 | Medium | Only 2xx responses count as alive. Services with authentication, missing root routes, redirects, or server errors are incorrectly hidden. | Treat any HTTP response as reachable and show its status. Do not follow redirects to arbitrary sites. |
| 05 | Medium | All probes use HTTP, even on 8443. Discovery discards host/protocol, skips implicit ports 80/443, and accepts non-HTTP schemes with an explicit local port. | Share validated HTTP(S) endpoint parsing; remember discovered origins; probe HTTPS as a fallback. |
| 06 | Medium | A newly added offline port is appended to `active`, counted as active, and rendered with an empty launch URL. The same offline port disappears after reopening, making removal impossible. | Separate saved ports from reachable results, retain offline saved rows, and use valid fallback URLs. |
| 07 | Medium | `allPorts` is never updated after adding. Repeated adds, double-clicks, or accepting an already saved discovery produce duplicates. | Deduplicate/validate state and serialize add actions. |
| 08 | Medium | `parseInt` silently turns decimal/exponent/partially numeric input into another port, with no error feedback. | Require a whole decimal port in 1–65535 and provide accessible validation feedback. |
| 09 | Medium | Dismissed discoveries are immediately rediscovered on a later page load. | Persist dismissal until the user explicitly saves that port. |
| 10 | Medium | Popup snapshots never receive new discoveries or edits; badge updates are split across contexts and can become stale. | Subscribe to storage changes; derive badges centrally from normalized state. |
| 11 | Medium | Storage/API failures reject async event handlers, leave the spinner stuck, and can leave controls unbound because handlers are installed after scanning. | Bind immediately, catch failures, expose retry/error states, and restore controls in `finally`. |
| 12 | Medium | `Promise.all` launches every configured port/host at once; custom ports have no concurrency bound, and all results wait for the slowest probe. Re-renders reattach every listener. | Bound concurrent probes, publish progressive results, cancel stale scans, and delegate events. |
| 13 | Low | New ports are observed only after tab completion; existing tabs are not inspected at install/startup. Host lists are inconsistent. | Observe navigation URL changes, inspect existing local tabs, and share host definitions including IPv6 loopback. |
| 14 | Low | No refresh action; clickable cards lack keyboard semantics; icon buttons/input lack adequate names; no reduced-motion support or live status/error announcements. Dense rows can overflow the fixed popup width. | Add refresh, semantic links/buttons, labels/focus states, motion preferences, and bounded scroll areas. |
| 15 | Low | The broad `tabs` permission is unnecessary for tab creation; shared configuration is duplicated; no tests or validation scripts exist. README incorrectly promises all local services rather than selected HTTP(S) ports. | Use host-scoped access, shared constants, automated regression tests, and accurate scope/limitations documentation. |

## Verification and resolution

### Implemented fixes

- **01, 08:** Dynamic values use `textContent` and validated URLs, never HTML interpolation. Shared strict parsing rejects partial numbers, exponents, decimals, and out-of-range ports. Normalization migrates/deduplicates old storage and rejects nonlocal or non-HTTP(S) endpoints.
- **02, 07, 09, 10:** One queued service-worker writer owns discovery and popup edits. Dismissals survive navigation and popup reloads. Storage events update open popups and normalized badge counts; redundant badge operations are coalesced.
- **03, 04, 05, 12:** The shared scanner runs four port workers with at most two host requests each. One-second deadlines cover headers and body reading; title reads stop at 64 KiB, and all bodies/requests are canceled or aborted. Results stream progressively, stale scans are aborted, and popup renders are frame-batched with delegated handlers. All HTTP statuses and manual redirects establish reachability; HTTPS and remembered local origins are supported. During fallback probing, a plaintext HTTP error cannot mask a working HTTPS service on the same port.
- **06, 11, 13, 14:** Saved ports are separate from active results. Following the user's online-only display request, offline and pending ports stay hidden without deleting saved configuration; refresh/reopening checks them again. This intentionally replaces the original plan to show removable offline rows. Controls bind before I/O; API failures have feedback and retry, and edit controls recover in `finally`. Discovery handles pending navigation, implicit HTTP(S) ports, existing local tabs, and IPv6 origins. Refresh, semantic keyboard links, labels, focus retention, persistent live feedback regions, stronger small-text contrast, reduced motion, and bounded scroll areas are implemented. Row animations no longer restart on every progressive update.
- **15:** Removed the unnecessary `tabs` permission, limited host permissions to explicit local HTTP(S) hosts, centralized configuration, added dependency-free checks/tests, and documented actual scope, privacy, and browser limitations.

### Verification

- `npm run check`: production JavaScript syntax checks.
- `npm test`: 29 automated regressions for input/storage validation, endpoint restrictions, concurrent discoveries/edits, migration, persistent dismissal, API failure recovery, badge updates, HTTP/HTTPS selection, response/body deadlines, cancellation, and the eight-request concurrency ceiling. Also checks manifest permissions, icon dimensions, short-lived cache validation/expiry, and AirPlay exclusion without hiding genuine HTTP 403 apps.
- `npm run test:browser` with Chrome for Testing 156.0.8078.4: loads the real unpacked extension in an isolated profile and exercises HTTP, HTTPS, IPv6, authenticated errors, redirects without following their destination, stalled bodies, hostile escaped titles, counts/layout at 400px, focus handling, reduced motion, strict input handling, hidden offline saves, rapid duplicate submissions, live discovery/badges, refresh, reopen persistence, and visibility as saved services start and stop. No uncaught popup errors or unhandled rejections were observed. The test-only HTTPS fixture uses a self-signed certificate bypass; production never does.
- `git diff --check`: whitespace validation.

### Popup follow-up (1.2.1)

Recent scan results are validated and retained in session memory for up to one
minute, allowing quick reopens to show last-checked services while fresh probes
run quietly. Refresh keeps cards in place until updated instead of clearing the
list. Expired snapshots, changed origins, removed ports, and unsafe cached URLs
are rejected. Real-browser tests delay responses to verify the cached UI remains
visible during reopening and refresh, with keyboard focus preserved.

macOS Control Center's AirPlay Receiver can return an empty HTTP 403 on port
5000. The scanner now excludes responses identified by an AirTunes/AirPlay
server header, not arbitrary 403 responses or port 5000 itself. Tests cover both
system-service exclusion and genuine development apps, including mixed hosts.

### Remaining platform limits (not unresolved implementation findings)

This remains an HTTP(S) dashboard, not an exhaustive TCP scanner or process/health
monitor. Browser security can block unsafe ports, denied host permissions, or
untrusted TLS certificates. Slow responses can exceed the documented deadline.
Automatic probes use `127.0.0.1` and `localhost`; IPv6/wildcard origins are probed
when previously discovered in a local tab. No extension can reliably infer
application health from a successful connection or response alone. See README
for the exact probing, credential, redirect, and persistence behavior.
