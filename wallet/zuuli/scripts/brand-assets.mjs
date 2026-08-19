#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";
import { PNG } from "pngjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const checkOnly = process.argv.includes("--check");
const unexpectedArgs = process.argv.slice(2).filter((arg) => arg !== "--check");

if (unexpectedArgs.length > 0) {
  console.error("usage: node scripts/brand-assets.mjs [--check]");
  process.exit(64);
}

const palette = {
  violet: "#a855f7",
  fuchsia: "#c026d3",
  deepViolet: "#4c1d95",
  ink: "#09090b",
  white: "#ffffff",
};

const zPath = "M6 6h12L8 18h12";
const zStroke = 2.4;
const adaptiveScale = 0.75;
const adaptiveSafeZone = 66 / 108;

function svgDocument({ body, viewBox = "0 0 24 24", width, height }) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"${
      width && height ? ` width="${width}" height="${height}"` : ""
    }>`,
    body,
    "</svg>",
    "",
  ].join("\n");
}

const gradientDefinition = `  <defs>
    <linearGradient id="zuuli-gradient" x1="2" y1="1" x2="22" y2="23" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${palette.violet}"/>
      <stop offset="1" stop-color="${palette.fuchsia}"/>
    </linearGradient>
  </defs>`;

const logoSvg = await readFile(path.join(appDir, "assets/brand/logo.svg"), "utf8");
const logoComponent = await readFile(path.join(appDir, "src/components/brand/Logo.tsx"), "utf8");
for (const [description, expected] of [
  ["viewBox", 'viewBox="0 0 24 24"'],
  ["Z geometry", zPath],
  ["violet endpoint", palette.violet],
  ["fuchsia endpoint", palette.fuchsia],
]) {
  if (!logoSvg.includes(expected)) {
    throw new Error(`assets/brand/logo.svg is missing the canonical ${description}`);
  }
}
for (const [description, expected] of [
  ["viewBox", 'viewBox="0 0 24 24"'],
  ["Z geometry", zPath],
  ["violet token", "from-primary"],
  ["fuchsia token", "to-fuchsia-600"],
]) {
  if (!logoComponent.includes(expected)) {
    throw new Error(`Logo.tsx is missing the canonical ${description}`);
  }
}

const roundLogoSvg = svgDocument({
  body: `${gradientDefinition}
  <circle cx="12" cy="12" r="12" fill="url(#zuuli-gradient)"/>
  <path d="${zPath}" fill="none" stroke="${palette.white}" stroke-width="${zStroke}" stroke-linecap="round" stroke-linejoin="round"/>`,
});

const adaptiveTransform = `translate(12 12) scale(${adaptiveScale}) translate(-12 -12)`;
const androidForegroundSvg = svgDocument({
  width: 1024,
  height: 1024,
  body: `  <g transform="${adaptiveTransform}">
    <path d="${zPath}" fill="none" stroke="${palette.white}" stroke-width="${zStroke}" stroke-linecap="round" stroke-linejoin="round"/>
  </g>`,
});

const androidMonochromeSvg = svgDocument({
  width: 1024,
  height: 1024,
  body: `  <g transform="${adaptiveTransform}">
    <path d="${zPath}" fill="none" stroke="${palette.white}" stroke-width="${zStroke}" stroke-linecap="round" stroke-linejoin="round"/>
  </g>`,
});

const playFeatureGraphicSvg = svgDocument({
  viewBox: "0 0 1024 500",
  width: 1024,
  height: 500,
  body: `  <defs>
    <linearGradient id="feature-bg" x1="80" y1="10" x2="944" y2="490" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${palette.ink}"/>
      <stop offset="0.52" stop-color="${palette.deepViolet}"/>
      <stop offset="1" stop-color="${palette.fuchsia}"/>
    </linearGradient>
    <linearGradient id="feature-mark" x1="356" y1="94" x2="668" y2="406" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${palette.violet}"/>
      <stop offset="1" stop-color="${palette.fuchsia}"/>
    </linearGradient>
    <radialGradient id="feature-glow" cx="0" cy="0" r="1" gradientTransform="translate(512 250) rotate(90) scale(240 440)" gradientUnits="userSpaceOnUse">
      <stop stop-color="${palette.violet}" stop-opacity="0.34"/>
      <stop offset="1" stop-color="${palette.violet}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1024" height="500" fill="url(#feature-bg)"/>
  <rect width="1024" height="500" fill="url(#feature-glow)"/>
  <circle cx="106" cy="82" r="172" fill="none" stroke="${palette.white}" stroke-opacity="0.06" stroke-width="2"/>
  <circle cx="930" cy="428" r="214" fill="none" stroke="${palette.white}" stroke-opacity="0.08" stroke-width="2"/>
  <rect x="356" y="94" width="312" height="312" rx="72" fill="url(#feature-mark)"/>
  <g transform="translate(356 94) scale(13)">
    <path d="${zPath}" fill="none" stroke="${palette.white}" stroke-width="${zStroke}" stroke-linecap="round" stroke-linejoin="round"/>
  </g>`,
});

const iconManifest = `${JSON.stringify(
  {
    default: "logo.svg",
    bg_color: palette.violet,
    android_fg: "android-foreground.svg",
    android_fg_scale: 100,
    android_monochrome: "android-monochrome.svg",
  },
  null,
  2,
)}\n`;

const sourceFiles = new Map([
  ["assets/brand/logo.svg", logoSvg],
  ["assets/brand/android-foreground.svg", androidForegroundSvg],
  ["assets/brand/android-monochrome.svg", androidMonochromeSvg],
  ["assets/brand/play-feature-graphic.svg", playFeatureGraphicSvg],
  ["assets/brand/tauri-icon-manifest.json", iconManifest],
]);

const desktopFiles = [
  "32x32.png",
  "64x64.png",
  "128x128.png",
  "128x128@2x.png",
  "icon.icns",
  "icon.ico",
];

const windowsFiles = [
  "StoreLogo.png",
  "Square30x30Logo.png",
  "Square44x44Logo.png",
  "Square71x71Logo.png",
  "Square89x89Logo.png",
  "Square107x107Logo.png",
  "Square142x142Logo.png",
  "Square150x150Logo.png",
  "Square284x284Logo.png",
  "Square310x310Logo.png",
];

const desktopPngDimensions = new Map([
  ["32x32.png", 32],
  ["64x64.png", 64],
  ["128x128.png", 128],
  ["128x128@2x.png", 256],
  ["icon.png", 512],
  ["StoreLogo.png", 50],
  ["Square30x30Logo.png", 30],
  ["Square44x44Logo.png", 44],
  ["Square71x71Logo.png", 71],
  ["Square89x89Logo.png", 89],
  ["Square107x107Logo.png", 107],
  ["Square142x142Logo.png", 142],
  ["Square150x150Logo.png", 150],
  ["Square284x284Logo.png", 284],
  ["Square310x310Logo.png", 310],
]);

const expectedIcoSizes = [16, 24, 32, 48, 64, 256];
const expectedIcnsPngSizes = new Map([
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
  ["ic11", 32],
  ["ic12", 64],
  ["ic13", 256],
  ["ic14", 512],
]);

const androidDensities = [
  ["mdpi", 48, 108],
  ["hdpi", 72, 162],
  ["xhdpi", 96, 216],
  ["xxhdpi", 144, 324],
  ["xxxhdpi", 192, 432],
];

const appleIconNames = [
  "AppIcon-20x20@1x.png",
  "AppIcon-20x20@2x-1.png",
  "AppIcon-20x20@2x.png",
  "AppIcon-20x20@3x.png",
  "AppIcon-29x29@1x.png",
  "AppIcon-29x29@2x-1.png",
  "AppIcon-29x29@2x.png",
  "AppIcon-29x29@3x.png",
  "AppIcon-40x40@1x.png",
  "AppIcon-40x40@2x-1.png",
  "AppIcon-40x40@2x.png",
  "AppIcon-40x40@3x.png",
  "AppIcon-60x60@2x.png",
  "AppIcon-60x60@3x.png",
  "AppIcon-76x76@1x.png",
  "AppIcon-76x76@2x.png",
  "AppIcon-83.5x83.5@2x.png",
  "AppIcon-512@2x.png",
];

const obsoleteGeneratedFiles = [
  "src-tauri/gen/android/app/src/main/res/drawable-v24/ic_launcher_foreground.xml",
  "src-tauri/gen/android/app/src/main/res/drawable/ic_launcher_background.xml",
];

function renderSvg(svg, width, height, { opaque = false } = {}) {
  const pngBuffer = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: { loadSystemFonts: false },
  })
    .render()
    .asPng();
  const png = PNG.sync.read(pngBuffer);
  if (png.width !== width || png.height !== height) {
    throw new Error(`renderer produced ${png.width}x${png.height}, expected ${width}x${height}`);
  }
  if (!opaque) return pngBuffer;
  for (let index = 3; index < png.data.length; index += 4) {
    if (png.data[index] !== 255) {
      throw new Error("opaque asset contains transparent pixels");
    }
  }
  return PNG.sync.write(png, {
    colorType: 2,
    inputColorType: 6,
    inputHasAlpha: true,
  });
}

async function write(relativePath, value, root) {
  const output = path.join(root, relativePath);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, value);
}

function runTauriIcon(manifestPath, outputPath) {
  const binary = path.join(
    appDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tauri.cmd" : "tauri",
  );
  const result = spawnSync(binary, ["icon", manifestPath, "--output", outputPath], {
    cwd: appDir,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`tauri icon failed:\n${result.stdout}\n${result.stderr}`);
  }
}

async function generate(root) {
  for (const [relativePath, contents] of sourceFiles) {
    await write(relativePath, contents, root);
  }

  const generatedRoot = path.join(root, ".tauri-icons");
  runTauriIcon(path.join(root, "assets/brand/tauri-icon-manifest.json"), generatedRoot);

  for (const name of [...desktopFiles, ...windowsFiles]) {
    const generated = await readFile(path.join(generatedRoot, name));
    await write(
      `src-tauri/icons/${name}`,
      name === "icon.icns" ? canonicalizeIcns(generated) : generated,
      root,
    );
  }
  await write("src-tauri/icons/icon.png", renderSvg(logoSvg, 512, 512), root);

  const appleSource = path.join(generatedRoot, "ios");
  await write(
    "src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/Contents.json",
    await readFile(
      path.join(appDir, "src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/Contents.json"),
    ),
    root,
  );
  for (const name of appleIconNames) {
    const decoded = PNG.sync.read(await readFile(path.join(appleSource, name)));
    const rgb = PNG.sync.write(decoded, {
      colorType: 2,
      inputColorType: 6,
      inputHasAlpha: true,
    });
    await write(
      `src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/${name}`,
      rgb,
      root,
    );
  }

  for (const [density, legacySize, foregroundSize] of androidDensities) {
    const destination = `src-tauri/gen/android/app/src/main/res/mipmap-${density}`;
    await write(`${destination}/ic_launcher.png`, renderSvg(logoSvg, legacySize, legacySize), root);
    await write(
      `${destination}/ic_launcher_round.png`,
      renderSvg(roundLogoSvg, legacySize, legacySize),
      root,
    );
    await write(
      `${destination}/ic_launcher_foreground.png`,
      renderSvg(androidForegroundSvg, foregroundSize, foregroundSize),
      root,
    );
    await write(
      `${destination}/ic_launcher_monochrome.png`,
      renderSvg(androidMonochromeSvg, foregroundSize, foregroundSize),
      root,
    );
  }

  const adaptiveIconXml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome" />
</adaptive-icon>
`;
  await write(
    "src-tauri/gen/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml",
    adaptiveIconXml,
    root,
  );
  await write(
    "src-tauri/gen/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml",
    adaptiveIconXml,
    root,
  );
  await write(
    "src-tauri/gen/android/app/src/main/res/values/ic_launcher_background.xml",
    `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${palette.violet}</color>
</resources>
`,
    root,
  );

  const master = renderSvg(logoSvg, 1024, 1024, { opaque: true });
  await write("assets/brand/logo-1024.png", master, root);
  await write("assets/store/app-store-icon-1024.png", master, root);
  await write(
    "assets/store/play-store-icon-512.png",
    renderSvg(logoSvg, 512, 512, { opaque: true }),
    root,
  );
  await write(
    "assets/store/play-feature-graphic-1024x500.png",
    renderSvg(playFeatureGraphicSvg, 1024, 500, { opaque: true }),
    root,
  );

  await write("public/favicon-32.png", renderSvg(logoSvg, 32, 32, { opaque: true }), root);
  await write("public/favicon-64.png", renderSvg(logoSvg, 64, 64, { opaque: true }), root);
  await write(
    "public/apple-touch-icon.png",
    renderSvg(logoSvg, 180, 180, { opaque: true }),
    root,
  );
  await write("public/favicon.ico", await readFile(path.join(generatedRoot, "icon.ico")), root);

  await rm(generatedRoot, { recursive: true });
}

