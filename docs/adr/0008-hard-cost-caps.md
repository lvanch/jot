# Hard cost caps

A small spend is fine; a runaway spend isn't. So:

- **Recording length.** Recordings are capped at 60 s. Jot stops recording at that point, and the server rejects anything longer.
- **Daily limit.** The server parks at most 50 Captures per Perth calendar day. Past that it refuses, and Jot keeps them as Queued Captures until the next day.
- **ElevenLabs billing.** ElevenLabs runs on prepaid credit, or on a plan with overage billing turned off, plus a low-balance alert.
- **Supabase plan.** Supabase stays on the Free plan, which can't bill you.

## Consequences

- A 51st Capture in one day waits until midnight Perth time (UTC+8). That's intended.
- These limits apply at the server, so they also cover any future app that sends Recordings.
- Calls the Transcriber couldn't take (an outage, our key or credit) aren't billed, so they don't count towards the day. Otherwise Jot's retries during an outage could use up the cap.
