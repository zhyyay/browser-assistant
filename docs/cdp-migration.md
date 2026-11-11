# CDP browser control migration

This branch introduces the first layer of a CDP-based automation architecture.

## Design

- Rust Native Messaging remains the local bridge and public API.
- The MV3 extension owns Chrome DevTools Protocol attachment via `chrome.debugger`.
- Automation tabs are created in a separate, non-focused Chrome window and grouped as
  `浏览器助手自动化`; user tabs are never repurposed.
- Pointer, keyboard and wheel events are sent to the selected tab through CDP
  (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText`).
- Existing Windows SendInput code remains available during migration, but the CDP
  transport itself does not move the operating-system cursor or type into another app.
- Input replacement always clears the existing field before inserting new text and
  verifies the resulting DOM value.

## Important Chrome behavior

The `debugger` extension permission is powerful and Chrome may show a debugging
notification/banner while a tab is attached. This is expected for CDP and must not
be described as invisible. The automation window is created with `focused: false`,
but browser/platform behavior and page-specific requirements still need live testing.
CDP input does not guarantee every website interaction works in a background tab.

## Migration sequence

1. Add and test the CDP transport and isolated session manager.
2. Route X post composition through the automation session and CDP input.
3. Route Following scanning through the same owned tab and CDP wheel input.
4. Migrate generic BrowserClient commands and add explicit session lifecycle APIs.
5. Remove Windows SendInput from normal flows; retain it only as an opt-in fallback.

No Windows SendInput path should be removed until X posting and Following scanning have
passed real Chrome tests on the user's machine.