function pngHeader(buffer) {
  const signature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== signature) {
    throw new Error("not a PNG file");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
  };
}

function alphaBounds(buffer) {
  const png = PNG.sync.read(buffer);
  let minX = png.width;
  let minY = png.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      if (png.data[(y * png.width + x) * 4 + 3] === 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) throw new Error("transparent asset has no visible pixels");
  return { minX, minY, maxX, maxY, width: png.width, height: png.height };
}

function assertPng(buffer, expectedWidth, expectedHeight, { opaque = false } = {}) {
  const header = pngHeader(buffer);
  if (header.width !== expectedWidth || header.height !== expectedHeight) {
    throw new Error(
      `PNG is ${header.width}x${header.height}, expected ${expectedWidth}x${expectedHeight}`,
    );
  }
  if (header.bitDepth !== 8) throw new Error(`PNG bit depth is ${header.bitDepth}, expected 8`);
  if (opaque && header.colorType !== 2) {
    throw new Error(`opaque PNG color type is ${header.colorType}, expected RGB type 2`);
  }
}

function icoSizes(buffer) {
  if (buffer.length < 6 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    throw new Error("desktop ICO is missing its container header");
  }
  const count = buffer.readUInt16LE(4);
  const directoryEnd = 6 + count * 16;
  if (buffer.length < directoryEnd) throw new Error("desktop ICO directory is truncated");
  const sizes = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    const width = buffer[offset] || 256;
    const height = buffer[offset + 1] || 256;
    if (width !== height) throw new Error(`desktop ICO contains a ${width}x${height} entry`);
    const bitsPerPixel = buffer.readUInt16LE(offset + 6);
    if (bitsPerPixel !== 32) {
      throw new Error(`desktop ICO ${width}x${height} entry is ${bitsPerPixel}-bit, expected 32-bit`);
    }
    const dataLength = buffer.readUInt32LE(offset + 8);
    const dataOffset = buffer.readUInt32LE(offset + 12);
    if (
      dataLength === 0 ||
      dataOffset < directoryEnd ||
      dataOffset > buffer.length ||
      dataLength > buffer.length - dataOffset
    ) {
      throw new Error(`desktop ICO ${width}x${height} representation points outside the file`);
    }
    const representation = buffer.subarray(dataOffset, dataOffset + dataLength);
    const decoded = pngHeader(representation);
    if (decoded.width !== width || decoded.height !== height) {
      throw new Error(
        `desktop ICO ${width}x${height} directory entry contains ${decoded.width}x${decoded.height} pixels`,
      );
    }
    sizes.push(width);
  }
  return sizes.sort((left, right) => left - right);
}

