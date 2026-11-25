# Jot

Say it, and it's in your Inbox. Jot is a one-tap voice capture app for your phone. Each Recording is transcribed in
the cloud and parked as an Item in the **Inbox**, a small Supabase backend that other apps and agents read and
process. Terms in bold are defined in [`CONTEXT.md`](CONTEXT.md).

- [`app/`](app/): Jot itself, a PWA with no build step.
- [`supabase/`](supabase/): the Inbox (database, row-level security, Edge Functions). How to run it locally is in its
  [README](supabase/README.md).
- [`docs/inbox-contract.md`](docs/inbox-contract.md): **for anything that reads or processes the Inbox.** Fields,
  states, permissions, examples, and the runbooks for adding and revoking processor agents.
- [`docs/spec/jot-v2.md`](docs/spec/jot-v2.md): the build spec. [`docs/adr/`](docs/adr/): why it's built this way.
- [`test/`](test/): unit tests (`npm run test:unit`) and end-to-end tests against the local stack
  (`npm run test:e2e`).
- [`.github/workflows/`](.github/workflows/): CI on every push (`ci.yml`). Deploys (`deploy.yml`): the backend from
  `v2` and `main`, and Jot to GitHub Pages from `main`.
