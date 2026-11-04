//the SvelteKit copy of nginx's social-unfurler class. That the regex is
// byte-identical to `$prerender` in k8s/free2z/nginx.conf is asserted by
// bin/test-prerender-ua-tiers.py; this pins how the JS side applies it.
import assert from "node:assert/strict";
import test from "node:test";
import { isSocialUnfurler } from "../src/lib/social-unfurler.js";

test("#2420: link unfurlers are recognised, case-insensitively", () => {
  for (const ua of [
    "Twitterbot/1.0",
    "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
    "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
    "TelegramBot (like TwitterBot)",
    "WhatsApp/2.22.20.72 A",
  ]) {
    assert.equal(isSocialUnfurler(ua), true, ua);
  }
});

test("#2420: browsers, Googlebot and a missing UA are not unfurlers", () => {
  for (const ua of [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36 TwitterAndroid",
    "",
    null,
    undefined,
  ]) {
    assert.equal(isSocialUnfurler(ua), false, String(ua));
  }
});
