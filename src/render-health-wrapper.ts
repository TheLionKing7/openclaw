/**
 * Simple HTTP health check wrapper for Render.io deployments.
 * Exposes a /health endpoint for Render's health checks while running the OpenClaw gateway.
 * Acts as a reverse proxy to forward all other requests to the gateway.
 * 
 * Usage: node --import tsx render-health-wrapper.ts
 */

import http from "node:http";
import { spawn } from "node:child_process";

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const GATEWAY_PORT = 18789; // Default gateway port
const GATEWAY_HOST = "127.0.0.1";

let gatewayReady = false;

// Create HTTP server that proxies to gateway
const healthServer = http.createServer((req, res) => {
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

  // Proxy all other requests to the gateway running on loopback
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
    console.error(`[proxy] Error proxying request to ${GATEWAY_HOST}:${GATEWAY_PORT}:`, err.message);
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Bad Gateway - Gateway unavailable");
  });

  req.pipe(proxyReq);
});

// Start the gateway as a subprocess (bound to loopback since we proxy from wrapper)
const gatewayProcess = spawn("node", [
  "openclaw.mjs",
  "gateway",
  "--allow-unconfigured",
  "--port",
  String(GATEWAY_PORT),
]);

gatewayProcess.stdout?.on("data", (data) => {
  const output = data.toString();
  console.log(`[gateway] ${output}`);
  
  // Mark gateway as ready when we see startup indicators
  if (output.includes("listening") || output.includes("started") || output.includes("bound")) {
    gatewayReady = true;
    console.log("[health-wrapper] Gateway detected as ready");
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

// Start health check & proxy server
healthServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[health-wrapper] Proxy server listening on port ${PORT}`);
  console.log(`[health-wrapper] Gateway will listen on port ${GATEWAY_PORT} (loopback only)`);
  console.log(`[health-wrapper] Requests are proxied: port ${PORT} -> localhost:${GATEWAY_PORT}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[health-wrapper] Received SIGTERM, shutting down gracefully...");
  healthServer.close(() => {
    console.log("[health-wrapper] Proxy server closed");
    gatewayProcess.kill("SIGTERM");
  });
});

