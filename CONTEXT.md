# Jot & the Inbox

Jot turns one spoken thought into one item in a shared Inbox. Future productivity apps read that Inbox and decide what each item becomes.

## Language

### Capturing

**Jot**:
The phone app that records one spoken thought and parks it in the Inbox. It captures only. It doesn't triage or complete anything.
_Avoid_: the to-do app, the list

**Capture**:
One mic session in Jot, from opening the mic to stopping it, holding at most one thought.
_Avoid_: dictation, task, note, jot (as a noun)

**Recording**:
The audio of one Capture.
_Avoid_: clip, voice note, audio file

**Transcript**:
The text the Transcriber returned for a Recording, exactly as returned.
_Avoid_: raw text, result

**Transcriber**:
The replaceable speech-to-text service that turns a Recording into a Transcript.
_Avoid_: STT, speech model, provider (except when naming the vendor)

**Vocabulary**:
Your names and jargon that the Transcriber is biased towards on every Capture.
_Avoid_: key terms, dictionary, custom words

**Successful Capture**:
A Capture whose Transcript isn't empty once whitespace is trimmed. Only Successful Captures are parked.

**Queued Capture**:
A Capture whose Recording is held on the phone because it couldn't be transcribed yet, for example when offline.
_Avoid_: pending, unsynced

**Failed Capture**:
A Capture the Transcriber refused for good. It stays on the phone until you retry it or throw it away, and it's never parked.

### The Inbox

**Inbox**:
The shared store of Items waiting for a Processor. It belongs to no single app.
_Avoid_: queue, task list, backlog

**Item**:
One parked Transcript, along with when, where and how it was captured.
_Avoid_: task, to-do, entry, note

**Park**:
To put a Successful Capture into the Inbox as an Item. It happens the moment the Transcript arrives.
_Avoid_: save, submit, sync

**Discard**:
To take an Item out of the Inbox unprocessed, for example by tapping Undo right after it's parked. The Item is kept and marked as discarded.
_Avoid_: delete

**Processor**:
An app or agent that takes Items out of the Inbox and decides what each one becomes.
_Avoid_: consumer, client, triage app

**Process**:
What a Processor does to an Item: take it out of the Inbox and record what became of it.
_Avoid_: complete, done, tick

## Flagged ambiguities

- **"Done"** (the tick in Jot v1) is not an Inbox concept and goes away with v1's list. A processed Item may have become a to-do somewhere else that isn't done yet. Processed ≠ done.
- **"Task"** meant a row in Jot v1's list. In v2 an Item isn't necessarily a task, so don't use the word for Items.
