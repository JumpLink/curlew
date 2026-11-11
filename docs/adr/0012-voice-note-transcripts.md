# ADR 0012 — transcripts of received voice notes

- **Status:** Proposed (2026-11-11). Decided by Pascal in chat: received voice notes, on request, local.
- **Scope:** `@curlew/store` (one table, schema v19), `app` (a `Transcriber` port, a daemon job, the
  window's player row, MCP), and gjsify for the engine. Builds on
  [ADR 0010](0010-attachments-across-protocols.md) (the attachment descriptor and the fetch path),
  [ADR 0008](0008-grants-restrict-agents-not-the-person.md) and
  [ADR 0009](0009-agent-access-per-account-and-contact.md) (what an agent may read), and
  [ADR 0011](0011-same-app-inside-and-outside-a-sandbox.md) (sandbox).
- **Engine rules live in gjsify:**
  [ADR 0127](../../../../gjsify/gjsify/docs/adr/0127-speech-recognition-on-local-engines.md) (local
  engines behind Vala bridges) and
  [ADR 0132](../../../../gjsify/gjsify/docs/adr/0132-ai-capabilities-share-one-shape.md) (one shape
  for AI capabilities, one shared model store, no silent cloud). Do not restate them here.

## Context

A voice note is the one chat message a person cannot skim, search or hand to an agent. Telegram
Premium and WhatsApp transcribe in their own cloud; Curlew must not send a friend's voice to anybody.
gjsify already ships the local pieces: `@gjsify/sherpa-native` (an `OfflineRecognizer` for
transducer models such as `parakeet-tdt-0.6b-v3`), `@gjsify/model-store` (verified, resumable
downloads) and `@gjsify/media-capture` (a file as a 16 kHz mono PCM source). What is missing is the
join: an Ogg/Opus file in, text out, with no microphone. By the "fix at the core" rule that join
belongs in gjsify, not in Curlew.

## Decision

### 1. Only received voice notes, only on request

The entry is a "Transcribe" button under the player of an incoming `kind: 'voice'` attachment. Own
voice notes are not offered (the person knows what they said), and nothing runs on its own: a
transcript costs seconds of CPU and a model of hundreds of megabytes, and a receive-time job would
be a read receipt for the audio. A per-chat switch ("transcribe voice notes here") may follow; it is
the same job started by the daemon and changes nothing below.

### 2. One port, local only

```ts
interface Transcriber {
  /** Text of the audio file at `path`; the language is the engine's guess unless `language` is set. */
  transcribe(path: string, options?: { language?: string; signal?: AbortSignal }): Promise<Transcript>;
}
interface Transcript { text: string; language: string | null; engine: string }
```

The adapter wraps the gjsify file-transcription facade. There is no remote implementation: ADR 0132
§ 4 allows one only when the app registers it, and Curlew does not. When no engine or model is
available the button explains what is missing (and offers the download); it never falls back to a
cloud service.

### 3. The daemon runs it, the window asks

The model sits in RAM for the length of the job (about 1.1 GB for parakeet) and the downloaded audio
is already the daemon's to fetch (ADR 0010 § 3), so the job runs in the daemon: the window sends a
`Transcribe(message, index)` request over the bus, the daemon fetches the file if needed, runs the
port, stores the result and emits a change event the window already knows. A second request for the
same attachment returns the stored text. One job at a time; a running one is cancellable.

### 4. Storage: one additive table, schema v19

```sql
CREATE TABLE attachment_transcripts (
  message_id TEXT NOT NULL, idx INTEGER NOT NULL,
  text TEXT NOT NULL, language TEXT, engine TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, idx))
```

It is a table of its own, not a column of `message_attachments`, because that table is rewritten
whenever a message is re-synced and a transcript must survive that. The text is also fed into the
search index under the message, so the merged chat search finds spoken words. Deleting a message
deletes its transcript.

### 5. The text is message content for agents

A transcript is a body in all but name. Through MCP it appears **only** with `includeBodies` and
under the same read gate (ADR 0009) as the message text; it never enters the body-free
`Conversation` DTO or the attachment list, and the attachment tool does not return it. An agent has no
way to start a transcription (it costs the person's CPU and downloads a model); it reads what the
person asked for.

### 6. Model, download and platforms

The default is `parakeet-tdt-0.6b-v3` (multilingual incl. German, WER about 12 %, CPU, 641 MB). It
is fetched through the shared model store on the first request, after one confirmation that names the
size. In a Flatpak that is the only moment Curlew needs network access beyond its own accounts, and
it is the model store's, not a new permission. Mobile is out of scope until a smaller model exists;
the button is not offered where the machine-fit check (ADR 0136) says the model does not fit.

## Consequences

- A new daemon request, so the wire version moves; an older window says so instead of failing.
- Schema v19 is additive; an older Curlew refuses the newer index as for every bump.
- A feature that needs `/home` space and RAM must say so before it starts, not after it fails.
- Words of the other person end up in a local file the person can already read; no new exposure
  beyond the message text itself.
- Accuracy is the engine's: about one word in eight is wrong. The text is labelled as a
  transcript, never presented as the message.

## Alternatives considered

- **whisper.cpp / large-v3-turbo:** better WER (7–11 %), but it needs a GPU for sensible speed and a
  second native bridge that does not exist yet. The port makes it a later swap.
- **Transcribe at receive time:** convenient, but a CPU and battery cost for every note, including
  ones the person never opens.
- **Cloud transcription as an option:** a voice is biometric data of a third person; ADR 0132 allows
  it only on registration and Curlew does not register.
- **Store the transcript in `message_attachments`:** lost on re-sync, and it would put message text
  into a table that agents read as metadata.

## Work packages

1. gjsify: file transcription (`transcribeFile`) on `OfflineRecognizer` with a `media-capture` file
   source and the parakeet manifest entry, built on or after gjsify PR #2598.
2. Curlew: the port, the table and search feeding, the daemon request, MCP gating and tests.
3. Curlew: the window row (button, progress, result, download confirmation), German strings, docs.
