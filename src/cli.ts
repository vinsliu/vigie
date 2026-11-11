#!/usr/bin/env node
import { parseArgs } from "node:util";
import { defaultClaudeDir } from "./core/index.ts";
import { createDashboard } from "./server/index.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string", short: "p", default: "4317" },
    "claude-dir": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log("Usage: agents-dashboard [--port 4317] [--claude-dir ~/.claude]");
  process.exit(0);
}

const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid port: ${values.port}`);
  process.exit(1);
}

const claudeDir = values["claude-dir"] ?? defaultClaudeDir();
const server = createDashboard({ claudeDir });

server.on("error", (e: NodeJS.ErrnoException) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${port} is already in use (try --port).` : e.message);
  process.exit(1);
});

// Loopback only: this tool is never exposed on the network.
server.listen(port, "127.0.0.1", () => {
  console.log(`agents-dashboard → http://127.0.0.1:${port}`);
  console.log(`reading ${claudeDir}`);
});
