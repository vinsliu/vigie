// `npm run demo`: serve Vigie on made-up data, never on your real ~/.claude.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createDashboard } from "../src/server/index.ts";
import { generateDemo } from "./demo-data.ts";

const { values } = parseArgs({ options: { port: { type: "string", short: "p", default: "4318" } } });
const port = Number(values.port);

const dir = await mkdtemp(join(tmpdir(), "vigie-demo-"));
const { claudeDir, dataDir, sessions } = await generateDemo(dir);
const server = createDashboard({ claudeDir, dataDir });

const stop = async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

server.on("error", async (e: NodeJS.ErrnoException) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${port} is already in use (try --port).` : e.message);
  await rm(dir, { recursive: true, force: true });
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => {
  console.log(`vigie demo → http://127.0.0.1:${port}  (${sessions} made-up sessions, nothing of yours is read)`);
});
