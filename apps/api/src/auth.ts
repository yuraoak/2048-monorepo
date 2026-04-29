import { createClient, Errors } from "@farcaster/quick-auth";
import type { Context, Next } from "hono";

const client = createClient();
const domain = process.env.MINIAPP_DOMAIN;
if (!domain) {
  throw new Error(
    "MINIAPP_DOMAIN is required (host where the mini app frontend is served, e.g. 2048-web.up.railway.app)"
  );
}

export async function farcasterAuth(c: Context, next: Next) {
  const auth = c.req.header("Authorization");
  if (!auth?.startsWith("Bearer ")) {
    return c.json({ error: "missing token" }, 401);
  }
  try {
    const payload = await client.verifyJwt({ token: auth.slice(7), domain: domain! });
    c.set("fid", Number(payload.sub));
  } catch (e) {
    if (e instanceof Errors.InvalidTokenError) {
      return c.json({ error: "invalid token" }, 401);
    }
    throw e;
  }
  await next();
}
