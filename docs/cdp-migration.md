# CDP browser control migration

## Implemented on this branch

- Added `extension/cdp/transport.js` using `chrome.debugger` and Chrome DevTools
  Protocol input events.
- Added `extension/cdp/session_manager.js` to create/reuse a dedicated,
  non-focused automation window and a tab group named `浏览器助手自动化`.
- Added the `debugger`, `storage` and `tabGroups` permissions, plus the narrow `https://x.com/*` host permission needed to inspect the owned X tab.
- Routed the existing extension click, typing, scroll and navigation input bridge
  through CDP / Chrome Tabs API. It no longer calls the Native Host's Windows
  SendInput path for normal page operations.
- X post publishing now uses the owned automation tab.
- Following scanning copies the currently selected Following URL into the owned
  automation tab, leaving the user's original tab unscrolled.
- Text input clears the existing value first and verifies the page value after
  insertion.
- Kept the old Windows input implementation in Native Host as a legacy fallback;
  it is not used by the normal extension page-input flow.

## Expected behavior and limitations

- CDP input targets a Chrome tab, not the Windows desktop pointer or keyboard.
  It should prevent ordinary mouse/keyboard operations in other applications
  from being overwritten by the automation.
- The automation window is created with `focused: false`; it is separate from
  the user's working tabs. Chrome/platform behavior still needs live validation.
- Chrome may show a debugger notification/banner while the extension is attached.
  This is an expected security indicator for the `chrome.debugger` permission.
- Some sites may behave differently in background tabs. X composer submission,
  toast confirmation, Following list lazy loading, and scrolling must be tested
  on the user's real Chrome version and account.
- The extension must be reloaded after updating its manifest permissions.
- Do not remove the Native Host Windows input module until the CDP flow passes
  real-world tests. If CDP fails, report the error rather than silently falling
  back to global mouse/keyboard input and unexpectedly stealing focus.

## Local validation

From PowerShell:

```powershell
cd D:\\rust\\browser-assistant
git pull origin feature/cdp-browser-control
cargo check --workspace
cargo build -p browser-assistant-host
```

Then open `chrome://extensions`, reload 浏览器助手, and test:
1. X Following scan while using another application.
2. X post composition and one-time submit.
3. Existing draft replacement and post-submit confirmation.
4. Close/reopen Chrome and verify session recovery.
