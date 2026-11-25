# Owner setup

The steps only the **Owner** can do, because they need your accounts: the Supabase project, ElevenLabs, GitHub settings and the keep-alive. Tracked in issue #2. Do them in this order. Each step says what to send the agent, if anything.

> [!IMPORTANT]
> Secrets go only into Supabase, GitHub and your password manager. Never paste them into the repo, an issue or a chat. The project ref and the publishable key aren't secrets: send those to the agent.

## 1. Create the Supabase project

1. Sign in to [supabase.com](https://supabase.com/dashboard) **with the email you'll sign in to Jot with**. Until a custom email server is set up, Supabase's built-in email only sends sign-in codes to members of the project's organization, and at most **2 emails an hour**.
2. **New project:** Free plan, region **Sydney (`ap-southeast-2`)**, name `jot`. Let it generate the database password, and save that password in your password manager.
3. Copy two values and send them to the agent:
   - the **project ref**: Project Settings → General (it's also the subdomain in `https://<ref>.supabase.co`);
   - the **publishable key**: Project Settings → API Keys (`sb_publishable_…`).

The agent puts them in `app/config.js` and the CSP tag in `app/index.html`.

## 2. Let GitHub deploy the backend

1. Make a Supabase **access token**: Account (top right) → Access Tokens → Generate new token. Name it `jot-github-deploy`.
2. In GitHub: lvanch/jot → Settings → Secrets and variables → Actions.
   - **Secrets** tab: `SUPABASE_ACCESS_TOKEN` (the token) and `SUPABASE_DB_PASSWORD` (from step 1).
   - **Variables** tab: `SUPABASE_PROJECT_REF` (the ref).
3. Tell the agent. Its next merge into `v2` runs the Deploy workflow, which applies the migrations and deploys the `transcribe` and `health` functions. The agent checks the Actions log.

Leave Settings → Pages alone until cut-over (#14).

## 3. Auth

In the Supabase dashboard, under Authentication:

1. **Sign In / Providers:** turn **off** "Allow new users to sign up". Under Email, leave it enabled, with the OTP length at 6 and expiry at 3600 s.
2. **Emails → Templates → Magic Link:**
   - **Subject:** `Your Jot sign-in code`
   - **Body:** paste the following. It's the same as `supabase/templates/magic_link.html`.

     ```html
     <h2>Your Jot sign-in code</h2>
     <p style="font-size: 28px; font-weight: 700; letter-spacing: 0.2em;">{{ .Token }}</p>
     <p>Type it into Jot. It works once and expires in an hour.</p>
     <p>If you didn't ask for it, ignore this email.</p>
     ```

3. **Users → Add user → Create new user:** your email, any long random password (you won't use it), and tick **Auto Confirm User**.
4. **After step 2's deploy has run**, open the SQL Editor and make yourself the Owner, with your email in place of the example:

   ```sql
   insert into public.members (user_id, role, name)
   select id, 'owner', 'owner' from auth.users where email = 'you@example.com';
   ```

   It should say `INSERT 0 1`. If it says `INSERT 0 0`, the email doesn't match the user from item 3.

## 4. ElevenLabs

1. Make an API key for the hosted function, separate from any other key you use. Restrict it to **Speech to Text** only.
2. Billing: use **prepaid credit**, or a plan with **usage-based (overage) billing off**. Turn on a **low-balance alert**. Jot's own cap is 50 transcriptions a day (ADR-0008); this is the backstop.
3. Set it as a function secret: Supabase dashboard → Edge Functions → Secrets → add `ELEVENLABS_API_KEY`. Leave `TRANSCRIBER` unset, so the real Transcriber is used. Never set `ALLOW_FAKE_TRANSCRIBER` here.

## 5. Keep-alive

Once the functions are deployed (step 2), at [cron-job.org](https://cron-job.org):

- **URL:** `https://<ref>.supabase.co/functions/v1/health`, method GET.
- **Schedule:** every 2 days.
- **Notifications:** on failure, to your email.

Run it once by hand. The response should be `{"ok":true}`.

## 6. What the agent needs from you

Send these as a comment on #2 or in chat:

- **Your starting Vocabulary:** the names, places and jargon Jot gets wrong. Up to 100 terms, each at most 50 characters and 5 words. The agent loads them with one SQL statement, or you can type them into Jot's Vocabulary screen later.
- ~~The URL your installed Jot opens today.~~ Done: `https://lvanch.github.io/jot/app/`. At cut-over you'll re-add Jot from `/jot/` and re-point the power-button shortcut. v1's list still imports, because it's on the same `lvanch.github.io` origin (`docs/cut-over.md`).

## Then

The agent checks the deployed backend: the migrations are applied, `health` answers, and a sign-in code arrives in your inbox. Cut-over (#14) comes after that.
