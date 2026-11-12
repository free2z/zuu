// Pre-publication validation only. The copied consumer gets local tarballs;
// the checked-in app keeps ordinary versioned package dependencies.
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
const root = resolve(import.meta.dirname, "..");
const repo = resolve(root, "../../..");
const plugin = join(repo, "wallet/plugins/tauri-plugin-f2z");
const example = join(repo, "wallet/examples/free2z/hello-ai");
const temp = mkdtempSync(join(tmpdir(), "f2z-hello-ai-"));
function run(args, cwd) {
  return execFileSync("npm", args, {
    cwd,
    timeout: 120_000,
    encoding: "utf8",
    env: {
      ...process.env,
      // Exercise the configured app, not a tree-shaken missing-config error.
      VITE_F2Z_CLIENT_ID: "public-consumer-fixture",
      VITE_F2Z_REDIRECT_URI: "https://app.example/callback.html",
      VITE_F2Z_ALLOW_BILLING_LINK: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
try {
  const pack = (cwd) => {
    const out = run(["pack", "--json", "--pack-destination", temp], cwd);
    return join(temp, JSON.parse(out.slice(out.indexOf("[\n")))[0].filename);
  };
  const sdkTar = pack(root),
    pluginTar = pack(plugin);
  const app = join(temp, "app");
  cpSync(example, app, {
    recursive: true,
    filter: (path) =>
      !/(?:^|\/)(node_modules|dist|\.test-build|\.env[^/]*)$/.test(path),
  });
  const manifest = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
  manifest.dependencies["@free2z/sdk"] = sdkTar;
  manifest.dependencies["@free2z/tauri-plugin-f2z-api"] = pluginTar;
  writeFileSync(join(app, "package.json"), JSON.stringify(manifest));
  run(["install", "--ignore-scripts", "--no-audit", "--no-fund"], app);
  for (const script of ["test", "build", "build:tauri"]) {
    process.stdout.write(run(["run", script], app));
  }
  // Real guest declarations must remain structurally assignable, with no cast.
  writeFileSync(
    join(app, "native-compat.ts"),
    `import { Client, NativeTransport, TauriTransport, type NativeBridge } from '@free2z/sdk';
import { nativeBridge } from '@free2z/tauri-plugin-f2z-api';
const bridge: NativeBridge = nativeBridge;
const native: NativeTransport = new TauriTransport(bridge);
const client = new Client(native);
void client;
`,
  );
  execFileSync(
    process.execPath,
    [
      join(app, "node_modules/typescript/bin/tsc"),
      "--strict",
      "--noEmit",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "native-compat.ts",
    ],
    { cwd: app, stdio: "pipe" },
  );
  console.log(
    "hello-ai tests, web/Tauri frontend builds and installed native guest type compatibility passed (local tarballs; no registry/live evidence).",
  );
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw new Error("hello-ai package validation failed; see output above");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
