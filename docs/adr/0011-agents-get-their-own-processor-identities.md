# Agents get their own processor identities

Each headless agent, such as Claude Code or a scheduled Processor, signs in as its own Supabase Auth user with the `processor` role:
- **Can:** read Items, and process them.
- **Can't:** edit Text, discard Items, or touch the Vocabulary.
- **Attribution:** `processed_by` comes from the agent's identity, so its actions show up separately from yours.
- **Revoking:** delete that user. That one agent loses access and nothing else changes.

We rejected letting agents sign in as you (their actions couldn't be told apart, and none could be revoked alone). We also rejected the service-role key, because it bypasses every rule.

## Consequences

- "Single user" now means one Owner plus agent members. Row-level security checks membership and role, not just the Owner's id.
- An agent's password lives only in that agent's own environment and is never committed.
