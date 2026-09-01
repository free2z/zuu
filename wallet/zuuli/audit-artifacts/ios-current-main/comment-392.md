iPhone SE 3rd gen measurements on `fb9f2ac`: the bounded auth viewport is **611 px high**, while the chooser is **796 px** tall with the keyboard closed (185 px overflow). On first paint, the password submit is partly obscured by the bottom bar and “How Zcash login works” / “Continue as guest” are below the fold. The selected Zcash method fits, but still repeats the method in the description and CTA and exposes a **136×20 px** “All sign-in options” target.

Captures and machine-readable metrics are under `wallet/zuuli/audit-artifacts/ios-current-main/{iphone-se-3,iphone-16-pro}/signed-out/` in isolated worktree `audit/ios-ui-20260818` (`login-chooser.png`, `login-zcash-idle.png`, and the per-device JSON files).

