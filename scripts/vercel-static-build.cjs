"use strict";

/**
 * Vercel / static hosting: copy `public/` → `dist/` and inject the Socket.IO API origin
 * from BLINKGRID_SOCKET_URL (or SOCKET_URL) so the browser can reach your Node server
 * (e.g. Railway) while the UI is served from Vercel.
 */

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const pub = path.join(root, "public");
const dist = path.join(root, "dist");

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

rmrf(dist);
copyDir(pub, dist);

const htmlPath = path.join(dist, "index.html");
let html = fs.readFileSync(htmlPath, "utf8");

const socketUrl = (process.env.BLINKGRID_SOCKET_URL || process.env.SOCKET_URL || "").trim();
const escaped = escapeAttr(socketUrl);

html = html.replace(
  /<meta\s+name="blinkgrid-socket-url"\s+[^>]*>/i,
  `<meta name="blinkgrid-socket-url" content="${escaped}" />`,
);

fs.writeFileSync(htmlPath, html);
console.log(`[vercel-static-build] Wrote ${path.relative(root, dist)} (${socketUrl ? "blinkgrid-socket-url set" : "same-origin (empty meta)"})`);
