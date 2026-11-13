# Jot v2 and the Inbox: build spec

This spec turns the settled design into buildable detail. Vocabulary: [`CONTEXT.md`](../../CONTEXT.md). Rationale: [`docs/adr/`](../adr/). If this spec and an ADR disagree, the ADR wins; fix the spec.

Values marked **⚠ verify** are unconfirmed, because the vendors' docs were unreachable while this was written. The ticket that touches each one confirms it against the official docs or a live call.

## 1. Scope

**In**
- Jot v2: capture-only PWA (ADR-0004).
- Supabase backend in Sydney: schema, row-level security (RLS), lifecycle functions, the `transcribe` and `health` functions, and a Recordings bucket.
- Transcriber seam with an ElevenLabs Scribe v2 adapter.
- One-time import of the v1 list.
- Deploys through GitHub Actions; CSP in a meta tag.
- Keep-alive.
- `docs/inbox-contract.md` for Processors.

**Out (follow-ups)**
- The "Add to Vocabulary?" prompt on corrections.
- A Recording pre-roll buffer.
- A "claimed" state.
- Moving the backend to its own repo.
- Any Processor app.

**Deleted**
- `api/` (jot-api).
- Jot's sync/outbox code, and the list, tick, swipe and share UI.
- `app/_headers`.
- The v1 e2e test (`test/e2e.mjs`), which gets rewritten.

## 2. Architecture

```
Jot (lvanch.github.io/jot, GitHub Pages)
  ├─ supabase-js (vendored) ── Auth: email code sign-in, session in localStorage
  ├─ IndexedDB: Recordings of Queued and Failed Captures
  └─ HTTPS ─► Supabase project (ap-southeast-2, Free plan)
               ├─ Edge Function transcribe ─► Transcriber seam ─► ElevenLabs Scribe v2
               ├─ Edge Function health   ◄── cron-job.org every 2 days
               ├─ Postgres: members, items, vocabulary, transcription_log + lifecycle functions
               └─ Storage: private bucket "recordings"
Processors (future apps, agents) ─► Supabase directly, via supabase-js or REST, under RLS
```

Repo layout (ADR-0009):

```
app/                 Jot (static; published as-is by the workflow)
supabase/            config.toml, migrations/, functions/{transcribe,health,_shared}/, tests/
docs/                adr/, spec/, inbox-contract.md
test/                end-to-end tests (Playwright)
.github/workflows/   deploy.yml, ci.yml
```

## 3. Data model

All tables live in `public`. Times are `timestamptz`. "Perth day" means `(now() AT TIME ZONE 'Australia/Perth')::date`.

### `members`

Membership decides who may do what (ADR-0005, ADR-0011).

| column | type | notes |
|---|---|---|
| `user_id` | uuid PK → `auth.users` | |
| `role` | text | `'owner'` or `'processor'` |
| `name` | text, unique | Shown as `processed_by`, e.g. `owner` or `claude` |

- At most one `owner` row: enforce it with a partial unique index.
- Helper functions, all `SECURITY DEFINER` and `STABLE`, with `search_path` set:
  - `is_member()`
  - `is_owner()`
  - `member_name()`

### `items`

| column | type | notes |
|---|---|---|
| `id` | text PK | Chosen by Jot for each Capture (a UUID). Must match `^[A-Za-z0-9_-]{1,64}$`; v1 ids pass too. |
| `transcript` | text not null | Never updated. A trigger blocks changes. |
| `text` | text not null | 1–2000 characters, not blank. Starts equal to `transcript`. |
| `captured_at` | timestamptz not null | Phone clock |
| `parked_at` | timestamptz not null default now() | Server clock |
| `status` | text not null default `'inbox'` | `'inbox'`, `'processed'` or `'discarded'` |
| `status_at` | timestamptz not null default now() | |
| `processed_by` | text null | Set when the Item is processed: a member `name`, or `jot-v1` |
| `outcome` | jsonb null | Free-form note from the Processor, set when the Item is processed |
| `source` | text not null | `'jot'` or `'jot-v1'` |
| `device` | text null | e.g. `phone` |
| `transcriber` | text null | e.g. `elevenlabs/scribe_v2` |
| `language` | text null | |
| `duration_ms` | int null | |
| `recording_path` | text null | Path in the `recordings` bucket |
| `meta` | jsonb not null default `'{}'` | Transcriber extras (e.g. language probability); at most 16 KB |

