import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "f2z-sdk-consumer-"));
function run(command, args, cwd = temp) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
try {
  const output = run(
    "npm",
    ["pack", "--json", "--pack-destination", temp],
    root,
  );
  const packed = JSON.parse(output.slice(output.indexOf("[\n")))[0];
  for (const entry of packed.files) {
    if (/node_modules|test\/|\.env|\.pem|\.key/.test(entry.path))
      throw new Error(`unexpected packed file: ${entry.path}`);
  }
  writeFileSync(
    join(temp, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    join(temp, packed.filename),
  ]);
  writeFileSync(
    join(temp, "consumer.mjs"),
    `import { Client, NativeTransport, FetchTransport, SdkError } from '@free2z/sdk';\nif (![Client, NativeTransport, FetchTransport, SdkError].every(x => typeof x === 'function')) throw Error('missing export');\n`,
  );
  run(process.execPath, ["consumer.mjs"]);
  writeFileSync(
    join(temp, "consumer.ts"),
    `import { Client, NativeTransport, type NativeBridge, type ChatRequest } from '@free2z/sdk';\ndeclare const bridge: NativeBridge;\nconst client = new Client(new NativeTransport(bridge));\nconst grant = await client.grant();\nconst limit: bigint | null = grant.spend_cap_2z;\nconst enforced: boolean = grant.enforced;\nconst request: ChatRequest = { model: 'test', messages: [], max_output_tokens: 256n, max_output_tokens_strict: true, response_format: { type: 'json_schema', json_schema: { name: 'activity_spec', schema: { type: 'object' }, strict: true } } };\nconst stream = await client.chat(request, { operationId: 'operation', idempotencyKey: 'key' });\nfor await (const event of stream) if (event.type === 'done' && event.charge.state === 'charged') { const amount: bigint = event.charge.charged2z; console.log(amount); }\n`,
  );
  run(process.execPath, [
    join(root, "node_modules/typescript/bin/tsc"),
    "--strict",
    "--target",
    "ES2022",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--noEmit",
    "consumer.ts",
  ]);
  if (!existsSync(join(temp, "node_modules/@free2z/sdk/LICENSE")))
    throw new Error("missing license");
  console.log(
    "Packed package installs, imports without Tauri, and typechecks in an isolated consumer.",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
