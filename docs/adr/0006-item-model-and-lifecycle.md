# Item model: immutable Transcript, three states, every Recording kept

Each Item stores its Transcript exactly as the Transcriber returned it and never changes it. Next to it sits an editable Text, which you can correct while the Item is in the Inbox. That keeps a record of what the Transcriber actually heard, so accuracy and Vocabulary changes can be judged later.

An Item is in one of three states:
- in the Inbox;
- processed, which is final and records who processed it and an Outcome;
- discarded, which can be restored to the Inbox.

There's no "claimed" state until a second Processor exists.

Every Recording is kept. That makes it possible to re-transcribe a mis-heard Item, and to try a new Transcriber on real audio before switching. At about 60 MB a year against 1 GB of free storage, we revisit this at 80% full.

## Fields (as agreed; names are indicative)

- **Identity:** `id`, chosen by Jot for each Capture so that retries never park twice.
- **Wording:** `transcript`, which never changes, and `text`, which you can edit.
- **Times:** `captured_at` from the phone's clock and `parked_at` from the server's.
- **State:** `status` and `status_at`.
- **Processing:** `processed_by` and `outcome`, a free-form JSON object.
- **Provenance:** `source` (`jot`, or `jot-v1` for imported Items), `device`, `transcriber` (vendor and model), `language` and `duration_ms`.
- **Extras:** a reference to the Recording, and `meta` (free-form JSON).
