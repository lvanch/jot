# Vendored libraries

Jot has no build step, and its CSP only allows same-origin scripts, so third-party code is copied in here.

| File | Package | Version | Source in the npm tarball | sha256 |
|---|---|---|---|---|
| `supabase.js` | `@supabase/supabase-js` | 2.119.0 | `dist/umd/supabase.js` | `a867edbcfb029370aeec7223dd6180b560b621fbe3bc64c6584fb0369d1b7bce` |

`supabase.js` is the UMD build. It's loaded as a classic script and defines `window.supabase`. It doesn't use `eval` or `new Function`.

To upgrade, run `npm pack @supabase/supabase-js@<version>` and copy `package/dist/umd/supabase.js` here. Then update this table, and bump `CACHE` in `../sw.js`. Keep the version in step with `supabase/functions/*/deno.json`.