async function validate(root) {
  for (const relativePath of obsoleteGeneratedFiles) {
    try {
      await readFile(path.join(root, relativePath));
      throw new Error(`${relativePath} is obsolete stock launcher artwork`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const opaquePngs = [
    ["assets/brand/logo-1024.png", 1024, 1024],
    ["assets/store/app-store-icon-1024.png", 1024, 1024],
    ["assets/store/play-store-icon-512.png", 512, 512],
    ["assets/store/play-feature-graphic-1024x500.png", 1024, 500],
    ["public/favicon-32.png", 32, 32],
    ["public/favicon-64.png", 64, 64],
    ["public/apple-touch-icon.png", 180, 180],
  ];
  for (const [relativePath, width, height] of opaquePngs) {
    assertPng(await readFile(path.join(root, relativePath)), width, height, { opaque: true });
  }

  for (const [name, size] of desktopPngDimensions) {
    assertPng(await readFile(path.join(root, "src-tauri/icons", name)), size, size);
  }
  const icnsSizes = icnsPngSizes(await readFile(path.join(root, "src-tauri/icons/icon.icns")));
  for (const [type, expectedSize] of expectedIcnsPngSizes) {
    const actualSize = icnsSizes.get(type);
    if (actualSize !== expectedSize) {
      throw new Error(
        `desktop ICNS ${type} representation is ${actualSize ?? "missing"}, expected ${expectedSize}x${expectedSize}`,
      );
    }
  }
  const actualIcoSizes = icoSizes(await readFile(path.join(root, "src-tauri/icons/icon.ico")));
  if (JSON.stringify(actualIcoSizes) !== JSON.stringify(expectedIcoSizes)) {
    throw new Error(
      `desktop ICO sizes are ${actualIcoSizes.join(", ")}, expected ${expectedIcoSizes.join(", ")}`,
    );
  }

  const appIconContents = JSON.parse(
    await readFile(
      path.join(root, "src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/Contents.json"),
      "utf8",
    ),
  );
  const catalogNames = appIconContents.images.map((image) => image.filename).sort();
  const expectedCatalogNames = [...appleIconNames].sort();
  if (JSON.stringify(catalogNames) !== JSON.stringify(expectedCatalogNames)) {
    throw new Error("iOS AppIcon catalog does not reference the complete generated icon set");
  }
  for (const image of appIconContents.images) {
    const pointSize = Number(image.size.split("x")[0]);
    const scale = Number(image.scale.replace("x", ""));
    const pixels = Math.round(pointSize * scale);
    const icon = await readFile(
      path.join(root, "src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset", image.filename),
    );
    assertPng(icon, pixels, pixels, { opaque: true });
  }

  for (const [density, legacySize, foregroundSize] of androidDensities) {
    const base = path.join(
      root,
      `src-tauri/gen/android/app/src/main/res/mipmap-${density}`,
    );
    assertPng(await readFile(path.join(base, "ic_launcher.png")), legacySize, legacySize);
    assertPng(await readFile(path.join(base, "ic_launcher_round.png")), legacySize, legacySize);
    for (const name of ["ic_launcher_foreground.png", "ic_launcher_monochrome.png"]) {
      const icon = await readFile(path.join(base, name));
      assertPng(icon, foregroundSize, foregroundSize);
      const bounds = alphaBounds(icon);
      const safeMargin = (foregroundSize * (1 - adaptiveSafeZone)) / 2;
      if (
        bounds.minX < Math.floor(safeMargin) ||
        bounds.minY < Math.floor(safeMargin) ||
        bounds.maxX >= Math.ceil(foregroundSize - safeMargin) ||
        bounds.maxY >= Math.ceil(foregroundSize - safeMargin)
      ) {
        throw new Error(`${density}/${name} escapes the Android 66dp adaptive safe zone`);
      }
    }
  }

  for (const name of ["ic_launcher.xml", "ic_launcher_round.xml"]) {
    const adaptiveXml = await readFile(
      path.join(root, "src-tauri/gen/android/app/src/main/res/mipmap-anydpi-v26", name),
      "utf8",
    );
    for (const required of [
      '<background android:drawable="@color/ic_launcher_background" />',
      '<foreground android:drawable="@mipmap/ic_launcher_foreground" />',
      '<monochrome android:drawable="@mipmap/ic_launcher_monochrome" />',
    ]) {
      if (!adaptiveXml.includes(required)) {
        throw new Error(`${name} is missing ${required}`);
      }
    }
  }

  const tauriConfig = JSON.parse(
    await readFile(path.join(appDir, "src-tauri/tauri.conf.json"), "utf8"),
  );
  const expectedBundleIcons = [
    "icons/32x32.png",
    "icons/128x128.png",
    "icons/128x128@2x.png",
    "icons/icon.icns",
    "icons/icon.ico",
  ];
  if (JSON.stringify(tauriConfig.bundle.icon) !== JSON.stringify(expectedBundleIcons)) {
    throw new Error("tauri.conf.json does not reference the generated desktop icon set");
  }

  const androidManifest = await readFile(
    path.join(appDir, "src-tauri/gen/android/app/src/main/AndroidManifest.xml"),
    "utf8",
  );
  for (const required of [
    'android:icon="@mipmap/ic_launcher"',
    'android:roundIcon="@mipmap/ic_launcher_round"',
  ]) {
    if (!androidManifest.includes(required)) {
      throw new Error(`Android manifest is missing ${required}`);
    }
  }

  const html = await readFile(path.join(appDir, "index.html"), "utf8");
  for (const required of [
    'href="/favicon-32.png"',
    'href="/favicon-64.png"',
    'href="/favicon.ico"',
    'href="/apple-touch-icon.png"',
  ]) {
    if (!html.includes(required)) throw new Error(`web shell is missing ${required}`);
  }
}

async function collectFiles(root, relative = "") {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(root, child)));
    else files.push(child);
  }
  return files;
}

