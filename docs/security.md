# Security Model and Audit Notes

This document describes the security properties of the current Browser Assistant source tree. It is a source-level review, not a formal security certification.

## 1. Least-privilege extension permissions

The Manifest V3 extension declares only:

- `activeTab`
- `scripting`
- `tabs`
- `nativeMessaging`
- `debugger`

The `debugger` permission is used by `extension/cdp.js` to dispatch controlled mouse, keyboard and wheel input through Chrome DevTools Protocol. It is not used to read cookies, profile data or authentication material.

The `tabs` permission is retained because the background worker queries the active tab and reads its URL before deciding whether it can inject the page command. `activeTab` and `scripting` are used for controlled script injection. `nativeMessaging` is required for the Rust bridge.

## 2. Authentication data is out of scope

The extension page script reads rendered DOM information needed for the requested browser operations: page metadata, text, X post/user cards, element attributes and geometry. It does not read:

- `document.cookie`
- `chrome.cookies`
- `localStorage` or `sessionStorage`
- password fields as a credential-export feature
- browser profile databases or Chrome cookie files

The Native Host source does not open Chrome profile directories or cookie databases. Its filesystem access is limited to the application's IPC token path and ordinary runtime I/O.

Important distinction: when the user is already logged in, Chrome automatically attaches the site's session cookies to that site's own network requests. The extension does not need to read those cookies to inspect the rendered page. This normal browser behavior is not a cookie read by this project.

## 3. No third-party page-data upload

The extension background script communicates with the locally installed Native Messaging Host. The Rust Host forwards commands and results over local IPC. The current extension and Native Host source do not implement HTTP requests, WebSocket connections, `sendBeacon`, or other third-party upload paths for page contents.

The target website itself may make its own network requests while rendering. Those requests are controlled by the website and Chrome, not by this extension's data-export code.

## 4. Native Host and local IPC boundaries

- The installer writes one `allowed_origins` entry for the supplied extension ID and validates that it is exactly 32 characters in Chrome's `a`-`p` alphabet.
- The IPC envelope includes a per-user token stored at `%LOCALAPPDATA%\BrowserAssistant\ipc.token` on Windows.
- Do not share that token or grant other users access to it. A local process that obtains it may be able to issue browser commands.
- The Native Host runs with the permissions of the logged-in Windows user. It is not a sandbox and must only be installed from a trusted build.
- The Host's stdout is reserved for Chrome Native Messaging frames; diagnostics must not be printed there.

## 5. Review checklist for future changes

Before merging code that changes browser permissions, extension scripts, or the Native Host:

1. Reject new `cookies`, `webRequest`, or broad host permissions unless there is a documented requirement and explicit user approval. Retain `debugger` only for the documented CDP input path; review any expansion of its use separately.
2. Reject code that reads cookies, browser profile databases, password stores, local/session storage, or authentication tokens.
3. Reject page-data transmission to remote endpoints unless the destination, payload, and user consent are explicitly documented.
4. Keep Native Messaging `allowed_origins` restricted to the exact extension ID.
5. Keep IPC token handling local and never log or return the token.
6. Re-run `cargo fmt --all -- --check`, `cargo check --workspace`, and `cargo build --workspace`; reload the unpacked extension and smoke-test the browser/Rust bridge.

## Scope and limitations

This review covers the tracked extension, Native Host, installer, and Rust client/core source currently present in the repository. It cannot guarantee the safety of a locally modified build, compromised dependencies, malware running under the same Windows account, Chrome itself, or future changes that have not been reviewed. No software can honestly promise absolute security.
