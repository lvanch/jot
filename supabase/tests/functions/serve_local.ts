// Serves the Edge Functions on the host with Deno, for machines where the edge-runtime container can't fetch
// npm packages (e.g. behind an egress proxy). The platform's verify_jwt check doesn't run here; the functions'
// own auth does. Point the tests at it with FUNCTIONS_URL=http://127.0.0.1:8787.
//
//   eval "$(supabase status -o env)"
//   SUPABASE_URL=$API_URL SUPABASE_PUBLISHABLE_KEY=$PUBLISHABLE_KEY SUPABASE_SECRET_KEY=$SECRET_KEY \
//   SUPABASE_JWKS_URL=$API_URL/auth/v1/.well-known/jwks.json \
//   deno run --allow-net --allow-env --allow-read --env-file=supabase/tests/functions/test.env \
//     --config supabase/functions/transcribe/deno.json supabase/tests/functions/serve_local.ts

import transcribe from "../../functions/transcribe/index.ts";
import health from "../../functions/health/index.ts";

const routes: Record<string, { fetch: (req: Request) => Promise<Response> }> = { transcribe, health };
const port = Number(Deno.env.get("PORT") ?? 8787);

Deno.serve({ port, hostname: "127.0.0.1" }, (req) => {
  const name = new URL(req.url).pathname.replace(/^\/(functions\/v1\/)?/, "").split("/")[0];
  const route = routes[name];
  return route ? route.fetch(req) : Response.json({ error: "not_found" }, { status: 404 });
});
