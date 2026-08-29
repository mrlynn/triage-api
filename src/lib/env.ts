/**
 * Loads `.env.local` then `.env` into `process.env`, without overwriting
 * anything already set in the shell.
 *
 * No dependency: this is ~20 lines and avoids making learners install and
 * configure dotenv before they can make their first API call. Real env vars
 * always win, so `ANTHROPIC_API_KEY=... npm run smoke` overrides the file.
 *
 * Import this FIRST, before any module that reads process.env at import time.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

for (const filename of [".env.local", ".env"]) {
  const path = join(projectRoot, filename);
  if (!existsSync(path)) continue;

  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    // Strip one layer of matching quotes, if present.
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");

    if (!(key in process.env)) process.env[key] = value;
  }
}
