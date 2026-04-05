import dotenv from "dotenv";

import { loadConfig } from "./config";
import { startServer } from "./server";

dotenv.config();

async function main(): Promise<void> {
  const config = loadConfig();
  await startServer(config);
}

void main().catch((error) => {
  console.error(`${new Date().toISOString()} [agent-voice-adapter] failed to start`, error);
  process.exitCode = 1;
});
