import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createHistoryReader } from "./history-reader.js";

const MIRROR_MATCH_WINDOW_MS = 60_000;

function turnIdentity(message) {
  return `${message.role}\u0000${message.kind}\u0000${message.text}`;
}

// Native main-session records and fm-main-mirror records describe the same turn.
// Pair exact role/kind/text identities only within the mirror emission window so
// genuinely repeated replies elsewhere in history remain distinct.
function deduplicateMirroredTurns(messages) {
  const nativeByIdentity = new Map();
  for (const message of messages) {
    if (message.transcriptOrigin !== "main Pi") continue;
    const identity = turnIdentity(message);
    if (!nativeByIdentity.has(identity)) nativeByIdentity.set(identity, []);
    nativeByIdentity.get(identity).push(message.timestamp.valueOf());
  }

  const keptMirrors = new Map();
  return messages.filter((message) => {
    if (message.transcriptOrigin !== "main mirror") return true;
    const identity = turnIdentity(message);
    const timestamp = message.timestamp.valueOf();
    const duplicatesNative = (nativeByIdentity.get(identity) || [])
      .some((nativeTimestamp) => Math.abs(nativeTimestamp - timestamp) <= MIRROR_MATCH_WINDOW_MS);
    if (duplicatesNative) return false;

    const priorMirror = (keptMirrors.get(identity) || [])
      .some((mirrorTimestamp) => Math.abs(mirrorTimestamp - timestamp) <= MIRROR_MATCH_WINDOW_MS);
    if (priorMirror) return false;
    if (!keptMirrors.has(identity)) keptMirrors.set(identity, []);
    keptMirrors.get(identity).push(timestamp);
    return true;
  });
}

