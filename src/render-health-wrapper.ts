/**
 * HTTP/WebSocket reverse proxy wrapper for Render.io deployments.
 * Exposes a /health endpoint for Render's health checks.
 * Proxies HTTP and WebSocket requests to the OpenClaw gateway.
 * 
 * Usage: node --import tsx render-health-wrapper.ts
 */

import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const GATEWAY_PORT = 18789; // Default gateway port
const GATEWAY_HOST = "127.0.0.1";

let gatewayReady = false;

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
    
    // Forward the upgrade request to the gateway
    const requestLine = `${req.method} ${req.url} HTTP/${req.httpVersion}`;
    gwSocket.write(`${requestLine}\r\n`);
    
    // Forward headers
    for (const [key, value] of Object.entries(req.headers)) {
      gwSocket.write(`${key}: ${value}\r\n`);
    }
    gwSocket.write("\r\n");
    
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
]);

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


