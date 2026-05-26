import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is required");
}

const needsSsl = /sslmode=require|render|amazonaws|supabase|neon/i.test(url);

export const sql = postgres(url, {
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  max: 10,
});
