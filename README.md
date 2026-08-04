# WXT + React

This template should help get you started developing with React in WXT.

## Test Chrome

Run `pnpm dev` to open Bok in Chrome for Testing. WXT always uses the persistent
profile at `~/Library/Application Support/bok-test-chrome`, so saved tabs survive
browser restarts and extension reloads.

Bok data remains local to that browser profile in `browser.storage.local`. Do not
remove the extension or delete the profile directory unless you intend to remove
its saved data. Use the dev output consistently while testing; the build output is
a different unpacked extension identity and therefore has separate local storage.