async function compareGenerated(stagingRoot) {
  const stagedFiles = await collectFiles(stagingRoot);
  const differences = [];
  for (const relativePath of stagedFiles) {
    const expected = await readFile(path.join(stagingRoot, relativePath));
    let actual;
    try {
      actual = await readFile(path.join(appDir, relativePath));
    } catch {
      differences.push(`${relativePath} is missing`);
      continue;
    }
    if (expected.equals(actual)) continue;
    differences.push(`${relativePath} differs`);
  }
  if (differences.length > 0) {
    throw new Error(`brand assets are stale; run npm run icons:generate:\n${differences.join("\n")}`);
  }
}

async function expectValidationFailure(root, relativePath, invalidContents, expectedMessage) {
  const target = path.join(root, relativePath);
  const original = await readFile(target);
  await writeFile(target, invalidContents);
  let failure;
  try {
    await validate(root);
  } catch (error) {
    failure = error;
  } finally {
    await writeFile(target, original);
  }
  if (!failure || !String(failure.message).includes(expectedMessage)) {
    throw new Error(`brand validator self-test did not reject ${relativePath}`);
  }
}

async function exerciseValidator(root) {
  await expectValidationFailure(
    root,
    "src-tauri/gen/android/app/src/main/res/mipmap-hdpi/ic_launcher.png",
    renderSvg(logoSvg, 49, 49),
    "expected 72x72",
  );
  await expectValidationFailure(
    root,
    "assets/store/app-store-icon-1024.png",
    renderSvg(logoSvg, 1024, 1024),
    "expected RGB type 2",
  );
  await expectValidationFailure(
    root,
    "src-tauri/gen/android/app/src/main/res/mipmap-mdpi/ic_launcher_foreground.png",
    renderSvg(
      svgDocument({
        body: `  <path d="${zPath}" fill="none" stroke="${palette.white}" stroke-width="${zStroke}" stroke-linecap="round" stroke-linejoin="round"/>`,
      }),
      108,
      108,
    ),
    "escapes the Android 66dp adaptive safe zone",
  );
  await expectValidationFailure(
    root,
    "src-tauri/gen/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml",
    `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`,
    "monochrome",
  );
  const corruptIco = Buffer.from(await readFile(path.join(root, "src-tauri/icons/icon.ico")));
  corruptIco.writeUInt32LE(corruptIco.length + 1, 6 + 12);
  await expectValidationFailure(
    root,
    "src-tauri/icons/icon.ico",
    corruptIco,
    "points outside the file",
  );
  const incompleteIcns = Buffer.from(await readFile(path.join(root, "src-tauri/icons/icon.icns")));
  const ic10Offset = incompleteIcns.indexOf(Buffer.from("ic10", "ascii"), 8);
  if (ic10Offset < 0) throw new Error("brand validator self-test could not find ICNS ic10 chunk");
  incompleteIcns.write("junk", ic10Offset, "ascii");
  await expectValidationFailure(
    root,
    "src-tauri/icons/icon.icns",
    incompleteIcns,
    "ic10 representation is missing",
  );
}

