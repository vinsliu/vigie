#!/usr/bin/env node
// Checked before loading anything else, so an old Node prints a clear message instead of a stack trace.
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`Vigie needs Node.js 22.18 or newer (this is ${process.versions.node}).`);
  process.exit(1);
}

const { parseArgs } = await import("node:util");
const { defaultClaudeDir, defaultDataDir } = await import("./core/index.ts");
const { createDashboard } = await import("./server/index.ts");

const { values } = parseArgs({
  options: {
    port: { type: "string", short: "p", default: "4317" },
    "claude-dir": { type: "string" },
    "data-dir": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log("Usage: vigie [--port 4317] [--claude-dir ~/.claude] [--data-dir ~/.config/vigie]");
  process.exit(0);
}

const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid port: ${values.port}`);
  process.exit(1);
}

const claudeDir = values["claude-dir"] ?? defaultClaudeDir();
const dataDir = values["data-dir"] ?? defaultDataDir();
const server = createDashboard({ claudeDir, dataDir });

server.on("error", (e: NodeJS.ErrnoException) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${port} is already in use (try --port).` : e.message);
  process.exit(1);
});

// Loopback only: this tool is never exposed on the network.
server.listen(port, "127.0.0.1", () => {
  console.log(`vigie → http://127.0.0.1:${port}`);
  console.log(`reading ${claudeDir}`);
});
