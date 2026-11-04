# Free2Z app-link fallback pages

These templates, static assets, and generated pages support browser fallbacks
for Free2Z app links. The generator validates store-link hosts and escapes
configuration values before rendering HTML.

From the repository root, supply the deployment configuration explicitly:

```sh
python scripts/free2z/gen-bridge-pages.py --config /path/to/install-links.json
python scripts/free2z/gen-bridge-pages.py --config /path/to/install-links.json --check
```

The JSON configuration contains `accessContact` and an `apps` object with exactly
`e2e2z`, `free2z`, and `zuuli`. Each app supplies `name`, `role`, and `ios` and
`android` entries containing `channel` and `url`. Channels are `testflight` or
`app-store` for iOS and `play-internal` or `play` for Android. A null URL renders
availability text; a URL must use HTTPS and the channel's real store hostname.
Keep deployment association files and private configuration in the deployment
repository. `--out-dir` selects an alternate output directory for previews.

Portable validation uses synthetic configuration and the actual browser script:

```sh
python -m unittest discover -s scripts/free2z/tests -p test_bridge_pages.py
node --test ts/free2z/bridge/test/bridge-pages.test.mjs
```
