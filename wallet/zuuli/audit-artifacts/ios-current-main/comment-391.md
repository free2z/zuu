Native iPhone SE 3rd gen verification on current `origin/main` (`fb9f2ac`) confirms the same failure in the actual Tauri/WKWebView shell, not only Chrome emulation.

- Device/simulator: iPhone SE (3rd generation), iOS 18.3.1, 375×667 CSS viewport.
- `npm run tauri -- ios dev 'iPhone SE (3rd generation)' --no-watch` completed successfully after initializing the pinned librustzcash submodule; cold Rust build took 16m24s.
- The native home capture visibly clips the hero paragraph, the ZEC balance tile/value, and the second livestream card at the right edge. Safe-area framing itself holds.
- The matching browser DOM audit measured the home route content at **904 CSS px inside 375 px**, while `body.scrollWidth === body.clientWidth === 375`; this proves a root-only horizontal-overflow assertion is a false pass.

Evidence:

- Native capture: `/tmp/zuuli-native-se-home-current-main.png`
- Full browser matrix and DOM measurements: `wallet/zuuli/audit-artifacts/ios-current-main/` in isolated worktree `audit/ios-ui-20260818`