function icnsPngSizes(buffer) {
  if (buffer.subarray(0, 4).toString("ascii") !== "icns") {
    throw new Error("desktop ICNS is missing its container header");
  }
  if (buffer.readUInt32BE(4) !== buffer.length) {
    throw new Error("desktop ICNS container length does not match the file");
  }
  const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");
  let offset = 8;
  const sizes = new Map();
  while (offset + 8 <= buffer.length) {
    const type = buffer.subarray(offset, offset + 4).toString("ascii");
    const chunkLength = buffer.readUInt32BE(offset + 4);
    if (chunkLength < 8 || offset + chunkLength > buffer.length) {
      throw new Error("desktop ICNS contains an invalid chunk length");
    }
    const data = buffer.subarray(offset + 8, offset + chunkLength);
    const signatureOffset = data.indexOf(pngSignature);
    if (signatureOffset >= 0) {
      const decoded = PNG.sync.read(data.subarray(signatureOffset));
      if (decoded.width !== decoded.height) {
        throw new Error(`desktop ICNS ${type} representation is not square`);
      }
      sizes.set(type, decoded.width);
    }
    offset += chunkLength;
  }
  if (offset !== buffer.length) throw new Error("desktop ICNS has trailing bytes");
  return sizes;
}

function canonicalizeIcns(buffer) {
  if (buffer.subarray(0, 4).toString("ascii") !== "icns") {
    throw new Error("desktop ICNS is missing its container header");
  }
  const chunks = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const chunkLength = buffer.readUInt32BE(offset + 4);
    if (chunkLength < 8 || offset + chunkLength > buffer.length) {
      throw new Error("desktop ICNS contains an invalid chunk length");
    }
    chunks.push(buffer.subarray(offset, offset + chunkLength));
    offset += chunkLength;
  }
  if (offset !== buffer.length) throw new Error("desktop ICNS has trailing bytes");
  chunks.sort((left, right) => left.subarray(0, 4).compare(right.subarray(0, 4)));
  const length = 8 + chunks.reduce((total, chunk) => total + chunk.length, 0);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(length, 4);
  return Buffer.concat([header, ...chunks], length);
}

const stagingRoot = await mkdtemp(path.join(tmpdir(), "zuuli-brand-assets-"));
try {
  await generate(stagingRoot);
  await validate(stagingRoot);
  if (checkOnly) {
    await exerciseValidator(stagingRoot);
    await compareGenerated(stagingRoot);
    await validate(appDir);
    console.log("ZUULI brand assets are current and satisfy platform contracts.");
  } else {
    const files = await collectFiles(stagingRoot);
    for (const relativePath of files) {
      await write(relativePath, await readFile(path.join(stagingRoot, relativePath)), appDir);
    }
    for (const relativePath of obsoleteGeneratedFiles) {
      await rm(path.join(appDir, relativePath), { force: true });
    }
    await validate(appDir);
    console.log(`Generated and validated ${files.length} ZUULI brand assets.`);
  }
} finally {
  await rm(stagingRoot, { recursive: true });
}
