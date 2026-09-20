// Export platform sizes from the existing logo without redrawing the artwork.
// Requires the e2e dependencies and Playwright Chromium to be installed.
/* global Image, document -- used only inside the browser's page.evaluate callback */
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";

const require = createRequire(new URL("../e2e/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
const assets = new URL("../client/public/assets/", import.meta.url);
const source = await readFile(new URL("logo.png", assets));
const browser = await chromium.launch();
let exports;
try {
  const page = await browser.newPage();
  exports = await page.evaluate(async (data) => {
    const logo = new Image();
    logo.src = `data:image/png;base64,${data}`;
    await logo.decode();
    const sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = logo.naturalWidth;
    sourceCanvas.height = logo.naturalHeight;
    const sourceContext = sourceCanvas.getContext("2d");
    sourceContext.drawImage(logo, 0, 0);
    const pixels = sourceContext.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height).data;
    let left = sourceCanvas.width;
    let top = sourceCanvas.height;
    let right = 0;
    let bottom = 0;
    for (let y = 0; y < sourceCanvas.height; y++) {
      for (let x = 0; x < sourceCanvas.width; x++) {
        if (pixels[(y * sourceCanvas.width + x) * 4 + 3] === 0) continue;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
    const width = right - left + 1;
    const height = bottom - top + 1;
    const cx = (left + right + 1) / 2;
    const cy = (top + bottom + 1) / 2;
    let radius = 0;
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        if (pixels[(y * sourceCanvas.width + x) * 4 + 3] === 0) continue;
        radius = Math.max(radius, Math.hypot(x + 0.5 - cx, y + 0.5 - cy));
      }
    }
    const variants = [
      ["favicon-16-v3.png", 16, "transparent"],
      ["favicon-32-v3.png", 32, "transparent"],
      ["favicon-48-v3.png", 48, "transparent"],
      ["apple-touch-icon-v3.png", 180, "opaque"],
      ["icon-192-v3.png", 192, "opaque"],
      ["icon-512-v3.png", 512, "opaque"],
      ["icon-maskable-512-v3.png", 512, "maskable"],
    ];
    return variants.map(([name, size, kind]) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const context = canvas.getContext("2d");
      if (kind !== "transparent") {
        context.fillStyle = "#1a1a2e";
        context.fillRect(0, 0, size, size);
      }
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      // Maskable artwork fits inside the 40% safe radius, with room for filtering.
      const scale =
        kind === "maskable"
          ? (size * 0.39) / radius
          : (size * (kind === "transparent" ? 0.94 : 0.84)) / Math.max(width, height);
      context.drawImage(
        logo,
        left,
        top,
        width,
        height,
        (size - width * scale) / 2,
        (size - height * scale) / 2,
        width * scale,
        height * scale,
      );
      return { name, size, png: canvas.toDataURL("image/png").split(",")[1] };
    });
  }, source.toString("base64"));
} finally {
  await browser.close();
}
for (const { name, png } of exports) {
  await writeFile(new URL(name, assets), Buffer.from(png, "base64"));
  console.log(name);
}

// The conventional fallback URL contains all three actual favicon sizes.
const favicons = exports.filter(({ name }) => name.startsWith("favicon-"));
const directory = Buffer.alloc(6 + 16 * favicons.length);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(favicons.length, 4);
let offset = directory.length;
const images = favicons.map(({ size, png }, index) => {
  const image = Buffer.from(png, "base64");
  const entry = 6 + 16 * index;
  directory[entry] = directory[entry + 1] = size;
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(image.length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += image.length;
  return image;
});
await writeFile(
  new URL("../client/public/favicon.ico", import.meta.url),
  Buffer.concat([directory, ...images]),
);
console.log("favicon.ico");