- **Check constraint:** a processed Item must have `processed_by` set.
- **Index:** `(status, parked_at)`.
- **Realtime:** add `items` to the `supabase_realtime` publication.

### `vocabulary`

| column | type | notes |
|---|---|---|
| `id` | bigint identity PK | |
| `term` | text not null | Trimmed, 1–50 characters |
| `created_at` | timestamptz default now() | |

- `term` is unique on `lower(term)`.
- A trigger caps the table at 100 rows (ADR-0007).

### `transcription_log`

One row per call to the Transcriber. This drives the daily cap and gives cost visibility.

`id` bigint identity, `at` timestamptz default now(), `item_id` text, `duration_ms` int, `outcome` text (`'parked'`, `'empty'`, `'refused'` or `'unavailable'`).

### Storage

- A private bucket `recordings`, with objects at `{item_id}.{ext}`.
- Only server functions write to it.
- Members may read it (for example through signed URLs).

### RLS and grants

| table | owner | processor | anon |
|---|---|---|---|
| `items` | select | select | none |
| `vocabulary` | select, insert, delete | none | none |
| `transcription_log` | select | none | none |
| `members` | select own row | select own row | none |

- Nobody gets direct `insert`, `update` or `delete` on `items`. Every change goes through the functions in §4, or through the service role inside `transcribe`.

## 4. Lifecycle functions (RPC)

These are callable from any client through `supabase.rpc(...)` and are the only way to change an Item.

- Each runs as `SECURITY DEFINER` and checks the caller's role first.
- Each returns the updated Item row.
- **Errors:** each raises a Postgres exception with a stable code in its message: `not_allowed`, `not_found`, `wrong_state`, `invalid_text`.
- **Repeats:** calling again when the Item is already in the target state returns it unchanged.

| function | who | transition |
|---|---|---|
| `process_item(item_id text, outcome jsonb default null)` | owner, processor | `inbox → processed`; sets `processed_by = member_name()`. Repeating it is a no-op only for the same `processed_by`; otherwise it raises `wrong_state`. |
| `discard_item(item_id text)` | owner | `inbox → discarded` |
| `restore_item(item_id text)` | owner | `discarded → inbox` |
| `edit_item_text(item_id text, new_text text)` | owner | Only while `inbox`. `new_text` is trimmed and must be 1–2000 characters. |
| `import_v1_items(rows jsonb)` | owner | See §7. Returns `{inserted, skipped}`. |

Every transition sets `status_at = now()`.

## 5. Edge Functions

### Transcriber seam (`supabase/functions/_shared/transcriber/`)

```ts
interface TranscribeInput { audio: Blob; mimeType: string; vocabulary: string[]; language: 'en' }
interface TranscribeResult { text: string; language: string | null; model: string; meta: Record<string, unknown> }
interface Transcriber { name: string; transcribe(input: TranscribeInput): Promise<TranscribeResult> }
class TranscriberUnavailable extends Error {}  // network errors, timeouts, 5xx, 429 → retryable
class TranscriberRefused extends Error {}      // 4xx because of the audio itself → permanent
```

- Adapters: `elevenlabs.ts` and `fake.ts`.
- `getTranscriber()` picks one from the env var `TRANSCRIBER`, defaulting to `elevenlabs`.
- `fake` returns deterministic text (`'fake transcript <bytes>'`, or `''` when the audio is under 1 KB) and refuses to load unless `ALLOW_FAKE_TRANSCRIBER=1`. It's for tests only.

**ElevenLabs adapter**
- Request: `POST https://api.elevenlabs.io/v1/speech-to-text`, header `xi-api-key: $ELEVENLABS_API_KEY`, multipart body. **⚠ verify** the auth header name.
- Fields:
  - `model_id=scribe_v2`
  - `file`
  - `language_code=en`: **⚠ verify** whether it takes `en` or `eng`.
  - `keyterms`: only when the Vocabulary isn't empty. **⚠ verify** how the array is encoded in multipart, the term limit (100 or 1000), and the per-term length limit.
  - `tag_audio_events=false`, so tags like "(laughs)" don't land in the text.
  - `diarize=false`
