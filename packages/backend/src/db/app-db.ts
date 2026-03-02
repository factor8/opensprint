import pg from "pg";
import type { DbClient } from "./client.js";
import { createPostgresDbClient, getPoolConfig } from "./client.js";
import { runSchema } from "./schema.js";

export interface AppDb {
  getClient(): Promise<DbClient>;
  runWrite<T>(fn: (client: DbClient) => Promise<T>): Promise<T>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/** Tag app connections so PG logs show application_name=opensprint-app. */
function addApplicationName(url: string, name: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("application_name", name);
    return u.toString();
  } catch {
    return url;
  }
}

export async function initAppDb(databaseUrl: string): Promise<AppDb> {
  const urlWithAppName = addApplicationName(databaseUrl, "opensprint-app");
  const pool = new pg.Pool(getPoolConfig(urlWithAppName));

  // Startup probe: verify PostgreSQL is reachable before doing anything else
  try {
    const probeClient = await pool.connect();
    await probeClient.query("SELECT 1");
    probeClient.release();
  } catch (err) {
    await pool.end().catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    let host = "localhost";
    let portStr = "5432";
    try {
      const u = new URL(databaseUrl);
      host = u.hostname || host;
      portStr = u.port || portStr;
    } catch { /* ignore parse errors */ }
    throw new Error(
      `Cannot connect to PostgreSQL at ${host}:${portStr} — is it running?\n` +
      `  Original error: ${message}\n` +
      `  Hints:\n` +
      `    • Make sure PostgreSQL is installed and running (e.g. brew services start postgresql)\n` +
      `    • Check that the database exists (createdb opensprint)\n` +
      `    • Verify DATABASE_URL or ~/.opensprint/global-settings.json`
    );
  }

  const client = createPostgresDbClient(pool);
  await runSchema(client);

  return {
    async getClient(): Promise<DbClient> {
      return client;
    },
    async runWrite<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
      return client.runInTransaction(fn);
    },
    async ping(): Promise<boolean> {
      try {
        await pool.query("SELECT 1");
        return true;
      } catch {
        return false;
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
