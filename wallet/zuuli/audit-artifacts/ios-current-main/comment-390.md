Confirmed in the actual iPhone SE 3rd gen Tauri/WKWebView build on `fb9f2ac`: the anonymous header shows **`0 2Z` + `Login with Zcash`** beside Search. The three controls consume essentially the full 375 px width before any pushed-route back affordance appears. The native screenshot is `/tmp/zuuli-native-se-home-current-main.png`; it also confirms the status-bar safe area itself is correct.

Browser DOM measurements at the same CSS width:

- anonymous 2Z link: 102.9×34 px;
- anonymous login button: 145.8×36 px;
- when route history enables Back, ordinary pushed routes have no room left and chrome/content descendants are clipped.

This independently confirms both the truthfulness and fit parts of the acceptance criteria.