- Text: use the response's `text`. Put the language and its probability into `meta`. **⚠ verify** the response shape.
- Timeout: 30 s.
- Never log the audio, the text or the key.

### `transcribe`

`POST /functions/v1/transcribe`

**Auth.** Requires `Authorization: Bearer <user access token>`, and the caller must be the owner. The function validates the token itself with supabase-js; it doesn't rely only on the gateway's `verify_jwt`. **⚠ verify** current Supabase guidance for the new API keys.

**Request.** `multipart/form-data` with these fields:
- `id`: the Item id.
- `captured_at`: ISO time.
- `duration_ms`.
- `device`.
- `audio`: a file with MIME type `audio/webm`, `audio/ogg` or `audio/mp4`, at most 1 MB.

**Steps:**

1. **Auth and role.** A bad token or a non-owner gets `401 {error:'unauthorized'}`.
2. **Validate.** Bad fields get `400 {error:'bad_request'}`. Audio over 1 MB, or a duration over 61 s, gets `413 {error:'too_large'}`.
3. **Idempotency.** If an Item with this `id` exists, return `200 {item}` without transcribing again.
4. **Daily cap.** If `transcription_log` has 50 or more rows for today's Perth day, return `429 {error:'daily_cap', retry_at:<next Perth midnight ISO>}`.
5. **Store the Recording.** Upload the audio to `recordings/{id}.{ext}` (upsert).
6. **Transcribe.** Load the Vocabulary and call `transcriber.transcribe(...)`.
   - `TranscriberUnavailable`: log `unavailable` and return `502 {error:'transcriber_unavailable'}`.
   - `TranscriberRefused`: log `refused`, delete the stored Recording, and return `422 {error:'transcriber_refused'}`.
7. **Empty text** (after trimming): log `empty`, delete the stored Recording, and return `200 {item:null, empty:true}`.
8. **Park.** Insert the Item with `transcript = text = trimmed text` and `source='jot'`, using `ON CONFLICT (id) DO NOTHING` and then a select. Log `parked` and return `201 {item}`.

**Responses.** Every response is JSON with CORS headers allowing Jot's origin, and the function answers OPTIONS preflights.

### `health`

`GET /functions/v1/health`
- Needs no auth (`verify_jwt = false`).
- Runs one trivial query against the database with the service role and returns `200 {ok:true}`, or `503`.
- Exposes no data.

### Secrets

These are set by hand with `supabase secrets set` and never committed:
- `ELEVENLABS_API_KEY`
- `TRANSCRIBER` (left unset in production)

## 6. Jot (client)

Jot is plain JavaScript split into ES modules (`<script type="module">`). It has no build step, and supabase-js is vendored at a pinned version in `app/vendor/`.

The modules that hold logic stay pure and get unit tests:
- `silence.js`: the stop decision.
- `queue.js`: retry and backoff.
- `v1import.js`: the v1-to-Item mapping.

