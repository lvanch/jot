# Jot is deployed to GitHub Pages by an Actions workflow; CSP moves to a meta tag

Jot lives in `app/`. Without a workflow, GitHub Pages can only serve a branch's root or `/docs`, and it ignores `app/_headers`, which is a Cloudflare/Netlify convention. So until now Jot's CSP was never applied. A GitHub Actions workflow now publishes `app/` to Pages. On every push to `main`, the same workflow deploys the backend (database migrations and Edge Functions) using a Supabase access token stored as a repository secret. The CSP moves into a `<meta http-equiv="Content-Security-Policy">` tag. It allows same-origin scripts and connections to the Supabase project's host.

## Consequences

- Jot will be served at `https://lvanch.github.io/jot/`. If the installed app currently opens a different path, re-add it to the home screen and re-point the power-button shortcut. v1 data still imports, because browser storage belongs to the `lvanch.github.io` origin.
- A meta-tag CSP can't set `frame-ancestors`, so that protection is dropped.
- `docs/` is never published, because Pages serves only what the workflow uploads.
