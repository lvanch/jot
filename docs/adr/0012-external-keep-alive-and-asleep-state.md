# External keep-alive, with Jot showing when the Inbox is asleep

Free Supabase projects pause after 7 days without activity. A free external pinger (cron-job.org) calls a no-auth health function every 2 days, and that function touches the database. The pinger emails you if a call fails. We rejected a GitHub Actions cron because GitHub disables scheduled workflows in public repos after 60 days with no repo activity. We also rejected Supabase Pro ($25/month) as too costly for this job.

If the project is paused anyway, nothing is lost. Jot keeps Recordings as Queued Captures and shows "Inbox asleep · N queued" until you restore the project from the dashboard.

## Consequences

- It's unverified which requests count as activity for Supabase's pause rule, because their docs aren't readable from the build sandbox. Confirm that the health check keeps the project awake during the first fortnight.
