/**
 * Simple HTTP health check wrapper for Render.io deployments.
 * Exposes a /health endpoint for Render's health checks while running the OpenClaw gateway.
 * 
 * Usage: node --import tsx render-health-wrapper.ts
 */

import http from "node:http";
import { spawn } from "node:child_process";

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const GATEWAY_PORT = 18789; // Default gateway port

let gatewayReady = false;

// Create minimal HTTP server for health checks
const healthServer = http.createServer((req, res) => {
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

  // All other requests return 404
  res.writeHead(404);
  res.end("Not Found");
});

// Start the gateway as a subprocess
const gatewayProcess = spawn("node", [
  "openclaw.mjs",
  "gateway",
  "--allow-unconfigured",
  "--bind",
  "lan",
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

// Start health check server
healthServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[health-wrapper] Health check server listening on port ${PORT}`);
  console.log(`[health-wrapper] Gateway will listen on port ${GATEWAY_PORT}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[health-wrapper] Received SIGTERM, shutting down gracefully...");
  healthServer.close(() => {
    console.log("[health-wrapper] Health server closed");
    gatewayProcess.kill("SIGTERM");
  });
});