**Config.** `app/config.js` holds `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. Neither is a secret.

### Screens

- **Sign-in.** It's shown when there's no session. The user enters an email, which triggers `signInWithOtp({ email, options: { shouldCreateUser: false } })`, then types the 6-digit code, which calls `verifyOtp({ type: 'email' })`. Captures made before sign-in still record and queue.
- **Capture** (the main screen), from top to bottom:
  - the mic button, plus the floating mic as in v1;
  - the status line;
  - a Vocabulary button;
  - the recent-Captures strip.
- **Vocabulary.** A list of terms with delete buttons, an add field (trimmed, 1–50 characters, duplicates checked case-insensitively), and an `n/100` count. It writes straight to the `vocabulary` table.

### Recording (ADR-0003)

**Starting.** Jot auto-starts when it comes to the foreground on a coarse-pointer device, as v1 does. Otherwise you tap to start. A tap during recording stops it.

**Mic and format.**
- `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })`.
- `MediaRecorder` at `audioBitsPerSecond: 32000`, using the first supported type from `audio/webm;codecs=opus`, `audio/ogg;codecs=opus`, `audio/mp4`.

**Silence detection.** An `AnalyserNode` measures the RMS level every 50 ms.
- Speech starts when the level stays above `SPEECH_DB` for 150 ms.
- After speech has started, 1500 ms below `SILENCE_DB` stops the recording.
- If no speech arrives within 8 s, the recording stops and is thrown away, and the status says "Didn't catch that". Nothing is uploaded.
- `SPEECH_DB` and `SILENCE_DB` are tunable constants.

**Limits and interruptions.**
- **Hard cap:** 60 s, after which Jot stops and uploads.
- **Going to the background mid-recording:** Jot stops. If speech had been detected it uploads; otherwise it throws the recording away.

**After stopping.** The Capture `{ id: crypto.randomUUID(), blob, mimeType, capturedAt, durationMs, device }` goes into the queue and uploads straight away.

**Device name.** `phone` on coarse-pointer devices, otherwise `desktop`.

### Queue and upload

**Storage.** IndexedDB `jot` with store `captures`. Each record is `{ id, blob, mimeType, capturedAt, durationMs, device, state: 'queued'|'uploading'|'failed', attempts, lastError, nextAttemptAt }`. A record is deleted only when the server confirms it with `201`, `200 {item}`, or `200 {empty:true}`.

| Response | Action |
|---|---|
| `201`, or `200` with an item | Remove from the queue, add to the recent strip, show the toast "Parked · Undo" for 5 s |
| `200 {empty:true}` | Remove from the queue; status "Didn't catch that" |
| Network error, `5xx`, `502` | Stays queued, backoff 2 s × 2ⁿ (max 5 min, ±25 % jitter). Also retries on `online`, on foreground, and on every new Capture. |
| `429 daily_cap` | Stays queued, `nextAttemptAt = retry_at`; status "Daily limit reached · N queued" |
| `401` | Stays queued and the sign-in screen is shown |
| `413`, `422`, `400` | Marked `failed`, with Retry and Throw away in the strip |

Uploads run one at a time, in capture order, under a Web Lock across tabs.

**Status line.**

| When | Status text |
|---|---|
| Recording | `Listening…` |
| Uploading | `Transcribing…` |
| Offline (`navigator.onLine === false`) with Captures queued | `Offline · N queued` |
| Online, but the Supabase project is unreachable (a network error or `5xx` from both `transcribe` and `health`) | `Inbox asleep · N queued` |
| Nothing in progress | `Tap to speak` |

**⚠ verify** what a paused Supabase project actually returns, and match on it.

### Recent-Captures strip

**Contents.**
- Up to 10 Captures from this device in the last 24 h, newest first.
- That covers queued and failed Captures (from IndexedDB) and parked Items (cached in localStorage `jot.recent.v2` as `{id, text, status}`).
- On foreground, Jot refreshes the cached Items' `text` and `status` from `items`.

**Row actions.**

| Row | Shows | Actions |
|---|---|---|
| Item in the Inbox | Text | Tap to edit, which calls `edit_item_text`. Undo (5 s toast) calls `discard_item`. |
| Discarded Item | Struck-through Text | Restore, which calls `restore_item` |
| Processed Item | Text, read-only | None; tapping shows "Already processed" |
| Queued Capture | "Transcribing…" or "Queued" | None |
| Failed Capture | "Couldn't transcribe" | Retry, Throw away |

**Removed:** the v1 list, Done section, tick, swipe-to-delete, Copy all and Share.

### Hosting and offline

**CSP meta tag** (ADR-0013):

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:;
connect-src 'self' https://<ref>.supabase.co wss://<ref>.supabase.co; manifest-src 'self';
worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'
```

**Service worker.** Precache the shell, including the module files and the vendored supabase-js. Bump `CACHE`. Never cache Supabase requests.

**Manifest.** Keep the relative `start_url` and `scope`, so the app works under `/jot/`. Update `description`, which still says Jot "stays on your phone".

