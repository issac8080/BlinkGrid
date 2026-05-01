"use strict";

const path = require("path");
const http = require("http");
const net = require("net");
const express = require("express");
const { Server } = require("socket.io");
const { attachBlinkGridSockets } = require("./lib/blinkGridServer");

const isProd = process.env.NODE_ENV === "production";

/** Socket.io browser CORS: set ALLOWED_ORIGINS when API and static UI are on different origins. */
function socketIoCorsOrigin() {
  const raw = (process.env.ALLOWED_ORIGINS || process.env.CORS_ORIGIN || "").trim();
  if (!raw || raw === "*") {
    return true;
  }
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : true;
}

const DEFAULT_LOCAL_PORT = 3000;
const requestedLocalPort = Number(process.env.PORT) || DEFAULT_LOCAL_PORT;
/** Bind all interfaces so Docker / Railway / Render can route traffic (override with BIND_HOST). */
const LISTEN_HOST = process.env.BIND_HOST || "0.0.0.0";

const app = express();
if (isProd) {
  app.set("trust proxy", 1);
}

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, name: "blinkgrid" });
});

app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: socketIoCorsOrigin(),
    methods: ["GET", "POST"],
  },
});
attachBlinkGridSockets(io);

function findFirstOpenPort(startPort, range = 40) {
  return new Promise((resolve, reject) => {
    let port = startPort;
    function tryOne() {
      if (port >= startPort + range) {
        reject(new Error(`No free port between ${startPort} and ${startPort + range - 1}`));
        return;
      }
      const probe = net.createServer();
      probe.unref();
      probe.once("error", (err) => {
        if (err.code === "EADDRINUSE") {
          port += 1;
          tryOne();
        } else {
          reject(err);
        }
      });
      probe.listen(port, () => {
        const chosen = probe.address().port;
        probe.close(() => resolve(chosen));
      });
    }
    tryOne();
  });
}

function startListening(actualPort) {
  server.on("error", (err) => {
    console.error(err);
    process.exit(1);
  });
  server.listen(actualPort, LISTEN_HOST, () => {
    const label = LISTEN_HOST === "0.0.0.0" ? "localhost" : LISTEN_HOST;
    console.log(`BlinkGrid listening on http://${label}:${actualPort}`);
  });
}

const portEnv = process.env.PORT;
const portEnvSet = portEnv != null && String(portEnv).trim() !== "";

if (portEnvSet) {
  const p = Number(portEnv);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    console.error("PORT must be an integer between 1 and 65535");
    process.exit(1);
  }
  startListening(p);
} else {
  findFirstOpenPort(requestedLocalPort, 40)
    .then((actualPort) => {
      if (actualPort !== requestedLocalPort) {
        console.warn(`Port ${requestedLocalPort} is busy — using ${actualPort} instead.`);
      }
      startListening(actualPort);
    })
    .catch((err) => {
      console.error(err.message || err);
      process.exit(1);
    });
}