// External Pi discovery is limited to the cursor's home-encoded directory AND
// session headers whose cwd matches this home. Never scan other session homes.
export async function readConversationTranscript(home, publicMessage, { selectedIds = [], older = 0, reader = createHistoryReader() } = {}) {
  const readFile = reader.text;
  const root = await realpath(home);
  const files = new Map();
  const warnings = [];
  async function add(file, label) {
    try {
      const resolved = await realpath(file);
      if (!resolved.startsWith(`${root}${path.sep}`)) {
        warnings.push(`${label} points outside FM_HOME; its transcript is not loaded.`);
        return;
      }
      if (resolved.endsWith(".jsonl") && (await stat(resolved)).isFile()) {
        files.set(resolved, path.relative(root, resolved).split(path.sep).join("/"));
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      warnings.push(`${label} points to a missing transcript.`);
    }
  }
  for (const directory of ["state/branch-session", "state/main-session"]) {
    let entries = [];
    try {
      const resolvedDirectory = await realpath(path.join(root, directory));
      if (!resolvedDirectory.startsWith(`${root}${path.sep}`)) {
        warnings.push(`${directory} resolves outside FM_HOME; not loaded.`);
        continue;
      }
      entries = await readdir(resolvedDirectory, { withFileTypes: true });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) await add(path.join(root, directory, entry.name), directory);
    }
  }
  let mainPiSessions = 0;
  async function addMainPiDirectory(target) {
    const directory = path.dirname(target);
    const encodedHome = `--${root.replace(/^\/+/, "").replaceAll("/", "-")}--`;
    if (!path.isAbsolute(target) || path.basename(directory) !== encodedHome || !target.endsWith(".jsonl")) return false;
    let entries;
    try {
      if (await realpath(directory) !== directory) return false;
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) { if (error.code === "ENOENT") return false; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const file = path.join(directory, entry.name);
      let header;
      try { header = JSON.parse(await reader.firstLine(file)); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      if (header?.type !== "session" || header.cwd !== root) {
        warnings.push(`main-pi-session/${entry.name} has no matching home session header; not loaded.`);
        continue;
      }
      files.set(file, `main-pi-session/${entry.name}`);
      mainPiSessions += 1;
    }
    return true;
  }
  for (const pointer of ["state/.branch-session", "state/.main-session", "state/.branch-mirror-cursor"]) {
    let text;
    try { text = (await readFile(path.join(root, pointer), "utf8")).trim(); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    let target = text;
    if (pointer.endsWith("cursor")) {
      try { target = JSON.parse(text).file; }
      catch { warnings.push(`${pointer} is malformed.`); continue; }
    }
    if (typeof target === "string" && target) {
      if (pointer.endsWith("cursor") && !path.resolve(root, target).startsWith(`${root}${path.sep}`) && await addMainPiDirectory(target)) continue;
      await add(path.resolve(root, target), pointer);
    }
  }
  // Stat before parsing: a default request reads only the live cursor(s) and the
  // two newest disk sessions. Explicit selections/older pages are bounded too.
  const inventory = await Promise.all([...files].map(async ([file, source]) => ({ file, source, changed: (await stat(file)).mtimeMs })));
  inventory.sort((a, b) => b.changed - a.changed || a.source.localeCompare(b.source));
  const active = new Set();
  for (const pointer of ["state/.branch-session", "state/.main-session", "state/.branch-mirror-cursor"]) {
    try {
      const raw = (await readFile(path.join(root, pointer), "utf8")).trim();
      const target = pointer.endsWith("cursor") ? JSON.parse(raw).file : raw;
      if (typeof target === "string") active.add(path.resolve(root, target));
    } catch (error) { if (error.code !== "ENOENT") warnings.push(`${pointer} cannot identify an active transcript.`); }
  }
  const requested = new Set(selectedIds.slice(0, 60));
  const visible = new Set(inventory.slice(0, 2 + Math.min(older, 20) * 2).map(({ source }) => source));
  for (const entry of inventory) if (active.has(entry.file) || requested.has(entry.source)) visible.add(entry.source);
  const messages = [];
  const sessions = inventory.map(({ source, changed }) => ({ id: source, source, updatedAt: new Date(changed).toISOString(), loaded: visible.has(source), messageCount: null, skippedRecords: 0, startedAt: null }));
  for (const { file, source } of inventory.filter(({ source }) => visible.has(source))) {
    const session = { id: source, source, messageCount: 0, skippedRecords: 0, startedAt: null, updatedAt: null };
    let lineIndex = 0;
    const lines = reader.lines(file);
    for await (const line of lines) {
      lineIndex += 1;
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { session.skippedRecords += 1; continue; }
      let role;
      let content;
      let recordKind = null;
      let origin = source.startsWith("state/branch-session/") ? "branch" : source.startsWith("main-pi-session/") ? "main Pi" : "session";
      if (record.type === "custom_message" && record.customType === "fm-main-mirror" && typeof record.content === "string") {
        const mirror = record.content.match(/^\[(captain|main)\]\s*([\s\S]*)$/);
        if (!mirror) continue;
        role = mirror[1] === "captain" ? "user" : "assistant";
        content = mirror[2];
        origin = "main mirror";
      } else if (record.type === "custom_message" && record.display === true && typeof record.content === "string") {
        if (/^\W*FIRSTMATE_OP:/.test(record.content)) continue;
        role = "assistant";
        content = record.content;
        recordKind = record.customType === "fm-branch-merge" ? "supervision" : "harness";
      } else if (record.type === "message" && ["user", "assistant", "toolResult", "bashExecution"].includes(record.message?.role)) {
        role = record.message.role;
        content = role === "bashExecution" ? `${record.message.command || ""}\n${record.message.output || ""}` : record.message.content;
        if (["toolResult", "bashExecution"].includes(role)) recordKind = "tools";
      } else continue;
      if (origin === "branch" && role === "assistant" && !recordKind) recordKind = "branch";
      const timestamp = new Date(record.timestamp ?? record.message?.timestamp);
      if (Number.isNaN(timestamp.valueOf())) { session.skippedRecords += 1; continue; }
      const parts = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
      for (const [partIndex, part] of parts.entries()) {
        const thinking = role === "assistant" && part.type === "thinking";
        const toolCall = part.type === "toolCall";
        const text = thinking ? part.thinking : toolCall ? `${part.name || "Tool"}\n${JSON.stringify(part.arguments ?? {}, null, 2)}` : part.type === "text" ? part.text : part.type === "image" ? "[Image attachment stored in transcript; image rendering is not supported here.]" : "";
        if (typeof text !== "string" || !text.trim()) continue;
        // Remove only machine envelopes, not arbitrary ordinary user turns.
        if (role === "user" && (/^\W*FIRSTMATE_OP:/.test(text) || /^FIRSTMATE SUPERVISION WAKE:/.test(text) || /^\s*<skill\b[^>]*>[\s\S]*<\/skill>\s*$/.test(text))) continue;
        reader.takeMessage();
        messages.push({ ...publicMessage({
          author: recordKind === "supervision" ? "Fleet" : role === "user" ? "Captain" : role === "toolResult" ? record.message.toolName || "Tool" : origin === "branch" ? "Firstmate (branch)" : "Firstmate", role: role === "user" ? "captain" : "firstmate",
          source, text: text.trim(), timestamp, sourceSequence: lineIndex * 1000 + partIndex,
          state: role === "user" ? "captain" : thinking ? "thinking" : "response", kind: thinking ? "thinking" : toolCall ? "tools" : recordKind || "conversation",
        }), transcriptSessionId: source, transcriptOrigin: origin, recordId: `${source}:${lineIndex}:${partIndex}` });
        session.messageCount += 1;
        const iso = timestamp.toISOString();
        if (!session.startedAt || iso < session.startedAt) session.startedAt = iso;
        if (!session.updatedAt || iso > session.updatedAt) session.updatedAt = iso;
      }
    }
    Object.assign(sessions.find((entry) => entry.source === source), session, { loaded: true });
  }
  const mainNote = mainPiSessions ? "Main Pi transcripts included; matching branch mirrors are deduplicated." : "Main Pi transcript not sourced: only available in-home sessions and partial main mirrors are shown. Configure the home’s state/.branch-mirror-cursor or mirror main JSONL into state/main-session/.";
  return { messages: deduplicateMirroredTurns(messages), coverage: { sessions, warnings, note: `${mainNote} Only the active and recent disk sessions are loaded by default; older sessions remain available on demand; filters apply (General excludes complete, valid project-lane blocks). Thinking is native transcript content, never generated for this UI. Pure operational envelopes are hidden. Images are labeled, not rendered; pane lines never persisted cannot be recovered.` } };
}
