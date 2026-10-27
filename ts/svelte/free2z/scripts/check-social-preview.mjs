#!/usr/bin/env node
import { parseArgs } from "node:util";
import { checkSocialPreview } from "./social-preview.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "user-agent": { type: "string" },
    "asset-origin": { type: "string" },
    "asset-source-origin": { type: "string" },
    "allow-image-origin": { type: "string", multiple: true },
  },
});
if (!positionals.length) {
  console.error(
    "Usage: node scripts/check-social-preview.mjs [--user-agent UA] [--asset-origin URL] URL...",
  );
  process.exitCode = 2;
}
for (const url of positionals) {
  try {
    const result = await checkSocialPreview(url, {
      userAgent: values["user-agent"],
      assetOrigin: values["asset-origin"],
      assetSourceOrigin: values["asset-source-origin"],
      allowedImageOrigins: values["allow-image-origin"],
    });
    console.log(JSON.stringify(result, null, 2));
    if (
      result.errors.length ||
      ("warnings" in result && result.warnings.length)
    )
      process.exitCode = 1;
  } catch (error) {
    console.error(`${url}: ${error.message}`);
    process.exitCode = 1;
  }
}