## 7. v1 import (ADR-0004)

**When.** On the first successful sign-in, if localStorage `jot.tasks.v1` exists and `jot.import.v1` isn't set.

**Mapping.**
- Tasks with `deletedAt` set are skipped.
- Open tasks become `{ id, text, created_at, status: 'inbox' }`.
- Done tasks become `{ id, text, created_at, status: 'processed', status_at: doneAt }`.
- An id that fails the id regex gets a new UUID.

**Server side.**
- Jot sends everything in one `import_v1_items` call.
- The server inserts with `source='jot-v1'`, `transcript = text`, `processed_by='jot-v1'` for done tasks, and no Recording.
- Ids that already exist are skipped, so a repeated import is safe.

**After.**
- Set `jot.import.v1 = <ms>`.
- Once that's 30 days old, delete `jot.tasks.v1`, `jot.sync.v1` and `jot.outbox.v1`.
- A failed import leaves the flag unset and is tried again on the next foreground.

## 8. Deploy, CI and operations

**`.github/workflows/deploy.yml`**
- **`pages` job:** runs on a push to `main` only. It does `actions/upload-pages-artifact` from `app/`, then `actions/deploy-pages`. The repo's Pages source is set to "GitHub Actions".
- **`backend` job:** runs on a push to `v2` or `main`. It runs `supabase link --project-ref $SUPABASE_PROJECT_REF`, `supabase db push` and `supabase functions deploy`. It uses the repo secrets `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD`, plus the repo variable `SUPABASE_PROJECT_REF`.

**`.github/workflows/ci.yml`** runs on pull requests and pushes. It runs:
- `node --test` for the client's pure modules;
- `supabase start` followed by `supabase test db` (pgTAP) for RLS and the lifecycle;
- Deno tests for the functions, using the fake Transcriber;
- Playwright end-to-end tests, with Chromium's fake mic (`--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<wav>`), against local Supabase and the fake Transcriber.

**Keep-alive (ADR-0012).** A cron-job.org job calls `GET https://<ref>.supabase.co/functions/v1/health` every 2 days and emails on failure.

**Owner-only setup.** This is done by hand and tracked in its own ticket:
- the Supabase project (Sydney), with sign-ups disabled and the email template showing `{{ .Token }}`;
- the owner user and its `members` row;
- an ElevenLabs account and key on prepaid credit with no overage billing, plus a low-balance alert;
- function secrets;
- GitHub secrets and variables;
- the Pages source;
- cron-job.org;
- the starting Vocabulary list.

## 9. Delivery

- **Branch.** All v2 work lands on an integration branch, `v2`, cut from `main` once the design docs are merged. Pull requests target `v2`. The phone keeps running v1 until cut-over.
- **Backend.** The backend deploys from `v2` as it lands, so it can be tested against the real project before cut-over.
- **Cut-over.** Merge `v2` into `main`, switch Pages to "GitHub Actions", re-add Jot to the home screen if its URL changed, and run §10 on the phone.
- **Rollback.** Revert the merge. v1 data is safe, because the import leaves v1 storage alone for 30 days.

## 10. Acceptance (whole build)

1. **Happy path.** On the CMF Phone 2 Pro: double-press power, say "Call Ngaio about the Fremantle lease", and stop talking. Within about 3 s, Jot shows the Item, spelled correctly with "Ngaio" and "Fremantle" in the Vocabulary. A row with `status='inbox'` and a Recording exists in Supabase.
2. **Undo.** Undo within 5 s, and the Item is `discarded`.
3. **Offline.** In airplane mode, capture twice and see `Offline · 2 queued`. Reconnect, and both are parked once each.
4. **Agent identity.** A `processor` agent can list Items and `process_item` them, but can't edit, discard or read the Vocabulary.
5. **Daily cap.** The 51st transcription of a Perth day gets `429`, and Jot queues it until midnight Perth time.
6. **v1 import.** v1 open and done tasks show up as Items, `inbox` and `processed`, with their original times.
7. **Deploys.** A push to `main` deploys Jot and the backend. CI is green.
