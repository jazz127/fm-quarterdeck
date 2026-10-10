# Chat asks: decision record

**Status:** adopted (framework and presentation). **Owner:** Quarterdeck. **Code:** `prototype/chat-asks.js`. **Wire contract:** [Captain's Call, "Chat asks"](../prototype/BEARINGS.md#chat-asks).

## Problem

Captain's Call showed only what `fm-bearings-snapshot.sh --json` reports: filed captain holds and merge-ready contributions. When Firstmate asked the captain something in chat without filing a hold, Quarterdeck showed no card, even though a chat `/bearings` surfaced it. The ask existed only in the transcript, and filing it depended on Firstmate following a rule.

Goal: every ask Firstmate makes in chat appears as a card on the next Quarterdeck refresh or live update. The parse is deterministic, involves no model, and does not depend on Firstmate filing anything.

## Decision

Quarterdeck reads the primary Firstmate transcript incrementally. It turns each **marker line** in Firstmate's own text into a card, merges that card with snapshot calls about the same task, and closes it only by mechanical rules.

### Sources read (read-only)

- The **Claude Code primary session** for the selected home, chosen by the same rule as Fleet Chats (`findClaudePrimary`): the `state/.lock-session` id, otherwise the newest session that does not open with a machine envelope. Only the home-encoded project directory is listed.
- The in-home **`state/.main-session`** pointer, which must resolve inside `FM_HOME`.
- The **main Pi session** named by `state/.branch-mirror-cursor`, read only when it lives in the directory that encodes the exact home and its session header's `cwd` equals the home.
- **Not read by the transcript scanner:** branch sessions, worker transcripts, other homes, backlog and status records. The snapshot remains the only authority creating filed calls. Its existing bounded selected-home ledger read supplies reasons and read-only hold lifecycle evidence for chat linking/closure (including holds omitted from the snapshot); ledger evidence never creates a filed card.

Inside a source, only the model's own text parts count as Firstmate text: Claude `assistant` text that is not harness or synthetic text, and Pi `assistant` message text. Captain text is a human prompt that is not a machine envelope (`FIRSTMATE_OP:`, supervision wakes, mirrors, task notifications or skill bodies). Human Claude `queued_command` attachments count as prompts, including messages submitted mid-turn; their surrounding harness renderings do not. Thinking, tool calls and results, sidechains, hooks and meta records are ignored. Arbitrary tool output quoting captain text is never promoted to a prompt.

### Marker grammar

- A marker is `ACTION NEEDED`, `APPROVAL NEEDED` or `DECISION NEEDED`, in upper case, at the **start of a line**. It may follow blockquote `>`, a list bullet or number, a heading `#`, one emoji, or emphasis `*`/`_`. A colon, dash or emphasis may follow it (`**APPROVAL NEEDED:** …`, `**DECISION NEEDED** on …:`).
- The ask is the rest of the marker line plus any following non-blank lines, such as a decision's option list. It ends at a blank line, another marker, a code fence or a `[fm-lane …]`/`[end …]` line. Code-fenced text is never an ask. A mid-sentence or backticked mention of a marker is not an ask. Ask text is capped at 4000 characters.
- **Structured task marker:** `[task:<id>]` anywhere on the ask's marker line explicitly names its filed hold. Ids use `[A-Za-z0-9][A-Za-z0-9._-]{0,159}`; malformed markers do not count. Markers are extracted before ask text clipping and persisted independently of prose. Ordinary whole-token id mentions remain compatible. The optional code-enforced Stop hook requires this structured marker (see below).
- **Replies** are quoted alternatives after the word *reply* (`Reply **"x"**`, `reply \`a\` or \`b\``, `shortest reply: "y"`), plus quoted option labels at the start of the ask body or a following list/continuation line (`- "stay here": continue`, `"plan A" keeps the setup`). Straight/curly single and double quotes and backticks are accepted. Mid-sentence quoted prose is not an option label. Unquoted replies are never guessed, and at most 6 are kept.
- Lettered lines on a decision ask that has no quoted replies can become answer radios (`a)`, `(a)`, `a:`, `a -`, `Option A:`, a quoted `"a":`, or a lowercase `a.`).
  The same grammar is in `prototype/BEARINGS.md`.
  Those letters are not suggested-reply phrases, so a later chat message that contains the letter does not resolve the ask.
  A quoted reply line that continues with a description shows that description under the radio.

### Card identity and deduplication

- Key: `chat:` + 16-hex sha256 of `[transcript record id, text part index, marker line]`. The record id is Claude's `uuid` or Pi's `id`, with a source byte offset as the fallback. A session resumed into a new file keeps its record ids, so its asks keep the same keys.
- **Normalization:** Unicode NFKC, lowercase, then punctuation/whitespace converted to word separators. Matching uses whole phrases, never fragments of another word.
- **Re-ask:** a later ask with the same marker and any shared normalized suggested reply supersedes the older open one, even when explanatory prose changes. Identical normalized ask text also supersedes (including asks with no quoted replies). Different markers do not supersede each other merely by offering the same reply.
- **Filed holds:** an ask with `[task:<id>]` or a whole-token task-id mention is **linked** to that task, either when it appears or later when the hold is filed. It also links when a decision's summary/title/reason (including backlog supplements) contains a quoted value equal to one of its normalized suggested replies, or the entire reason equals that reply after normalization. Straight/curly single or double quotes and backticks are accepted; a larger unquoted phrase, a larger quoted phrase and partial words do not establish this link. Optional source title/reason are retained in normalized decisions, not inferred. Legacy snapshots omit the reason and truncate summary before the quoted reply: the existing 2 MiB selected-home ledger read therefore supplements a missing reason only for snapshot-authorized `(main)` task ids. Only unchecked items with `(hold-kind: captain)` and a canonical `fm-hold-v1` base64 field count; decoded text is capped at 16 KiB and must be valid UTF-8. Duplicate ids fail closed, body prose is ignored, source reasons win, and no ledger item creates a card. The same bounded read also decodes reasons on checked captain holds and reads item-scoped `Resolution recorded by fm-captain-hold.` / `Resolution mode: answered|released|done|closed` blocks. Closed records can link an id or retained reply phrase on first discovery, repairing already-stale asks. Unchecked captain holds remain open even with historical resolution prose (a reopened hold must not close). Duplicate ids across checked and unchecked records invalidate lifecycle evidence. Open holds omitted by bearings still establish links and prevent disappearance-based closure. This expands evidence for chat asks, not the snapshot's authority to create filed cards or the cross-home read boundary. Composition also tests links against the latest base cards before publishing: a cold snapshot can finish after a chat scan without briefly duplicating the filed calls. A linked ask does not get its own card. It is shown inside the snapshot card as `chatAsks[]` ("Also asked in chat"), so only the filed decision is a card and no context is lost.

### Resolution paths (all mechanical)

| Path | Rule |
| --- | --- |
| Answered in Quarterdeck | A confirmed send through the existing `POST /api/bearings/answer` keyed relay (`202`) resolves the ask in Quarterdeck state. |
| Dismissed in Quarterdeck | Review dismissal → Dismiss this ask posts `POST /api/bearings/dismiss {key, cardRev}` (host-only, same-origin, revision-guarded). Cancel and review are local; no inbox note is sent. |
| Hold answered/released/closed | On fresh selected-home ledger evidence, all linked holds have closed/answered/released lifecycle records; alternatively a fresh snapshot with no omission disclosures and no contrary open ledger hold no longer contains any linked task. The ask resolves as `answered`, with `resolutionSource` (`data/backlog.md` or `bearings snapshot`), task ids and recorded modes retained. Stale or omitted evidence never proves disappearance. |
| Superseded | A later Firstmate ask repeats the same marker and normalized reply, or identical normalized ask text. |

**Later** is proven by later byte/part order in the same source, provided known timestamps do not run backwards. Across sources, a strictly newer timestamp is required; equal or absent clocks alone do not prove order.

A reply typed in chat does not resolve an ask. A transcript `role=user` entry (including a human-flagged Claude prompt or queued prompt) is unverified input, not proof that the captain wrote it ([authorship](../prototype/TRANSCRIPTS.md#authorship)), so it never counts as the captain's reply. Answer, dismiss or supersede the card instead.

Resolved keys become tombstones (up to 5000), so re-reading a rewritten transcript never revives them. The latest 50 hold-based resolutions are exposed as `chat.resolved[{key,status:"answered",resolvedAt,tasks,source,resolutions}]` in `/api/bearings` and retained alongside dismissal/answer provenance in Quarterdeck state; automatic closure is not silent deletion. Card visuals are unchanged.

### State location

The state lives in one JSON file, `<FM_QUARTERDECK_STATE_PATH>.chat-asks.json` (schema `fm-quarterdeck-chat-asks.v1`). It sits beside Quarterdeck's presentation state, which the server already requires to be outside `FM_HOME`. It holds per-source cursors `{ino, offset, skip}`, open and recently resolved asks, tombstones and an additive `matchingVersion`. On the first scan after upgrading these matching rules, only cursors are reset: the existing bounded newest-4-MiB backfill re-evaluates persisted open cards against replies and repeated asks already read by the previous version. Existing open asks refresh their extracted replies during replay; accepted answers, dismissals and tombstones survive. Subsequent idle scans remain stat-only. This repair cannot find replies outside the bounded window. Writes use the same discipline as `agent-state.js`: an exclusive lock file, a temp file, fsync and rename. A busy lock is never stolen.

### Guarantees

- **No AI.** Extraction, linking and resolution are regular expressions and exact comparisons. Nothing calls a model.
- **Never writes Firstmate.** Nothing is written under `FM_HOME`, and Firstmate's backlog is never touched. The only outbound path is the existing guarded inbox note, sent after an explicit captain confirmation.
- **Not dependent on the snapshot.** Chat cards appear even when the snapshot is loading, stale or unavailable. An answer to a chat card needs only the chat scan to be `ready`.
- **Bounded.** Each scan only stats the sources when nothing grew. New bytes are read from the cursor, at most 4 MiB per source per scan, in whole lines. A record over 2 MiB is skipped to its newline, and only lines containing `NEEDED`, `"user"` or `"queued_command"` are JSON-parsed. There is no separate captain-line size cutoff: large pasted prompts and reminder-wrapped content are evaluated within the same whole-record bound. A new or rewritten source is backfilled from its newest 4 MiB only, and asks older than 24 hours in that backfill are recorded as closed. At most 100 unlinked chat cards are served (`chat.omitted` counts the rest).
- **Cadence.** Every `GET /api/bearings` (page load, refresh or `?since` poll) scans before it answers. While a stream is open, a scan runs every 3 s, and snapshot events re-apply linking. A scan emits `model` only for a new composed revision and is otherwise silent (the stream heartbeat carries freshness, and each event costs every stream a revision check and an activity read); the last unsubscribe stops the interval.
- **Explicit dismissal.** Review and Cancel never write state. Only confirmation posts the reviewed card revision; a changed card requires another review. Failures are visible and never retried automatically. Focus returns to the visible desktop/phone Overview tab if still in the dismissed card, so the normal engagement release can remove it. Moving focus to another card during delivery preserves that card's engagement. Unsent text is kept in the existing resolved-copy stub. The chip says Chat ask and the card has a double left border (non-color identification).

## Known limits

- An ask Firstmate phrases **without** a marker line is not detected. The marker convention is the one contract with Firstmate.
- A letter on a decision line is an answer radio, not a suggested reply. A later message that merely contains that letter does not resolve the ask.
- A card answered only in chat stays open until it is answered or dismissed in Quarterdeck, its hold closes, or Firstmate supersedes it.
- A later same-marker ask offering the same reply supersedes older asks even if their prose differs; generic replies can therefore conflate distinct same-marker asks.
- Linking needs a structured task marker, whole-token task-id mention, matching quoted reply or exact normalized reason. Otherwise an ask about a filed hold shows as its own card. If a linked ledger hold is omitted by bearings, its chat card remains visible rather than inventing a filed card.
- Asks in a source's history beyond the 4 MiB backfill window, or older than 24 hours at first discovery, are not shown.
- A chat card resolves on accepted send (`202`), not on a later received/replied receipt. Its receipt is visible only while the ordinary engagement hold keeps it on screen. Whether to keep answered cards until receipt acknowledgement is a separate product decision.
- An answer to a chat card reaches Firstmate as captain text (`question: chat.<id>`, `type: "chat"`). Firstmate's keyed intake has no hold to close for it.

## Code enforcement (optional, explicitly installed)

`scripts/captain-ask-stop-hook.mjs` is a Quarterdeck-owned Claude Code **Stop** hook, not a learning or markdown rule. It reads the final assistant message in the selected primary session's hook-supplied transcript. Every detected ask line must carry a `[task:<id>]` naming an existing unchecked `(hold-kind: captain)` ledger item. Otherwise it returns `{"decision":"block","reason":…}` telling Firstmate to use `bin/fm-captain-hold.sh` and add the marker. No allowlist, model call, hold mutation or stock Firstmate edit is involved. No marker means no guessed semantic decision; free-form answers still require Firstmate to record the actual hold resolution.

Primary identity is the selected home's `state/.lock-session`; different session ids are skipped. The transcript must be the exact selected-home encoded Claude project/session file, and hook `cwd` must equal the home. Missing/unreadable/malformed transcripts or backlog fail open with a stderr diagnostic. Reads are capped (64 KiB hook input, 4 MiB transcript tail, 2 MiB backlog); the hook has a 5 s deadline. Claude's `stop_hook_active` corrective retry skips enforcement with a diagnostic, bounding the stop loop to one block per turn. Installation gives an 8 s outer timeout. No live installation is implied by source presence; see [pinned installation and rollback](FIRSTMATE-INTEGRATIONS.md#captain-ask-stop-hook).

## Validation evidence

`test/captain-ask-stop-hook.test.mjs` covers pass/block, markdown markers, each-line enforcement, closed/noncaptain/duplicate ids, final-message-only inspection, other-session/corrective-turn skips, fail-open diagnostics and exact install/uninstall preservation. `prototype/test/chat-asks-hold-lifecycle.test.js` covers structured/whole-token linking, normalized reason replies, first-seen closed holds, release records, stale/omitted evidence, reopening, source disclosures and tombstones.

Synthetic extractor tests cover lowercase replies, a suggested reply inside a longer message, normalized punctuation/whitespace, word-fragment rejection, earlier/reversed-clock prompts, changed-prose marker+reply supersession, different-marker separation, all-matching reply resolution, queued human attachments with hook/tool/machine exclusions, prompts over 64 KiB, whole-record ceiling enforcement, one-off persisted-state repair including refreshed option extraction, quoted-reply links in filed titles/reasons, legacy encoded reason supplementation with malformed/duplicate/cross-owner rejection, late cold-snapshot dedup without subscribers, unquoted/partial-value non-links and fresh-only hold closure. Synthetic renderer and DOM tests cover escaped asks/replies/markers, linked holds, incomplete chat coverage, local dismissal review/cancel, changed-card refusal, save errors, focus transfer without stealing moved focus, protected drafts and live arrival/resolution fades. Fake-timer source tests cover model-only scan publication, forwarded hub evidence, one subscriber-owned interval, last-unsubscribe cleanup, hub close and linking before publication. The isolated browser pass writes only synthetic transcripts in a temporary home and checks load, appended live asks, dismissal, suggested-reply inbox envelopes, phone widths, light/dark OS preferences and forced colors. See [BEARINGS.md validation](../prototype/BEARINGS.md#validation) for commands. Native phone/background checks remain pending.

## Alternatives rejected

- **A Python script or cron job writing cards.** It would duplicate the transcript confinement rules already in the Node server, add a second process and a second state owner, and lag behind the live stream. Node in the server reuses `findClaudePrimary`, `claudeTurns`, the answer relay and the SSE hub. `prototype/scripts/chat-asks.mjs` runs the same scanner on demand.
- **Relying on instructions to file every ask.** This is the rule that failed. The optional Stop hook below enforces filing/markers in code instead; detection still works when it is not installed.
- **Model-based extraction or summarization.** It is non-deterministic, costs money, and was explicitly excluded.
- **Writing chat asks into Firstmate's backlog.** That would violate the read-only boundary, and Firstmate alone owns holds.
- **Re-parsing the windowed Fleet Chats transcript on each poll.** That reads up to 8 MiB per request. The cursor makes an idle poll a `stat`.
- **Resolving asks from replies typed in chat.** Normalized whole-phrase matching against later transcript `role=user` entries was used until it was found to treat unverified input as the captain's words. Transcript input carries no proof of its author, so no reply matching, however strict, can make it the captain's answer.
- **Using `fs.watch` on the transcript.** It is unreliable on WSL and network filesystems. A 3 s stat while streamed is cheap and certain.

## Revisit triggers

- Firstmate adds structured ask records, such as an `asks[]` field in the snapshot. In that case, prefer that source and keep this parser as the fallback.
- A harness changes its transcript layout. Add a reviewed adapter beside `recordTurns`.
- False positives or missed asks appear in practice. Adjust the marker grammar here and in `test/chat-asks.test.js` together.
