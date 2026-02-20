/**
 * HTTP/WebSocket reverse proxy wrapper for Render.io deployments.
 * Exposes a /health endpoint for Render's health checks.
 * Proxies HTTP and WebSocket requests to the OpenClaw gateway.
 * 
 * Usage: node --import tsx render-health-wrapper.ts
 */

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const GATEWAY_PORT = 18789; // Default gateway port
const GATEWAY_HOST = "127.0.0.1";

let gatewayReady = false;

// Create gateway config directory and openclaw.json with trusted proxies
const stateDir = process.env.OPENCLAW_STATE_DIR || "/data/.openclaw";
const configDir = path.dirname(stateDir);

try {
  // Ensure directory exists
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
    console.log(`[proxy] Created config directory: ${configDir}`);
  }

  // Create/update openclaw.json with trusted proxies for the health wrapper proxy
  const configPath = path.join(stateDir, "openclaw.json");
  let config: any = {};

  // Load existing config if it exists
  if (fs.existsSync(configPath)) {
    try {
      const existing = fs.readFileSync(configPath, "utf-8");
      config = JSON.parse(existing);
      console.log(`[proxy] Loaded existing config from ${configPath}`);
    } catch (err) {
      console.warn(`[proxy] Could not parse existing config, will overwrite:`, err);
    }
  }

  // Ensure trustedProxies is set for the wrapper proxy
  if (!config.gateway) {
    config.gateway = {};
  }
  config.gateway.trustedProxies = ["127.0.0.1", "::1"];

  // Write config
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`[proxy] Updated config with trustedProxies: ${JSON.stringify(config.gateway.trustedProxies)}`);
} catch (err) {
  console.error(`[proxy] Failed to setup config:`, err);
  process.exit(1);
}

// Create HTTP server that proxies to gateway
const proxyServer = http.createServer((req, res) => {
  // Health check endpoint for Render
  if (req.url === "/health") {
    if (gatewayReady) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
    } else {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "starting", timestamp: new Date().toISOString() }));
    }
    return;
  }

  // Proxy all other HTTP requests to the gateway
  const proxyReq = http.request(
    {
      hostname: GATEWAY_HOST,
      port: GATEWAY_PORT,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 500, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", (err) => {
    console.error(`[proxy] HTTP error:`, err.message);
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Bad Gateway - Gateway unavailable");
  });

  req.pipe(proxyReq);
});

// Handle WebSocket upgrades
proxyServer.on("upgrade", (req, socket, head) => {
  console.log(`[proxy] WebSocket upgrade request to ${req.url}`);
  
  if (!gatewayReady) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    socket.destroy();
    return;
  }

  // Create connection to gateway
  const gwSocket = net.createConnection(GATEWAY_PORT, GATEWAY_HOST, () => {
    console.log(`[proxy] Connected to gateway for WebSocket`);
    
    // Get client IP from X-Forwarded-For or remote address
    const clientIp = req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() || 
                     req.socket.remoteAddress || "unknown";
    
    // Build the full WebSocket upgrade request
    let upgradeRequest = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    
    // Forward headers
    for (const [key, value] of Object.entries(req.headers)) {
      upgradeRequest += `${key}: ${Array.isArray(value) ? value.join(", ") : value}\r\n`;
    }
    
    // Add standard proxy headers if not already present
    if (!req.headers["x-forwarded-for"]) {
      upgradeRequest += `X-Forwarded-For: ${clientIp}\r\n`;
    }
    if (!req.headers["x-forwarded-proto"]) {
      upgradeRequest += `X-Forwarded-Proto: ${req.url?.startsWith("wss://") ? "wss" : "ws"}\r\n`;
    }
    if (!req.headers["x-forwarded-host"]) {
      upgradeRequest += `X-Forwarded-Host: ${req.headers.host || "unknown"}\r\n`;
    }
    if (!req.headers["x-real-ip"]) {
      upgradeRequest += `X-Real-IP: ${clientIp}\r\n`;
    }
    
    // Ensure critical WebSocket headers are present
    if (!req.headers["connection"]?.toString().toLowerCase().includes("upgrade")) {
      upgradeRequest += "Connection: Upgrade\r\n";
    }
    if (!req.headers["upgrade"]) {
      upgradeRequest += "Upgrade: websocket\r\n";
    }
    
    upgradeRequest += "\r\n";
    
    console.log(`[proxy] Forwarding WebSocket with proxy headers`);
    gwSocket.write(upgradeRequest);
    
    // Forward any initial data (part of WebSocket handshake)
    if (head && head.length > 0) {
      gwSocket.write(head);
    }
    
    // Bi-directional tunnel
    gwSocket.pipe(socket);
    socket.pipe(gwSocket);
  });

  gwSocket.on("error", (err) => {
    console.error(`[proxy] WebSocket error:`, err.message);
    socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    socket.destroy();
  });
});

// Start the gateway as a subprocess (bound to loopback)
const gatewayProcess = spawn("node", [
  "openclaw.mjs",
  "gateway",
  "--allow-unconfigured",
  "--port",
  String(GATEWAY_PORT),
], {
  // Ensure environment variables are inherited
  env: {
    ...process.env,
    NODE_ENV: "production",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

gatewayProcess.stdout?.on("data", (data) => {
  const output = data.toString();
  console.log(`[gateway] ${output}`);
  
  // Mark gateway as ready
  if (output.includes("listening") || output.includes("started") || output.includes("bound")) {
    gatewayReady = true;
    console.log("[proxy] Gateway detected as ready");
  }
});

gatewayProcess.stderr?.on("data", (data) => {
  const output = data.toString();
  console.error(`[gateway] ${output}`);
});

gatewayProcess.on("error", (err) => {
  console.error("[gateway] Failed to start:", err);
  process.exit(1);
});

gatewayProcess.on("exit", (code) => {
  console.log(`[gateway] Exited with code ${code}`);
  process.exit(code ?? 1);
});

// Start proxy server
proxyServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[proxy] Server listening on 0.0.0.0:${PORT}`);
  console.log(`[proxy] Gateway backend on ${GATEWAY_HOST}:${GATEWAY_PORT}`);
  console.log(`[proxy] HTTP + WebSocket proxying enabled`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[proxy] SIGTERM received, shutting down...");
  proxyServer.close(() => {
    console.log("[proxy] Server closed");
    gatewayProcess.kill("SIGTERM");
  });
});


