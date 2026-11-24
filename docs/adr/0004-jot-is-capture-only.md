# Jot is capture-only

Jot v1 was a to-do list: tick to Done, edit, swipe to delete, Copy all and Share. Jot v2 only captures. It shows the mic, a status line, and a strip of recent Captures where you can undo, fix a mis-heard word or retry a Failed Capture. Triage and completion belong to Processors reading the Inbox. Each Item's lifecycle then has one owner, "Done" (v1) never collides with "processed" (Inbox), and Jot stays instant to open.

## Consequences

- Tick and Done, swipe-to-delete, and Copy all and Share are removed from Jot.
- An Item's text can be corrected from Jot only while it's still in the Inbox.
- The v1 list (in the phone's browser storage) is imported once, on Jot's first sign-in: open tasks become Items in the Inbox, done tasks become processed by `jot-v1`, and deleted tasks are dropped. Original times are kept and there are no Recordings. The v1 storage is left alone for 30 days and then cleared.
