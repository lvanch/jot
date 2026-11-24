// GET /functions/v1/health: the keep-alive target (ADR-0012, spec §5).
// No auth (verify_jwt = false in config.toml). It touches the database so the project counts as active,
// and returns only { ok }.

import { createSupabaseContext } from "@supabase/server";

export default { fetch: serve };

async function serve(req: Request): Promise<Response> {
  // Public and data-free, so any origin may read it: Jot calls it from the browser to tell "the Inbox is asleep"
  // apart from "the Transcriber is down".
  const headers = { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };
  if (req.method !== "GET" && req.method !== "HEAD") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers });
  }
  try {
    const { data: ctx, error } = await createSupabaseContext(req, { auth: "none", cors: "disabled" });
    if (error) {
      console.error("health: setup", error.code);
      return Response.json({ ok: false }, { status: 503, headers });
    }
    const probe = await ctx.supabaseAdmin.from("members").select("user_id", { count: "exact", head: true });
    if (probe.error) {
      console.error("health: database", probe.error.code);
      return Response.json({ ok: false }, { status: 503, headers });
    }
    return Response.json({ ok: true }, { headers });
  } catch (err) {
    console.error("health: unhandled", err instanceof Error ? err.name : "error");
    return Response.json({ ok: false }, { status: 503, headers });
  }
}
