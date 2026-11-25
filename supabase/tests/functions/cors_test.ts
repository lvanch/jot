// CORS for the transcribe function: browsers get it only from Jot's origin (spec §5).
//
// This runs only against the functions served directly (serve_local.ts, FUNCTIONS_URL=http://127.0.0.1:8787). The
// local stack's gateway has Kong's cors plugin on /functions/v1, which answers every preflight itself with
// `Access-Control-Allow-Origin: *` before the function sees it. The hosted platform passes preflights to the
// function, so the function's own answer is what production browsers get. CI runs this file both ways; through the
// gateway it's reported as ignored.

import { assert, assertEquals } from "jsr:@std/assert@1.0.13";

const API_URL = Deno.env.get("API_URL") ?? "http://127.0.0.1:54321";
const FUNCTIONS = Deno.env.get("FUNCTIONS_URL") ?? `${API_URL}/functions/v1`;
const VIA_GATEWAY = new URL(FUNCTIONS).origin === new URL(API_URL).origin;

const preflight = async (origin: string) => {
  const res = await fetch(`${FUNCTIONS}/transcribe`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization",
    },
  });
  await res.body?.cancel();
  return res;
};

Deno.test({
  name: "transcribe gives CORS to Jot's origin and to no other",
  ignore: VIA_GATEWAY,
  async fn() {
    const jot = await preflight("https://lvanch.github.io");
    assert(jot.status < 300, `preflight status ${jot.status}`);
    assertEquals(jot.headers.get("access-control-allow-origin"), "https://lvanch.github.io");
    assertEquals(jot.headers.get("vary"), "Origin");

    const other = await preflight("https://evil.example");
    assertEquals(other.headers.get("access-control-allow-origin"), null);
  },
});
