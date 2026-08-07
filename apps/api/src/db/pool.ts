import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL ?? "postgresql://ident:ident@localhost:5432/ident";

export const pool = new Pool({ connectionString });

export async function checkDbHealth(): Promise<"ok" | "unreachable"> {
  try {
    await pool.query("SELECT 1");
    return "ok";
  } catch {
    return "unreachable";
  }
}
