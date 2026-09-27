# Optional iMessage settings page

DSH **0.1.7-rc.2 only** browser extension. This package is deliberately not imported by the legacy bridge. Enable the optional `dsh-bluebubbles/bindings-management` host entry and install/discover this package in the target client cohort; it contributes the official `settings.section` slot, not a replacement WebUI.

Build with `npm ci && npm run build`; test with `npm test`. The deterministic `lib/client.js` is committed so a source release has a usable browser asset; CI rebuilds it and checks for drift. It uses the official `window.__ModuleLoader__.load` contract and external host React. The remote namespace is registered through public `remote.$mount` with strict input codecs and the existing authenticated gateway; there are no anonymous HTTP endpoints.

Install the root bridge first, then explicitly install/add this optional local package in the 0.1.7 target profile. Its bundle inserts the management host entry and the client discovery entry. Do not enable it on the legacy 0.1.1 cohort. The management host entry requires the existing bridge; neither the root bridge nor this repository installs the UI automatically.

The parameterized `node test/target-loader.mjs /path/to/next/node_modules` smoke uses shipped `ClientModuleSystem`, Cordis, SlotRegistry, and the official React renderer. It verifies actual settings-slot rendering, memoized imports, and unload cleanup; transport and the empty conversation owner are synthetic. Gateway authorization/host dispatch are tested separately. `node test/screenshot-build.mjs` makes a synthetic-only visual fixture; its screenshot is under `test/artifacts/settings.png`.

The page lists safe chat/session summaries, binds an existing chat to an exact existing session, unbinds, and updates relay. It neither creates sessions nor sends messages. Legacy workspace bindings remain dynamic and relay updates preserve that route. Backend revision checks and session/preset/busy validation are authoritative. Unknown errors are rendered as generic messages, never raw backend exception text. A timed-out mutation is an **unknown result**, never automatically retried: refresh must confirm the current revision before another write. Late replies cannot overwrite a newer refresh or a disposed controller.

All examples/tests are synthetic and do not access live state. No deployment is performed by this package.
