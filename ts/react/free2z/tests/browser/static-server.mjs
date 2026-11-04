import { createReadStream, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, isAbsolute, relative, resolve } from "node:path";

const buildRoot = realpathSync("build");
const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be a valid TCP port");
}

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function isInsideBuildRoot(filePath) {
  const relativePath = relative(buildRoot, filePath);
  return (
    relativePath !== ".." &&
    !relativePath.startsWith(
      `..${process.platform === "win32" ? "\\" : "/"}`
    ) &&
    !isAbsolute(relativePath)
  );
}

function resolveFile(requestPath) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    return undefined;
  }

  const candidate = resolve(buildRoot, `.${decodedPath}`);
  if (!isInsideBuildRoot(candidate)) return undefined;

  try {
    const actualPath = realpathSync(candidate);
    if (!isInsideBuildRoot(actualPath) || !statSync(actualPath).isFile()) {
      return undefined;
    }
    return actualPath;
  } catch {
    return undefined;
  }
}

const server = createServer((request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }

  let requestPath;
  try {
    requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    response.writeHead(400).end();
    return;
  }

  const requestedFile = resolveFile(requestPath);
  const filePath =
    requestedFile ??
    (requestPath === "/" || request.headers.accept?.includes("text/html")
      ? resolveFile("/index.html")
      : undefined);
  if (!filePath) {
    response.writeHead(404).end("Not found");
    return;
  }

  const contentType = contentTypes.get(extname(filePath).toLowerCase());
  if (contentType) response.setHeader("Content-Type", contentType);
  response.setHeader("Cache-Control", "no-cache");

  if (request.method === "HEAD") {
    response.writeHead(200).end();
    return;
  }

  createReadStream(filePath)
    .on("error", () => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    })
    .pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  process.stderr.write(
    `classic React static browser server listening on 127.0.0.1:${port}\n`
  );
});
