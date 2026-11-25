# Cut-over: Jot v2 goes live

The runbook for #14 (spec §9–§10). It moves the phone from v1 to v2, then runs the acceptance checks. Do the steps in order.

## Before you start

All of these must be true:

- **Owner setup (#2) is finished:**
  - the Deploy workflow has run green on `v2`, and `https://<ref>.supabase.co/functions/v1/health` answers `{"ok":true}`;
  - your `members` row exists;
  - the ElevenLabs secret is set;
  - the email template shows the code.
- **The real project is in the app:** `app/config.js` and the CSP tag in `app/index.html` hold the project ref and publishable key. The agent does this once you've sent them.
- **CI is green on `v2`.**
- **v1's address is known.** This runbook assumes the installed Jot opens `https://lvanch.github.io/jot/app/`, which is GitHub Pages serving `main` from the branch. If it opens anywhere else, **stop and tell the agent.** Browser storage belongs to one origin, so v2 on `lvanch.github.io` can only import a v1 list stored on `lvanch.github.io`.

## What happens to the old address

After cut-over, Pages serves `app/` at `https://lvanch.github.io/jot/`. The old address `/jot/app/` then serves a small "Jot has moved" page (`app/app/`). Alongside it is a service worker that replaces v1's. The first time the old shortcut opens, v1's worker picks up the replacement, which removes itself and shows the moved page. Without it, v1 would keep running from its cache. Nothing touches v1's list, which v2 imports from the same storage. `test/e2e/cutover.test.mjs` rehearses all of this.

## Steps

1. **Back up v1's list.** In v1, tap Share and save the text somewhere (Keep, email to yourself). It only has the open tasks, without their times; the import carries everything, so this is just in case.
2. **Optional dress rehearsal on a laptop.** Serve `app/` locally, for example with `npx http-server app -p 8080`, and open `http://localhost:8080`. The `transcribe` function accepts loopback origins. Sign in, record once, and check that the Item appears. This tries v2 against the real backend before the phone depends on it.
3. **Switch Pages to Actions.** GitHub → Settings → Pages → Build and deployment → Source: **GitHub Actions**. The site keeps serving its last deployment until the next one, so v1 stays up for now.
4. **Merge `v2` into `main`.** Ask the agent to open and merge the PR. The Deploy workflow runs the backend job, then the Pages job, which publishes `https://lvanch.github.io/jot/`. The agent checks the run, and that CI is green on `main`.
5. **On the phone:**
   1. Open the old Jot from its shortcut. It shows "Jot has moved". If it still shows v1, close it and open it once more.
   2. Tap **Open the new Jot**. In Chrome's ⋮ menu, choose **Add to home screen** (or **Install**).
   3. Sign in with the emailed code. Expect **"Imported N items from Jot v1"**.
   4. Point the double-press-power shortcut at the new Jot, wherever you set it up for v1.
   5. Only after the import message, remove the old Jot from the home screen.

## Acceptance (spec §10)

Tick each in #14.

1. **Happy path.** Double-press power and say "Call Ngaio about the Fremantle lease" (with both in your Vocabulary), then stop. In about 3 s the Item shows in Recent, spelled right. In Supabase: Table Editor → `items` has the row, `status = inbox`, with a `recording_path`; Storage → `recordings` has the file.
2. **Undo.** Capture, then tap Undo within 5 s. The row shows Discarded, and `items.status` is `discarded`.
3. **Offline.** In airplane mode, capture twice. The status line says `Offline · 2 queued`. Turn airplane mode off, and both park, once each (two rows, no duplicates).
4. **Agent identity.** Add the `claude` processor using [`inbox-contract.md`](inbox-contract.md) (Runbook: add a processor). As that agent, it can list and process Items, and is refused `discard_item` and `edit_item_text`, and reads no Vocabulary. The contract's curl examples check each.
5. **Daily cap.** Verified in CI, not with real credit:
   - `supabase/tests/functions/transcribe_test.ts` ("the 51st transcription of a Perth day is 429 until Perth midnight");
   - the queue's handling of it in `test/e2e/queue.test.mjs`.
6. **v1 import.** In the `items` table, filter `source = jot-v1`. Open tasks are `inbox` and done ones `processed`, with `captured_at` matching when you made them. Compare against the backup from step 1.
7. **Deploys.** Step 4's Deploy run is green, and CI is green on `main`.

## Afterwards

- **Keep-alive.** cron-job.org pings `health` every 2 days (#2). Over the first fortnight, check the project hasn't paused. If it does, note how Jot and the API behaved (spec ⚠, ADR-0012).
- **Surprises.** Record anything that turned out different from the spec or ADRs (the key-term limit, the paused-project response, phone behaviour) in those documents.

## Rollback

1. Revert the merge on `main`: GitHub's Revert button on the cut-over PR, then merge the revert. Deploy then publishes v1's `app/` at `/jot/`.
2. To bring back the old address `/jot/app/` itself, set Pages → Source back to **Deploy from a branch**: `main`, `/ (root)`.
3. v1's list is still on the phone: the import leaves v1's storage alone for 30 days. The backend can stay as it is.
