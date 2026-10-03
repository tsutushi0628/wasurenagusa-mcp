import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  extractHumanUtterance,
  isThemeCandidate,
  jstDate,
  percentile,
} from "./analysis.mjs";
import { matchThemes } from "./themes.mjs";

const DATE_START = "2026-09-22";
const DATE_END = "2026-10-02";
const PERIOD_START_MS = Date.parse("2026-09-21T15:00:00.000Z");
const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SAMPLE_SEED = 20261003;
const DETECTOR_VERSION = "owner-correction-v2";
const REPORT_VERSION = 1;
const AUDIT_PROMPT = [
  "独立監査。与えた人間発話と直前AI区間だけを読む。引用・貼付・AI生成文は本人の訂正として数えない。",
  "入力にある訂正の有無と、提示された行動規則が訂正の趣旨・極性・条件を保つかを別々に判定。",
  "返答はJSON: is_correction:boolean, rule_ok:boolean, verdict:valid|invalid|undetermined, source_position:string|null。",
  "不確かな判断はundetermined。別の監査者の回答、検出器の採否・点数・状態は参照しない。",
].join("\n");
const STOP_COMMAND = "wasurenagusa-analyze";
const SOURCE_PROJECT = "firebase-kit";
const SOURCE_SCOPE = "general";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function numericTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareAvailable(left, right) {
  return left.availableMs - right.availableMs ||
    left.sessionHash.localeCompare(right.sessionHash) ||
    left.lineOrder - right.lineOrder;
}

function readText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function safeOwnerEvent(event, utterance, sessionId, lineOrder, byteOffset, byteEndOffset) {
  const metadata = {
    type: utterance.sourceType === "queued_command" ? "attachment" : "user",
    origin: { kind: "human" },
    sessionId,
    timestamp: event.timestamp,
    uuid: event.uuid,
    order: lineOrder,
    transcriptByteOffset: byteOffset,
  };
  if (utterance.queued) {
    metadata.attachment = {
      type: "queued_command",
      commandMode: "prompt",
      origin: { kind: "human" },
      prompt: utterance.text,
    };
  } else {
    metadata.message = { content: [{ type: "text", text: utterance.text }] };
  }
  return {
    event: metadata,
    text: utterance.text,
    sessionId,
    sessionHash: sha256(sessionId),
    lineOrder,
    byteOffset,
    byteEndOffset,
    timestamp: event.timestamp,
    timestampMs: numericTime(event.timestamp),
    queued: utterance.queued,
    sourceType: utterance.sourceType,
    uuid: typeof event.uuid === "string" ? event.uuid : undefined,
    labels: isThemeCandidate(utterance.text) ? matchThemes(utterance.text).map((theme) => theme.id) : [],
    observedUserHook: false,
    previousAssistantRecords: [],
    detections: [],
    saves: [],
    emissions: [],
    emissionHints: [],
  };
}

function safeAssistantRecord(event, lineOrder, byteOffset, byteEndOffset) {
  const message = event.message && typeof event.message === "object" ? event.message : {};
  const content = message.content;
  const toolNames = [];
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type === "tool_use" && typeof part.name === "string") toolNames.push(part.name);
    }
  }
  const name = event.name ?? event.tool_name ?? message.name;
  if (typeof name === "string" && name) toolNames.push(name);
  return {
    byteOffset,
    byteEndOffset,
    entry: {
      type: event.type,
      isSidechain: event.isSidechain === true,
      origin: event.origin,
      isMeta: event.isMeta,
      message: {
        isMeta: message.isMeta,
        content,
        ...(typeof message.name === "string" ? { name: message.name } : {}),
      },
      ...(typeof name === "string" ? { name } : {}),
      timestamp: event.timestamp,
    },
    lineOrder,
    timestampMs: numericTime(event.timestamp),
    text: readText(content),
    toolNames,
  };
}

function isCompactRecord(event) {
  const subtype = String(event.subtype ?? "").toLocaleLowerCase("en-US");
  const attachment = event.attachment ?? {};
  const attachmentType = String(attachment.type ?? "").toLocaleLowerCase("en-US");
  return subtype.includes("compact") || attachmentType.includes("compact");
}

function isContextStart(attachment) {
  const hookName = String(attachment.hookName ?? "");
  const command = String(attachment.command ?? "");
  return ["SessionStart:startup", "SessionStart:resume", "SessionStart:compact", "SessionStart:clear"].includes(hookName) &&
    command.split(/\s+/u).some((part) => part.replace(/^['"]|['"]$/gu, "").endsWith("wasurenagusa-context"));
}

function isContextPrompt(attachment) {
  return attachment.hookName === "UserPromptSubmit" &&
    String(attachment.command ?? "").split(/\s+/u)
      .some((part) => part.replace(/^['"]|['"]$/gu, "").endsWith("wasurenagusa-context"));
}

function isAnalyzeStop(event) {
  if (event.type !== "system" || event.subtype !== "stop_hook_summary") return false;
  return Array.isArray(event.hookInfos) && event.hookInfos.some((info) => info.command === STOP_COMMAND);
}

function minimalRecord(event, lineOrder, byteOffset, byteEndOffset) {
  if (event.type === "user") {
    return {
      byteOffset,
      byteEndOffset,
      entry: {
        type: "user",
        isSidechain: event.isSidechain === true,
        origin: event.origin,
        isMeta: event.isMeta,
        promptSource: event.promptSource,
        message: { isMeta: event.message?.isMeta },
      },
      lineOrder,
    };
  }
  if (event.type === "attachment") {
    const attachment = event.attachment ?? {};
    if (attachment.type !== "queued_command" || attachment.commandMode !== "prompt") return null;
    return {
      byteOffset,
      byteEndOffset,
      entry: {
        type: "attachment",
        isSidechain: event.isSidechain === true,
        origin: event.origin,
        attachment: { type: attachment.type, commandMode: attachment.commandMode, origin: attachment.origin },
      },
      lineOrder,
    };
  }
  if (event.type === "assistant" || event.type === "tool_use" || event.type === "tool_result") {
    return safeAssistantRecord(event, lineOrder, byteOffset, byteEndOffset);
  }
  return null;
}

async function readFixedFile(filename, readEndByteOffset) {
  const handle = await open(filename, "r");
  try {
    const fileStat = await handle.stat();
    if (!Number.isSafeInteger(readEndByteOffset) || readEndByteOffset < 0 || fileStat.size < readEndByteOffset) {
      throw new Error("manifest transcript is shorter than its fixed byte offset");
    }
    const bytes = Buffer.alloc(readEndByteOffset);
    let total = 0;
    while (total < readEndByteOffset) {
      const result = await handle.read(bytes, total, readEndByteOffset - total, total);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
    }
    const snapshot = bytes.subarray(0, total);
    if (total !== readEndByteOffset) throw new Error("manifest transcript ended before its fixed byte offset");
    if (readEndByteOffset > 0 && snapshot.at(-1) !== 0x0a) {
      throw new Error("manifest transcript offset must end at a complete JSONL row");
    }
    return { snapshot, size: total, prefixHash: sha256(snapshot), device: fileStat.dev, inode: fileStat.ino };
  } finally {
    await handle.close();
  }
}

function parseSnapshot(snapshot, sessionId) {
  const rows = [];
  const allHuman = [];
  const transcriptRecords = [];
  let lineOrder = 0;
  let startMs = null;
  let firstHumanMs = null;
  let hasHumanInPeriod = false;
  let offset = 0;
  let previousAvailableMs = -Infinity;
  let pendingPrompt = null;
  let lastAssistantRows = [];

  while (offset < snapshot.length) {
    lineOrder += 1;
    const lineEnd = snapshot.indexOf(0x0a, offset);
    const contentEnd = lineEnd < 0 ? snapshot.length : lineEnd;
    const byteEndOffset = lineEnd < 0 ? snapshot.length : lineEnd + 1;
    const line = snapshot.subarray(offset, contentEnd).toString("utf8").replace(/\r$/u, "");
    const byteOffset = offset;
    offset = byteEndOffset;
    if (!line.trim()) continue;

    const event = JSON.parse(line);
    if (typeof event.sessionId === "string") {
      sessionId = event.sessionId;
    }
    const eventMs = numericTime(event.timestamp);
    if (eventMs !== null && (startMs === null || eventMs < startMs)) startMs = eventMs;

    const utterance = extractHumanUtterance(event);
    if (utterance) {
      const input = safeOwnerEvent(event, utterance, sessionId, lineOrder, byteOffset, byteEndOffset);
      const date = jstDate(event.timestamp);
      input.dateJst = date;
      if (eventMs !== null && (firstHumanMs === null || eventMs < firstHumanMs)) firstHumanMs = eventMs;
      if (date && date >= DATE_START && date <= DATE_END) hasHumanInPeriod = true;
      input.availableMs = eventMs === null ? previousAvailableMs : Math.max(previousAvailableMs, eventMs);
      if (Number.isFinite(input.availableMs)) previousAvailableMs = input.availableMs;
      input.availableAt = Number.isFinite(input.availableMs) ? new Date(input.availableMs).toISOString() : null;
      input.transcriptRecords = transcriptRecords;
      input.previousAssistantRecords = [...lastAssistantRows];
      allHuman.push(input);
      rows.push({ kind: "human", input, lineOrder, byteOffset, byteEndOffset, availableMs: input.availableMs, sessionHash: input.sessionHash });
      pendingPrompt = input;
      lastAssistantRows = [];
      const minimal = minimalRecord(event, lineOrder, byteOffset, byteEndOffset);
      if (minimal) transcriptRecords.push(minimal);
      continue;
    }

    if (event.type === "attachment") {
      const attachment = event.attachment ?? {};
      const contextStart = isContextStart(attachment);
      if (pendingPrompt && isContextPrompt(attachment)) pendingPrompt.observedUserHook = true;
      if (contextStart) {
        const availableMs = eventMs === null ? previousAvailableMs : Math.max(previousAvailableMs, eventMs);
        if (Number.isFinite(availableMs)) previousAvailableMs = availableMs;
        rows.push({
          kind: "start",
          source: String(attachment.hookName).endsWith("compact") ? "compact"
            : String(attachment.hookName).endsWith("clear") ? "clear"
              : String(attachment.hookName).endsWith("resume") ? "resume" : "startup",
          observed: true,
          lineOrder,
          byteOffset,
          byteEndOffset,
          availableMs,
          sessionHash: sha256(sessionId),
          sessionId,
        });
      }
      if (isCompactRecord(event) && !contextStart) {
        const availableMs = eventMs === null ? previousAvailableMs : Math.max(previousAvailableMs, eventMs);
        if (Number.isFinite(availableMs)) previousAvailableMs = availableMs;
        rows.push({ kind: "compact", lineOrder, byteOffset, byteEndOffset, availableMs, sessionHash: sha256(sessionId), sessionId });
      }
      continue;
    }

    const minimal = minimalRecord(event, lineOrder, byteOffset, byteEndOffset);
    if (minimal) {
      transcriptRecords.push(minimal);
      if (["assistant", "tool_use", "tool_result"].includes(event.type) && event.isSidechain !== true) {
        lastAssistantRows.push(minimal);
      }
    }
    if (isAnalyzeStop(event)) {
      const availableMs = eventMs === null ? previousAvailableMs : Math.max(previousAvailableMs, eventMs);
      if (Number.isFinite(availableMs)) previousAvailableMs = availableMs;
      rows.push({ kind: "stop", lineOrder, byteOffset, byteEndOffset, availableMs, sessionHash: sha256(sessionId), sessionId });
    }
    if (event.type === "system" && event.subtype === "compact_boundary") {
      const availableMs = eventMs === null ? previousAvailableMs : Math.max(previousAvailableMs, eventMs);
      if (Number.isFinite(availableMs)) previousAvailableMs = availableMs;
      rows.push({ kind: "compact", lineOrder, byteOffset, byteEndOffset, availableMs, sessionHash: sha256(sessionId), sessionId });
    }
  }

  return {
    sessionId,
    sessionHash: sha256(sessionId),
    startMs,
    firstHumanMs,
    hasHumanInPeriod,
    humanInputs: allHuman,
    timeline: rows,
    transcriptRecords,
  };
}

export async function readManifest(filename) {
  if (typeof filename !== "string" || filename.length === 0) throw new Error("--manifest is required");
  const manifestPath = resolve(filename);
  const rawManifest = await readFile(manifestPath);
  const manifest = JSON.parse(rawManifest.toString("utf8"));
  if (manifest.version !== 1 || !Array.isArray(manifest.sessions)) {
    throw new Error("manifest version 1 with a sessions array is required");
  }
  const fileMetadata = Array.isArray(manifest.files) ? manifest.files : [];
  const files = [];
  const sessions = [];
  const seenSessions = new Set();
  for (const entry of manifest.sessions) {
    if (!entry || typeof entry.sessionId !== "string" || typeof entry.path !== "string" ||
      typeof entry.fileId !== "string" || entry.fileId.length === 0) {
      throw new Error("manifest session requires sessionId and path");
    }
    if (seenSessions.has(entry.sessionId)) throw new Error("manifest contains duplicate session IDs");
    seenSessions.add(entry.sessionId);
    if (typeof entry.prefixSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.prefixSha256)) {
      throw new Error("manifest session prefix hash is invalid");
    }
    const filePath = resolve(dirname(manifestPath), entry.path);
    const snapshot = await readFixedFile(filePath, entry.readEndByteOffset);
    if (snapshot.prefixHash !== entry.prefixSha256) throw new Error("manifest transcript hash mismatch");
    const parsed = parseSnapshot(snapshot.snapshot, entry.sessionId);
    if (parsed.sessionId !== entry.sessionId || !parsed.hasHumanInPeriod || parsed.humanInputs.length === 0) {
      throw new Error("manifest session does not match the fixed population");
    }
    if (entry.sessionHash && entry.sessionHash !== parsed.sessionHash) throw new Error("manifest session hash mismatch");
    sessions.push({
      ...parsed,
      sourceFileId: entry.fileId,
      sourcePath: filePath,
      snapshot: snapshot.snapshot,
      snapshotMeta: snapshot,
    });
  }

  if (new Set(sessions.map((session) => session.sessionHash)).size !== sessions.length) {
    throw new Error("manifest contains duplicate session hashes");
  }
  for (const entry of fileMetadata) {
    if (!entry || typeof entry.fileId !== "string" || entry.fileId.length === 0 ||
      !Number.isSafeInteger(entry.readEndByteOffset) || entry.readEndByteOffset < 0
      || typeof entry.prefixSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.prefixSha256)
      || typeof entry.disposition !== "string") {
      throw new Error("manifest file metadata is invalid");
    }
    files.push({
      fileId: entry.fileId,
      readEndByteOffset: entry.readEndByteOffset,
      prefixSha256: entry.prefixSha256,
      disposition: entry.disposition,
      humanUtteranceCount: Number.isSafeInteger(entry.humanUtteranceCount) ? entry.humanUtteranceCount : 0,
      inPeriodHumanUtteranceCount: Number.isSafeInteger(entry.inPeriodHumanUtteranceCount) ? entry.inPeriodHumanUtteranceCount : 0,
    });
  }
  const declaredAudit = manifest.fileAudit ?? {};
  const fileAudit = {
    fileCount: Number.isSafeInteger(declaredAudit.fileCount) ? declaredAudit.fileCount : Math.max(files.length, sessions.length),
    excluded: Number.isSafeInteger(declaredAudit.excluded) ? declaredAudit.excluded : 0,
    noHuman: Number.isSafeInteger(declaredAudit.noHuman) ? declaredAudit.noHuman : 0,
    outsidePeriod: Number.isSafeInteger(declaredAudit.outsidePeriod) ? declaredAudit.outsidePeriod : 0,
    included: Number.isSafeInteger(declaredAudit.included) ? declaredAudit.included : sessions.length,
  };
  const includedFiles = files.filter((entry) => entry.disposition === "included");
  if (files.length === 0 || fileAudit.fileCount !== files.length || fileAudit.included !== sessions.length ||
    includedFiles.length !== sessions.length ||
    fileAudit.fileCount !== fileAudit.included + fileAudit.excluded + fileAudit.noHuman + fileAudit.outsidePeriod) {
    throw new Error("manifest file counts are inconsistent");
  }
  const includedById = new Map(includedFiles.map((entry) => [entry.fileId, entry]));
  if (includedById.size !== includedFiles.length || new Set(files.map((entry) => entry.fileId)).size !== files.length) {
    throw new Error("manifest contains duplicate file IDs");
  }
  for (const entry of manifest.sessions) {
    const session = sessions.find((candidate) => candidate.sessionId === entry.sessionId);
    const metadata = includedById.get(entry.fileId);
    if (!metadata || metadata.readEndByteOffset !== session.snapshotMeta.size || metadata.prefixSha256 !== session.snapshotMeta.prefixHash) {
      throw new Error("manifest session file metadata does not match its fixed snapshot");
    }
  }
  return {
    sessions,
    files,
    fileAudit,
    manifestHash: sha256(rawManifest),
    manifestPath,
    fixtureKind: manifest.fixtureKind ?? null,
  };
}

export function adjudicatePrevention({
  occurrence,
  detections,
  saves,
  emissions,
  actionRuleSnapshots = [],
  actionTimeline = [],
  cReason,
  deliveryDiagnostics = {},
}) {
  const occurredAt = occurrence.at ? Date.parse(occurrence.at) : null;
  const actionAt = occurrence.actionStartAt ? Date.parse(occurrence.actionStartAt) : null;
  const cFailure = (reason, sourceEventId) => ({
    prevented: false,
    failedAt: "c",
    reason,
    sourceEventId,
    ...(deliveryDiagnostics.secondaryReasons?.length
      ? { secondaryReasons: [...new Set(deliveryDiagnostics.secondaryReasons)] }
      : {}),
  });
  const beforeOccurrence = (item) => {
    const itemTime = numericTime(item.at);
    if (occurredAt === null || itemTime === null || itemTime > occurredAt) return false;
    if (itemTime < occurredAt) return true;
    const sameSession = item.sessionHash
      ? item.sessionHash === occurrence.sessionHash
      : item.sessionId === occurrence.sessionId;
    return sameSession && Number.isFinite(occurrence.order) && Number.isFinite(item.order) && item.order < occurrence.order;
  };
  const priorDetections = detections.filter((item) =>
    item.bundleLabel === occurrence.bundleLabel &&
    item.eventId !== occurrence.eventId &&
    (item.status === "candidate" || item.status === "confirmed") &&
    beforeOccurrence(item),
  );
  if (priorDetections.length === 0) {
    return { prevented: false, failedAt: "a", reason: "no_prior_candidate", sourceEventId: null };
  }

  const priorEventIds = new Set(priorDetections.map((item) => item.eventId));
  if (actionAt === null) {
    return { prevented: false, failedAt: "b", reason: "prior_ai_action_missing", sourceEventId: null };
  }
  const relatedSaves = saves.filter((save) =>
    (save.bundleLabel === undefined || save.bundleLabel === occurrence.bundleLabel) &&
    save.status === "confirmed" &&
    priorEventIds.has(save.eventId) &&
    Array.isArray(save.evidenceEventIds) && save.evidenceEventIds.includes(save.eventId),
  );
  const beforeAction = (item, field) => {
    const time = numericTime(item[field]);
    if (actionAt === null || time === null || time > actionAt) return false;
    if (time < actionAt) return true;
    const sameSession = item.sessionHash
      ? item.sessionHash === occurrence.sessionHash
      : item.sessionId === occurrence.sessionId;
    return sameSession && Number.isFinite(occurrence.actionOrder) && Number.isFinite(item.order) && item.order < occurrence.actionOrder;
  };
  const timelySaves = relatedSaves.filter((save) => beforeAction(save, "savedAt"));
  if (timelySaves.length === 0) {
    if (relatedSaves.length > 0) {
      return { prevented: false, failedAt: "b", reason: "saved_after_action_start", sourceEventId: null };
    }
    if (saves.some((save) => save.bundleLabel === occurrence.bundleLabel && save.status === "candidate" && priorEventIds.has(save.eventId))) {
      return { prevented: false, failedAt: "b", reason: "not_confirmed", sourceEventId: null };
    }
    return { prevented: false, failedAt: "b", reason: "no_prior_confirmed_save", sourceEventId: null };
  }

  timelySaves.sort((left, right) => Date.parse(right.savedAt) - Date.parse(left.savedAt) || left.eventId.localeCompare(right.eventId));
  const snapshotsByBundle = new Map();
  for (const snapshot of actionRuleSnapshots) snapshotsByBundle.set(snapshot.bundleKey, snapshot);
  const selectedSave = timelySaves.find((save) => {
    const snapshot = snapshotsByBundle.get(save.bundleKey);
    if (!snapshot) return true;
    return snapshot.status === "confirmed" && snapshot.version === save.version && snapshot.evidenceEventIds.includes(save.eventId);
  }) ?? timelySaves[0];
  const snapshots = actionRuleSnapshots.filter((snapshot) => snapshot.bundleKey === selectedSave.bundleKey);
  const currentSnapshot = snapshots.at(-1);
  if (currentSnapshot && (currentSnapshot.status !== "confirmed" || currentSnapshot.version !== selectedSave.version)) {
    return cFailure("stale_version", selectedSave.eventId);
  }
  const relatedEmissions = emissions.filter((emission) =>
    emission.bundleLabel === occurrence.bundleLabel &&
    emission.bundleKey === selectedSave.bundleKey &&
    emission.version === selectedSave.version &&
    Array.isArray(emission.evidenceEventIds) &&
    emission.evidenceEventIds.includes(selectedSave.eventId),
  );

  const outputsBeforeAction = relatedEmissions.filter((emission) => beforeAction(emission, "emittedAt"));
  const hasBody = (emission) => emission.bodyIncluded === true &&
    emission.stdoutStatus === "emitted" &&
    typeof emission.ruleText === "string" &&
    emission.ruleText.trim().length > 0 &&
    typeof emission.bodyText === "string" &&
    normalizeBody(emission.bodyText).includes(normalizeBody(emission.ruleText));
  const invalidOutputReason = (emission) => {
    const emittedAt = numericTime(emission.emittedAt);
    if (emission.versionStatus && emission.versionStatus !== "confirmed") return "stale_version";
    if (selectedSave.expiresAt && emittedAt !== null && numericTime(selectedSave.expiresAt) <= emittedAt) return "expired_at_injection";
    if (emission.expiresAt && emittedAt !== null && numericTime(emission.expiresAt) <= emittedAt) return "expired_at_injection";
    if (selectedSave.expiresAt && actionAt !== null && numericTime(selectedSave.expiresAt) <= actionAt) return "expired_before_action";
    if (emission.expiresAt && actionAt !== null && numericTime(emission.expiresAt) <= actionAt) return "expired_before_action";
    return null;
  };
  if (Array.isArray(occurrence.actionRows) || actionTimeline.length > 0) {
    if (!Array.isArray(occurrence.actionRows) || actionTimeline.length === 0 || occurrence.actionRows.length !== actionTimeline.length) {
      return cFailure("action_state_unavailable", selectedSave.eventId);
    }
    const firstAction = actionTimeline[0];
    if (!Number.isFinite(occurrence.actionOrder) || !Number.isFinite(firstAction.order) ||
      numericTime(firstAction.at) !== actionAt || firstAction.order !== occurrence.actionOrder) {
      return cFailure("action_state_unavailable", selectedSave.eventId);
    }
    let previousActionTime = null;
    let previousActionOrder = null;
    for (const [index, action] of actionTimeline.entries()) {
      const recordedAction = occurrence.actionRows[index];
      if (recordedAction.order !== action.order || numericTime(recordedAction.at) !== numericTime(action.at) ||
        recordedAction.compactEpoch !== action.compactEpoch) {
        return cFailure("action_state_unavailable", selectedSave.eventId);
      }
      const actionTime = numericTime(action.at);
      if (actionTime === null || !Number.isFinite(action.order) || (occurredAt !== null && actionTime > occurredAt)) {
        return cFailure("action_state_unavailable", selectedSave.eventId);
      }
      if (previousActionTime !== null && actionTime < previousActionTime) {
        return cFailure("action_state_unavailable", selectedSave.eventId);
      }
      if (previousActionOrder !== null && action.order <= previousActionOrder) {
        return cFailure("action_state_unavailable", selectedSave.eventId);
      }
      if (actionTime === occurredAt && Number.isFinite(action.order) && Number.isFinite(occurrence.order) && action.order >= occurrence.order) {
        return cFailure("action_state_unavailable", selectedSave.eventId);
      }
      previousActionTime = actionTime;
      previousActionOrder = action.order;

      const ruleSnapshots = Array.isArray(action.ruleSnapshots) ? action.ruleSnapshots : [];
      const actionSnapshot = ruleSnapshots.find((snapshot) => snapshot.bundleKey === selectedSave.bundleKey);
      if (!actionSnapshot || actionSnapshot.status !== "confirmed" || actionSnapshot.version !== selectedSave.version ||
        !Array.isArray(actionSnapshot.evidenceEventIds) || !actionSnapshot.evidenceEventIds.includes(selectedSave.eventId)) {
        return cFailure("stale_version", selectedSave.eventId);
      }
      if ((selectedSave.expiresAt && numericTime(selectedSave.expiresAt) <= actionTime) ||
        (actionSnapshot.expiresAt && numericTime(actionSnapshot.expiresAt) <= actionTime)) {
        return cFailure("expired_before_action", selectedSave.eventId);
      }

      let actionSessionId = action.sessionId;
      if (!actionSessionId) actionSessionId = occurrence.sessionId;
      let actionSessionHash = action.sessionHash;
      if (!actionSessionHash) actionSessionHash = occurrence.sessionHash;
      const beforeThisAction = (emission) => {
        const emittedAt = numericTime(emission.emittedAt);
        if (emittedAt === null || emittedAt > actionTime) return false;
        if (emittedAt < actionTime) return true;
        const sameSession = emission.sessionHash
          ? emission.sessionHash === actionSessionHash
          : emission.sessionId === actionSessionId;
        return sameSession && Number.isFinite(action.order) && Number.isFinite(emission.order) && emission.order < action.order;
      };
      const sessionEmissions = relatedEmissions.filter((emission) => emission.sessionId === actionSessionId);
      const outputsBeforeThisAction = sessionEmissions.filter(beforeThisAction);
      const sameEpochOutputs = outputsBeforeThisAction.filter((emission) => emission.compactEpoch === action.compactEpoch);
      const validOutput = sameEpochOutputs.find((emission) => {
        if (!hasBody(emission)) return false;
        const isPriorPromptOutput = (emission.trigger === "prompt" || emission.trigger === "refresh") &&
          Number.isFinite(emission.humanOrdinal) && emission.humanOrdinal < occurrence.humanOrdinal;
        if (emission.trigger !== "start" && !isPriorPromptOutput) return false;
        const emittedAt = numericTime(emission.emittedAt);
        if (emission.versionStatus && emission.versionStatus !== "confirmed") return false;
        if (selectedSave.expiresAt && numericTime(selectedSave.expiresAt) <= emittedAt) return false;
        if (emission.expiresAt && numericTime(emission.expiresAt) <= emittedAt) return false;
        if (selectedSave.expiresAt && numericTime(selectedSave.expiresAt) <= actionTime) return false;
        if (emission.expiresAt && numericTime(emission.expiresAt) <= actionTime) return false;
        if (!actionSnapshot.expiresAt) return true;
        return numericTime(actionSnapshot.expiresAt) > actionTime;
      });
      if (validOutput) continue;

      const invalidOutput = sameEpochOutputs.find((emission) => hasBody(emission) && (
        (emission.versionStatus && emission.versionStatus !== "confirmed") ||
        (emission.expiresAt && numericTime(emission.expiresAt) <= numericTime(emission.emittedAt)) ||
        (emission.expiresAt && numericTime(emission.expiresAt) <= actionTime) ||
        (selectedSave.expiresAt && numericTime(selectedSave.expiresAt) <= actionTime)
      ));
      if (invalidOutput) {
        let reason = invalidOutputReason(invalidOutput);
        if (!reason) reason = "expired_before_action";
        return cFailure(reason, selectedSave.eventId);
      }
      if (sameEpochOutputs.some((emission) => !hasBody(emission))) return cFailure("body_not_emitted", selectedSave.eventId);
      if (sessionEmissions.some((emission) => emission.compactEpoch !== action.compactEpoch && beforeThisAction(emission))) {
        return cFailure("wrong_compact_epoch", selectedSave.eventId);
      }
      if (sessionEmissions.some((emission) => emission.compactEpoch === action.compactEpoch && !beforeThisAction(emission))) {
        return cFailure("output_after_action", selectedSave.eventId);
      }
      if (relatedEmissions.some((emission) => emission.sessionId !== actionSessionId && hasBody(emission) && beforeThisAction(emission))) {
        return cFailure("wrong_session", selectedSave.eventId);
      }
      let reason = cReason;
      if (!reason) reason = "not_emitted";
      return cFailure(reason, selectedSave.eventId);
    }
    return { prevented: true, failedAt: null, reason: null, sourceEventId: selectedSave.eventId };
  }

  const validOutputsBeforeAction = outputsBeforeAction.filter((emission) => hasBody(emission) && !invalidOutputReason(emission));
  const emittedBody = validOutputsBeforeAction.find((emission) =>
    emission.sessionId === occurrence.sessionId && emission.compactEpoch === occurrence.compactEpoch);

  if (emittedBody) {
    if (emittedBody.trigger !== "start" && !(emittedBody.humanOrdinal < occurrence.humanOrdinal)) {
      return cFailure("output_after_action", selectedSave.eventId);
    }
    return { prevented: true, failedAt: null, reason: null, sourceEventId: selectedSave.eventId };
  }

  const invalidOutputs = outputsBeforeAction
    .filter((emission) => hasBody(emission) && invalidOutputReason(emission))
    .sort((left, right) => numericTime(left.emittedAt) - numericTime(right.emittedAt));
  if (invalidOutputs.length > 0) {
    return cFailure(invalidOutputReason(invalidOutputs[0]), selectedSave.eventId);
  }
  if (selectedSave.expiresAt && numericTime(selectedSave.expiresAt) <= actionAt) {
    return cFailure("expired_before_action", selectedSave.eventId);
  }
  if (currentSnapshot?.expiresAt && numericTime(currentSnapshot.expiresAt) <= actionAt) {
    return cFailure("expired_before_action", selectedSave.eventId);
  }
  const bodyless = outputsBeforeAction.find((emission) =>
    emission.sessionId === occurrence.sessionId && emission.compactEpoch === occurrence.compactEpoch && !hasBody(emission),
  );
  if (bodyless) {
    return cFailure("body_not_emitted", selectedSave.eventId);
  }
  const wrongEpoch = relatedEmissions.some((emission) => emission.sessionId === occurrence.sessionId && beforeAction(emission, "emittedAt"));
  if (wrongEpoch) {
    return cFailure("wrong_compact_epoch", selectedSave.eventId);
  }
  if (relatedEmissions.some((emission) => emission.sessionId === occurrence.sessionId && !beforeAction(emission, "emittedAt"))) {
    return cFailure("output_after_action", selectedSave.eventId);
  }
  if (validOutputsBeforeAction.some((emission) => emission.sessionId !== occurrence.sessionId)) {
    return cFailure("wrong_session", selectedSave.eventId);
  }
  return cFailure(cReason ?? "not_emitted", selectedSave.eventId);
}

function normalizeBody(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function summaryFor(rows) {
  const recurrenceCount = rows.length;
  const preventedCount = rows.filter((row) => row.result?.prevented ?? row.prevented).length;
  return {
    recurrenceCount,
    preventedCount,
    rate: recurrenceCount === 0 ? null : preventedCount / recurrenceCount,
  };
}

export function summarizePrevention(rows) {
  const main = rows.filter((row) => /^B(?:[2-9]|10)$/u.test(row.bundleLabel));
  const b1 = rows.filter((row) => row.bundleLabel === "B1");
  return { main: summaryFor(main), b1: summaryFor(b1) };
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function normalizeHashSet(hashes) {
  const required = ["manifestHash", "sourceHash", "compiledHash", "splitHash", "auditPromptHash"];
  const normalized = {};
  for (const key of required) {
    if (typeof hashes?.[key] !== "string" || hashes[key].length === 0) {
      throw new Error("replay freeze hash is missing: " + key);
    }
    normalized[key] = hashes[key];
  }
  return normalized;
}

export function splitReplaySessions(sessions) {
  const sorted = [...sessions].sort((left, right) =>
    String(left.sessionHash).localeCompare(String(right.sessionHash)),
  );
  const hashes = sorted.map((session) => session.sessionHash);
  if (hashes.some((hash) => typeof hash !== "string" || hash.length === 0) || new Set(hashes).size !== hashes.length) {
    throw new Error("replay split requires unique session hashes");
  }
  const shuffled = [...sorted];
  const random = seededRandom(SAMPLE_SEED);
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
  }
  const adjustmentCount = Math.floor(shuffled.length * 0.7);
  return {
    tune: shuffled.slice(0, adjustmentCount),
    evaluation: shuffled.slice(adjustmentCount),
  };
}

export async function freezeReplayEvaluation(scratchRoot, hashes) {
  const root = resolve(scratchRoot);
  await mkdir(root, { recursive: true });
  const filename = join(root, "evaluation-freeze.json");
  const body = JSON.stringify({ hashes: normalizeHashSet(hashes) }, null, 2);
  try {
    await writeFile(filename, body + "\n", { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("replay evaluation inputs already frozen");
    throw error;
  }
  return { filename, hashes: normalizeHashSet(hashes) };
}

export async function claimReplayEvaluation(scratchRoot, hashes) {
  const root = resolve(scratchRoot);
  const frozen = JSON.parse(await readFile(join(root, "evaluation-freeze.json"), "utf8"));
  const normalized = normalizeHashSet(hashes);
  if (JSON.stringify(frozen.hashes) !== JSON.stringify(normalized)) {
    throw new Error("replay evaluation hashes do not match frozen inputs");
  }
  const filename = join(root, "evaluation-claim.json");
  try {
    await writeFile(filename, JSON.stringify({ claimed: true, inputHash: sha256(JSON.stringify(normalized)) }) + "\n", {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("replay evaluation already consumed");
    throw error;
  }
  return { claimed: true };
}

function deterministicSample(items, limit, seed) {
  const shuffled = [...items].sort((left, right) =>
    String(left.eventId ?? left.id).localeCompare(String(right.eventId ?? right.id)) ||
    String(left.bundleKey ?? "").localeCompare(String(right.bundleKey ?? "")) ||
    String(left.bundle_label ?? "").localeCompare(String(right.bundle_label ?? "")),
  );
  const random = seededRandom(seed);
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
  }
  return shuffled.slice(0, Math.min(limit, shuffled.length));
}

function wilsonInterval(successes, total, z = 1.96) {
  if (total === 0) return null;
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p) / total) + (z2 / (4 * total * total)))) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

function readJudgmentFile(content) {
  const trimmed = content.trim();
  if (!trimmed) return [];
  let values;
  try {
    const parsed = JSON.parse(trimmed);
    values = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    values = trimmed.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  }
  return values.filter((value) => value && typeof value.id === "string" &&
    ((value.verdict === "undetermined" && value.is_correction === null && value.rule_ok === null) ||
      (typeof value.is_correction === "boolean" && typeof value.rule_ok === "boolean" &&
        [undefined, "valid", "invalid"].includes(value.verdict))));
}

function auditRates(rows) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const detected = [...byId.values()].filter((row) => row.group === "confirmed" || row.group === "candidate");
  const confirmed = [...byId.values()].filter((row) => row.group === "confirmed");
  const negative = [...byId.values()].filter((row) => row.group === "negative");
  const falseDetection = detected.filter((row) => row.is_correction === false).length;
  const falseSave = confirmed.filter((row) => row.rule_ok === false).length;
  const missed = negative.filter((row) => row.is_correction === true).length;
  return {
    falseDetection: { errors: falseDetection, total: detected.length, interval: wilsonInterval(falseDetection, detected.length) },
    falseSave: { errors: falseSave, total: confirmed.length, interval: wilsonInterval(falseSave, confirmed.length) },
    miss: { errors: missed, total: negative.length, interval: wilsonInterval(missed, negative.length) },
  };
}

export async function loadAuditResults(auditArgs, auditRows) {
  const labels = [
    { key: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
    { key: "claude-opus", label: "Claude Opus" },
  ];
  if (!auditArgs) {
    return {
      status: "audit_model_unavailable",
      judges: labels.map((judge) => ({ label: judge.label, missing: true, modelVersion: null, matchedCount: 0, rates: null })),
      disagreementCount: null,
      falseSaveUpperBound: null,
    };
  }
  let payload;
  try {
    payload = JSON.parse(await readFile(auditArgs, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        status: "audit_model_unavailable",
        judges: labels.map((judge) => ({ label: judge.label, missing: true, modelVersion: null, matchedCount: 0, rates: null })),
        disagreementCount: null,
        falseSaveUpperBound: null,
      };
    }
    throw error;
  }
  const rowById = new Map(auditRows.map((row) => [row.id, row]));
  const judges = labels.map(({ key, label }) => {
    const entry = payload?.[key];
    if (!entry || typeof entry.modelVersion !== "string" || entry.modelVersion.length > 120 ||
      !/^[\p{L}\p{N} ._+\/-]+$/u.test(entry.modelVersion) || !Array.isArray(entry.results)) {
      return { label, missing: true, modelVersion: null, matchedCount: 0, rates: null, results: [] };
    }
    const results = readJudgmentFile(JSON.stringify(entry.results)).map((result) => {
      const sample = rowById.get(result.id);
      return sample ? {
        ...sample,
        is_correction: result.is_correction,
        rule_ok: result.rule_ok,
        verdict: result.verdict ?? "valid",
      } : null;
    }).filter(Boolean);
    const byGroup = Object.fromEntries(["confirmed", "candidate", "negative"].map((group) => [
      group,
      auditRates(results.filter((row) => row.group === group)),
    ]));
    return { label, missing: false, modelVersion: entry.modelVersion, matchedCount: results.length, rates: auditRates(results), byGroup, results };
  });
  const leftRows = new Map(judges[0].results.map((row) => [row.id, row]));
  const rightRows = new Map(judges[1].results.map((row) => [row.id, row]));
  const overlap = [...leftRows.keys()].filter((id) => rightRows.has(id));
  const disagreementCount = judges.some((judge) => judge.missing) ? null : overlap.filter((id) => {
    const left = leftRows.get(id);
    const right = rightRows.get(id);
    return left.is_correction !== right.is_correction || left.rule_ok !== right.rule_ok;
  }).length;
  const confirmedRows = auditRows.filter((row) => row.group === "confirmed");
  const unresolvedRows = auditRows.filter((row) => !leftRows.has(row.id) || !rightRows.has(row.id) ||
    leftRows.get(row.id)?.verdict === "undetermined" || rightRows.get(row.id)?.verdict === "undetermined").length;
  const falseSaveErrors = confirmedRows.filter((row) => {
    const left = leftRows.get(row.id);
    const right = rightRows.get(row.id);
    if (!left || !right || left.verdict === "undetermined" || right.verdict === "undetermined") return true;
    if (left.is_correction !== right.is_correction || left.rule_ok !== right.rule_ok) return true;
    return left.is_correction === false || left.rule_ok === false;
  }).length;
  const falseSaveUpperBound = confirmedRows.length === 0
    ? null
    : falseSaveErrors / confirmedRows.length;
  return {
    status: judges.some((judge) => judge.missing) || unresolvedRows > 0 ? "audit_model_unavailable" : "監査結果読込済み",
    judges: judges.map(({ results, ...judge }) => judge),
    disagreementCount,
    falseSaveUpperBound,
    falseSaveUpperBoundNumerator: falseSaveErrors,
    falseSaveUpperBoundDenominator: confirmedRows.length,
    unresolvedRows,
  };
}

function summarizeDurations(values) {
  const durations = values.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    count: durations.length,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: durations.length > 0 ? durations[durations.length - 1] : null,
    over4000Ms: durations.filter((value) => value > 4000).length,
    over5000Ms: durations.filter((value) => value > 5000).length,
  };
}

function evenlySpaced(items, count) {
  if (items.length <= count) return [...items];
  if (count <= 1) return [items[0]];
  return Array.from({ length: count }, (_, index) => items[Math.round(index * (items.length - 1) / (count - 1))]);
}

function fixedSample(items, count) {
  if (items.length === 0) return [];
  if (items.length >= count) return evenlySpaced(items, count);
  return Array.from({ length: count }, (_, index) => items[index % items.length]);
}

function nextCursorIdentity(snapshotMeta, snapshot, byteOffset) {
  const markerStart = Math.max(0, byteOffset - 64);
  return `${snapshotMeta.device}:${snapshotMeta.inode}:${sha256(snapshot.subarray(markerStart, byteOffset))}`;
}

function confidenceConditions(candidate, ruleTemplate) {
  return ruleTemplate.serializeCorrectionRuleInput(candidate.ruleInput);
}

function candidateVisibility(candidate) {
  const ownerTopics = new Set(["tone", "response_policy", "document_delivery", "expression_policy", "summary_constraints"]);
  const conditions = candidate.conditionKey.split(";");
  if (!ownerTopics.has(candidate.topicKey)) return "project";
  if (conditions.some((condition) => !["general", "continuing", "audience:owner"].includes(condition))) return "project";
  return "owner";
}

function candidateContinuation(candidate) {
  if (candidate.lifetimeKind === "explicit_continuing") return "explicit-continuing-command";
  if (candidate.lifetimeKind === "task") return "task-scoped-request";
  if (candidate.lifetimeKind === "routing") return "temporary-model-routing";
  return "inferred-repeat";
}

function readCurrentSessionState(storage, sessionHash) {
  return storage.runCorrectionTransaction(({ db }) => {
    const row = db.prepare(`
      SELECT human_ordinal, transcript_offset, transcript_identity, compact_epoch
      FROM owner_correction_sessions WHERE session_id_hash = ?
    `).get(sessionHash);
    if (!row) return { humanOrdinal: 0, transcriptOffset: 0, transcriptIdentity: "", compactEpoch: 0 };
    return {
      humanOrdinal: row.human_ordinal,
      transcriptOffset: row.transcript_offset,
      transcriptIdentity: row.transcript_identity,
      compactEpoch: row.compact_epoch,
    };
  });
}

function addOutputLedger(storage, sessionHash, epoch, ordinal, trigger, at, rendered) {
  if (rendered.ledger.length === 0) return;
  storage.runCorrectionTransaction(({ db }) => {
    const insert = db.prepare(`
      INSERT INTO owner_correction_injections (
        session_id_hash, compact_epoch, bundle_key, version, human_ordinal, trigger,
        emitted_at, output_order, body_hash, output_hash, token_estimate, body_included, stdout_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'emitted')
      ON CONFLICT(session_id_hash, compact_epoch, bundle_key, version, human_ordinal, trigger) DO NOTHING
    `);
    for (const entry of rendered.ledger) {
      insert.run(sessionHash, epoch, entry.bundleKey, entry.version, ordinal, trigger, at,
        entry.outputOrder, entry.bodyHash, rendered.outputHash, rendered.tokenCount);
    }
  });
}

async function createRuntime(compiledRoot, scratchRoot) {
  process.env.HOME = join(resolve(scratchRoot), "home");
  process.env.MEMORY_DIR = resolve(scratchRoot);
  process.env.WASURENAGUSA_CORRECTION_LOOP = "on";
  process.env.WASURENAGUSA_CORRECTION_INJECT = "on";
  const importCompiled = async (relativePath) => import(pathToFileURL(join(compiledRoot, relativePath)).href);
  const [sqlite, correctionSchema, events, detector, sessionStore, correctionStore, context, policy, render, budget, transcriptReader, redact, query, ruleTemplate] = await Promise.all([
    importCompiled("storage/sqlite.js"),
    importCompiled("storage/correction-schema.js"),
    importCompiled("corrections/events.js"),
    importCompiled("corrections/detector.js"),
    importCompiled("corrections/session-store.js"),
    importCompiled("corrections/store.js"),
    importCompiled("cli/context.js"),
    importCompiled("corrections/injection-policy.js"),
    importCompiled("corrections/render.js"),
    importCompiled("injection/budget.js"),
    importCompiled("cli/transcript-reader.js"),
    importCompiled("utils/redact-sensitive-data.js"),
    importCompiled("corrections/retrieval.js"),
    importCompiled("corrections/rule-template.js"),
  ]);
  const memoryPath = resolve(scratchRoot);
  await mkdir(memoryPath, { recursive: true });
  const dbPath = join(memoryPath, "memory.db");
  const storage = new sqlite.SQLiteStorage(dbPath);
  storage.initialize(memoryPath);
  correctionSchema.initializeCorrectionSchema(storage.db);
  if (correctionSchema.CORRECTION_SCHEMA_VERSION !== 11) throw new Error("scratch correction store is not schema v11");
  return { storage, events, detector, sessionStore, correctionStore, context, policy, render, budget, transcriptReader, redact, query, ruleTemplate };
}

export function createReplayOccurrenceRows(timeline) {
  const priorThemeCounts = new Map();
  const rows = [];
  const previousHumanBySession = new Map();
  const actionRowsBySession = new Map();
  const compactEpochBySession = new Map();
  const compactPendingBySession = new Set();
  for (const row of timeline) {
    let sessionHash = row.sessionHash;
    if (row.input?.sessionHash) sessionHash = row.input.sessionHash;
    let compactEpoch = compactEpochBySession.get(sessionHash);
    if (compactEpoch === undefined) compactEpoch = 0;
    if (row.kind === "start") {
      if (row.source === "compact") {
        if (!compactPendingBySession.has(sessionHash)) compactEpochBySession.set(sessionHash, compactEpoch + 1);
        compactPendingBySession.delete(sessionHash);
      }
      if (row.source === "resume" || row.source === "clear") compactEpochBySession.set(sessionHash, compactEpoch + 1);
      continue;
    }
    if (row.kind === "compact") {
      compactEpochBySession.set(sessionHash, compactEpoch + 1);
      compactPendingBySession.add(sessionHash);
      continue;
    }
    if (row.kind === "assistant") {
      if (previousHumanBySession.has(sessionHash)) {
        let actionRows = actionRowsBySession.get(sessionHash);
        if (!actionRows) actionRows = [];
        let at = row.availableAt;
        if (!at && Number.isFinite(row.availableMs)) at = new Date(row.availableMs).toISOString();
        let order = row.globalOrder;
        if (order === undefined) order = null;
        let actionCompactEpoch = row.compactEpoch;
        if (actionCompactEpoch === undefined || actionCompactEpoch === null) actionCompactEpoch = compactEpoch;
        let sessionId = row.sessionId;
        if (!sessionId && row.input?.sessionId) sessionId = row.input.sessionId;
        if (!sessionId) sessionId = null;
        let actionSessionHash = row.sessionHash;
        if (!actionSessionHash && row.input?.sessionHash) actionSessionHash = row.input.sessionHash;
        if (!actionSessionHash) actionSessionHash = null;
        actionRows.push({
          at,
          order,
          compactEpoch: actionCompactEpoch,
          sessionId,
          sessionHash: actionSessionHash,
        });
        actionRowsBySession.set(sessionHash, actionRows);
      }
      continue;
    }
    if (row.kind !== "human") continue;
    const input = row.input;
    const previousHuman = previousHumanBySession.get(sessionHash) ?? null;
    let actionRows = actionRowsBySession.get(sessionHash);
    if (!actionRows) actionRows = [];
    let priorAction = actionRows[0];
    if (!priorAction) priorAction = null;
    previousHumanBySession.set(sessionHash, input);
    actionRowsBySession.set(sessionHash, []);
    const counts = new Map();
    for (const label of input.labels) {
      const next = (priorThemeCounts.get(label) ?? 0) + 1;
      priorThemeCounts.set(label, next);
      counts.set(label, next);
    }
    input.themeOccurrenceNumbers = counts;
    if (input.dateJst && input.dateJst >= DATE_START && input.dateJst <= DATE_END) {
      for (const label of input.labels) {
        if (counts.get(label) < 2) continue;
        let actionStartAt = null;
        let actionOrder = null;
        if (priorAction) {
          actionStartAt = priorAction.at;
          actionOrder = priorAction.order;
        }
        rows.push({
          eventId: input.eventId,
          bundleLabel: label,
          sessionId: input.sessionId,
          sessionHash: input.sessionHash,
          compactEpoch: 0,
          humanOrdinal: 0,
          at: input.availableAt,
          actionStartAt,
          actionOrder,
          actionRows: actionRows.map((action) => ({ ...action })),
          order: row.globalOrder,
          previousHumanEventId: previousHuman?.eventId ?? null,
          previousHumanOrder: previousHuman?.globalOrder ?? null,
          input,
        });
      }
    }
  }
  return rows;
}

function assistantContextFor(input, runtime) {
  const records = input.transcriptRecords;
  const preceding = runtime.transcriptReader.getPreviousAssistantContext(records, input.byteOffset);
  const assistantTexts = [];
  let toolName = "";
  for (const record of preceding) {
    const entry = record.entry;
    if (entry.type === "assistant") {
      const text = readText(entry.message?.content);
      if (text) assistantTexts.push(text);
    }
    const name = entry.name ?? entry.tool_name ?? entry.message?.name;
    if (typeof name === "string" && name) toolName = name;
    if (entry.type === "tool_use" && !toolName) toolName = "tool_use";
    if (entry.type === "tool_result" && !toolName) toolName = "tool_result";
    if (Array.isArray(entry.message?.content)) {
      for (const part of entry.message.content) if (part?.type === "tool_use" && typeof part.name === "string") toolName = part.name;
    }
  }
  const previousAssistantText = runtime.redact.redactSensitive(
    runtime.events.removeQuotedAndInjectedContent(assistantTexts.join("\n")),
  );
  const lastAssistantText = assistantTexts.length > 0
    ? runtime.redact.redactSensitive(runtime.events.removeQuotedAndInjectedContent(assistantTexts.at(-1))).trim()
    : "";
  return {
    previousAssistantText,
    previousAssistantToolName: toolName,
    previousAssistantSessionId: input.sessionId,
    latestAssistantText: lastAssistantText,
    firstLocatorHash: preceding.length > 0
      ? runtime.sessionStore.hashTranscriptPosition(input.sessionId, preceding[0].byteOffset)
      : undefined,
    lastLocatorHash: preceding.length > 0
      ? runtime.sessionStore.hashTranscriptPosition(input.sessionId, preceding.at(-1).byteOffset)
      : undefined,
  };
}

function outputSnapshot(storage, bundleKey, version, sourceEventIds) {
  return storage.runCorrectionTransaction(({ db }) => {
    const row = db.prepare(`
      SELECT v.rule_text AS ruleText, v.body_hash AS bodyHash, v.status, v.expires_at AS expiresAt,
        v.evidence_event_ids AS evidenceEventIds
      FROM owner_correction_versions v WHERE v.bundle_key = ? AND v.version = ?
    `).get(bundleKey, version);
    if (!row) return null;
    const evidenceEventIds = JSON.parse(row.evidenceEventIds);
    return {
      ...row,
      evidenceEventIds,
      sourceEventIds: sourceEventIds.filter((id) => evidenceEventIds.includes(id)),
    };
  });
}

function selectFailureHint(storage, selection, rendered, input, trigger, epoch) {
  if (rendered.omittedBundleKeys.length > 0) return "budget";
  if (input.queued && !input.hookReached) return "queued_unreached";
  if (selection.ftsCandidateCount === 0 && selection.alwaysOnCount === 0) return "retrieval_zero";
  const recent = storage.runCorrectionTransaction(({ db }) => db.prepare(`
    SELECT MAX(human_ordinal) AS ordinal FROM owner_correction_injections
    WHERE session_id_hash = ? AND compact_epoch = ? AND stdout_status = 'emitted'
  `).get(input.sessionHash, epoch)?.ordinal);
  if (Number.isFinite(recent) && input.humanOrdinal - recent <= 10) return "cooldown";
  return trigger === "compact" ? "compact" : "not_emitted";
}

function eventIdForInput(input, runtime) {
  const locator = input.uuid ? { uuid: input.uuid } : { transcriptPosition: input.byteOffset };
  return runtime.sessionStore.createCorrectionEventId(input.sessionId, locator);
}

function buildTranscriptContext(sessions, runtime) {
  const timeline = [];
  const bySession = new Map();
  for (const session of sessions) {
    const rows = [];
    for (const row of session.timeline) {
      if (row.kind === "human") {
        row.input.eventId = row.input.eventId ?? eventIdForInput(row.input, runtime);
        row.input.sessionHash = runtime.sessionStore.hashSessionId(row.input.sessionId);
        rows.push(row);
      } else if (["stop", "start", "compact"].includes(row.kind)) {
        rows.push(row);
      } else if (row.kind === "assistant") {
        rows.push(row);
      }
    }
    bySession.set(session.sessionHash, rows);
    for (const row of rows) {
      row.globalOrder = timeline.length + 1;
      row.availableAt = Number.isFinite(row.availableMs) ? new Date(row.availableMs).toISOString() : null;
      timeline.push(row);
    }
  }
  timeline.sort(compareAvailable);
  timeline.forEach((row, index) => { row.globalOrder = index + 1; });
  for (const [sessionHash, rows] of bySession) {
    for (const row of rows) {
      const matching = timeline.find((entry) => entry.sessionHash === sessionHash && entry.lineOrder === row.lineOrder && entry.kind === row.kind);
      if (matching) row.globalOrder = matching.globalOrder;
    }
  }
  return { timeline, bySession };
}

function makeSessionEvent(input, context, runtime, processedAt) {
  const eventId = input.eventId;
  const availableAt = input.availableAt ?? processedAt;
  const ownerEvent = runtime.events.extractOwnerEvent(input.event);
  const eventText = ownerEvent?.text ?? input.text;
  const previousText = context.latestAssistantText;
  const target = ["質問", "回答", "返答", "待機", "全文", "本文", "文書", "文章", "比喩", "用語", "字数", "文字数", "要約", "フォント", "CSS", "デザイン", "部品", "原本", "出典", "検証", "確認", "設計", "実装", "保存", "配置", "成果物", "モデル"]
    .filter((word) => previousText.includes(word)).slice(0, 3);
  let previousAction = target.length > 0 ? `assistant:${target.join(",")}` : "";
  if (!previousAction && context.previousAssistantToolName) previousAction = `tool:${context.previousAssistantToolName}`;
  if (!previousAction) previousAction = "action_unknown";
  return {
    eventId,
    ...(input.uuid ? { sourceUuidHash: runtime.sessionStore.hashRawText(input.uuid) } : {}),
    observedAt: availableAt,
    availableAt,
    sourceKind: input.queued ? "queued_command" : "user",
    excerpt: Array.from(eventText).slice(0, 120).join(""),
    previousAction: Array.from(previousAction).slice(0, 160).join(""),
    ...(context.firstLocatorHash ? { actionFirstLocatorHash: context.firstLocatorHash } : {}),
    ...(context.lastLocatorHash ? { actionLastLocatorHash: context.lastLocatorHash } : {}),
    project: SOURCE_PROJECT,
    scope: SOURCE_SCOPE,
    rawTextHash: runtime.sessionStore.hashRawText(eventText),
    sourceLocatorHash: runtime.sessionStore.hashTranscriptPosition(input.sessionId, input.byteOffset),
    processedAt,
  };
}

function queryEvidenceSources(storage, bundleKey) {
  return storage.runCorrectionTransaction(({ db }) => db.prepare(`
    SELECT e.event_id AS eventId, e.score, v.session_id_hash AS sessionHash, v.observed_at AS observedAt
    FROM owner_correction_evidence e
    JOIN owner_correction_events v ON v.event_id = e.event_id
    WHERE e.bundle_key = ? ORDER BY datetime(v.observed_at), e.event_id
  `).all(bundleKey));
}

function snapshotRules(storage) {
  return storage.runCorrectionTransaction(({ db }) => db.prepare(`
    SELECT b.bundle_key AS bundleKey, b.version, v.rule_text AS ruleText, v.status, v.expires_at AS expiresAt,
      v.evidence_event_ids AS evidenceEventIds
    FROM owner_correction_bundles b
    JOIN owner_correction_versions v ON v.bundle_key = b.bundle_key AND v.version = b.version
  `).all().map((row) => ({ ...row, evidenceEventIds: JSON.parse(row.evidenceEventIds) })));
}

function currentVersionSnapshots(storage) {
  return snapshotRules(storage);
}

function deriveCReason(occurrence, saves, hints) {
  const actionAt = numericTime(occurrence.actionStartAt);
  const priorSaves = saves.filter((save) => save.bundleLabel === occurrence.bundleLabel && save.status === "confirmed" &&
    actionAt !== null && numericTime(save.savedAt) < actionAt)
    .sort((left, right) => numericTime(right.savedAt) - numericTime(left.savedAt));
  if (priorSaves[0]?.expiresAt && numericTime(priorSaves[0].expiresAt) <= actionAt) return "expired";
  const applicable = hints.filter((hint) => hint.bundleLabel === occurrence.bundleLabel &&
    hint.sessionId === occurrence.sessionId && Number.isFinite(occurrence.actionOrder) && hint.order < occurrence.actionOrder);
  const currentEpoch = applicable.filter((hint) => hint.compactEpoch === occurrence.compactEpoch)
    .sort((left, right) => right.order - left.order);
  if (currentEpoch.length > 0) return currentEpoch[0].reason;
  if (applicable.some((hint) => hint.compactEpoch < occurrence.compactEpoch)) return "compact";
  return "not_emitted";
}

function deriveDeliveryDiagnostics(occurrence, saves, allInputs, sessions, actionSnapshots) {
  const secondaryReasons = new Set();
  const actionAt = numericTime(occurrence.actionStartAt);
  const relevantSaves = saves.filter((save) =>
    save.status === "confirmed" &&
    actionAt !== null &&
    numericTime(save.savedAt) < actionAt &&
    Array.isArray(save.evidenceEventIds) &&
    save.evidenceEventIds.includes(save.eventId),
  ).sort((left, right) => numericTime(right.savedAt) - numericTime(left.savedAt));
  const activeSave = relevantSaves.find((save) => {
    if (save.expiresAt && numericTime(save.expiresAt) <= actionAt) return false;
    const snapshot = actionSnapshots.find((entry) => entry.bundleKey === save.bundleKey);
    if (!snapshot) return true;
    return snapshot.status === "confirmed" && snapshot.version === save.version &&
      (!snapshot.expiresAt || numericTime(snapshot.expiresAt) > actionAt) &&
      snapshot.evidenceEventIds.includes(save.eventId);
  });
  if (activeSave) secondaryReasons.add("version_valid_at_action");
  else if (relevantSaves.length > 0) secondaryReasons.add("version_invalid_at_action");

  const session = sessions.find((entry) => entry.sessionHash === occurrence.sessionHash);
  const startObservations = (session?.startHookObservations ?? [])
    .filter((entry) => entry.globalOrder <= occurrence.actionOrder && entry.compactEpoch === occurrence.compactEpoch)
    .sort((left, right) => left.globalOrder - right.globalOrder);
  const startObservation = startObservations.at(-1);
  if (!startObservation || !startObservation.observed) secondaryReasons.add("hook_observation_unknown");

  if (activeSave && startObservation) {
    const saveAvailableAt = numericTime(activeSave.savedAt);
    const startAt = numericTime(startObservation.at);
    if (saveAvailableAt !== null && startAt !== null && saveAvailableAt > startAt) {
      secondaryReasons.add("confirmed_after_start");
    }
    const startAttempts = (session.deliveryAttempts ?? []).filter((entry) =>
      entry.bundleKey === activeSave.bundleKey &&
      entry.version === activeSave.version &&
      entry.globalOrder === startObservation.globalOrder,
    );
    if (startAttempts.some((entry) => entry.reason === "item_limit")) secondaryReasons.add("start_slot_limit");
    if (startAttempts.some((entry) => entry.reason === "token_budget")) secondaryReasons.add("start_budget_skip");
    const laterDelivery = (session.deliveryAttempts ?? []).some((entry) =>
      entry.bundleKey === activeSave.bundleKey &&
      entry.version === activeSave.version &&
      entry.globalOrder > startObservation.globalOrder &&
      entry.globalOrder < occurrence.actionOrder &&
      entry.emitted,
    );
    if ((startAttempts.some((entry) => entry.reason === "item_limit" || entry.reason === "token_budget")
      || (saveAvailableAt !== null && startAt !== null && saveAvailableAt > startAt)) && !laterDelivery) {
      secondaryReasons.add("later_delivery_missing");
    }
  }

  const promptInputs = allInputs.filter((input) =>
    input.sessionHash === occurrence.sessionHash &&
    input.globalOrder > (occurrence.previousHumanOrder ?? -1) &&
    input.globalOrder <= occurrence.order,
  );
  const observedPrompts = promptInputs.filter((input) => input.hookMetrics?.observed === true);
  if (observedPrompts.length === 0) secondaryReasons.add("hook_observation_unknown");
  if (observedPrompts.length > 0 && observedPrompts.every((input) => (input.hookMetrics?.relatedCandidateCount ?? 0) === 0)) {
    secondaryReasons.add("related_search_miss");
  }
  if (promptInputs.some((input) => input.globalOrder === occurrence.order && input.hookMetrics?.successfulOutputCount > 0)) {
    secondaryReasons.add("current_recurrence_output");
  }
  return { secondaryReasons: [...secondaryReasons] };
}

function reasonLabel(reason) {
  const labels = {
    no_prior_candidate: "(a) 先行検出なし",
    prior_ai_action_missing: "(b) 直前AI行動なし",
    no_prior_confirmed_save: "(b) 先行confirmed保存なし",
    not_confirmed: "(b) candidate止まり",
    saved_after_action_start: "(b) 行動開始後の保存",
    wrong_session: "(c) 別session出力",
    wrong_compact_epoch: "(c) compact epoch不一致",
    output_after_action: "(c) 行動開始後の出力",
    body_not_emitted: "(c) 本文未出力・予算落ち",
    expired_at_injection: "(c) 注入時期限切れ",
    expired_before_action: "(c) 行動開始時期限切れ",
    stale_version: "(c) 旧版・取消済み",
    expired_before_action: "(c) 行動開始時期限切れ",
    cooldown: "(c) 冷却",
    budget: "(c) 予算",
    expired: "(c) 期限",
    compact: "(c) compact後未再注入",
    queued_unreached: "(c) queued未到達",
    retrieval_zero: "(c) 関連検索0件",
    not_emitted: "(c) 本文出力記録なし",
    version_valid_at_action: "(c) 行動時点で有効",
    version_invalid_at_action: "(c) 行動時点で無効",
    confirmed_after_start: "(c) 開始後確定",
    start_slot_limit: "(c) 開始枠超過",
    start_budget_skip: "(c) 開始予算落ち",
    later_delivery_missing: "(c) 後続配送なし",
    hook_observation_unknown: "(c) hook観測不明",
    related_search_miss: "(c) 関連検索不一致",
    current_recurrence_output: "(c) 再発発話での出力",
  };
  return labels[reason] ?? String(reason);
}

function perTheme(rows) {
  const labels = Array.from({ length: 10 }, (_, index) => `B${index + 1}`);
  return Object.fromEntries(labels.map((label) => [label, summaryFor(rows.filter((row) => row.bundleLabel === label))]));
}

function preventionDiagnostics(rows) {
  const failures = { a: 0, b: 0, c: 0 };
  const cReasons = {};
  const secondaryReasons = {};
  const byLabel = {};
  const bySession = { sameSession: 0, otherSession: 0 };
  for (const row of rows) {
    if (row.result.prevented) {
      const key = row.sourceSessionId === row.sessionId ? "sameSession" : "otherSession";
      bySession[key] += 1;
      continue;
    }
    failures[row.result.failedAt] += 1;
    const reason = row.result.reason;
    if (row.result.failedAt === "c") cReasons[reason] = (cReasons[reason] ?? 0) + 1;
    for (const secondaryReason of row.result.secondaryReasons ?? []) {
      secondaryReasons[secondaryReason] = (secondaryReasons[secondaryReason] ?? 0) + 1;
    }
    byLabel[row.bundleLabel] ??= {};
    byLabel[row.bundleLabel][reason] = (byLabel[row.bundleLabel][reason] ?? 0) + 1;
  }
  return { failures, cReasons, secondaryReasons, byLabel, bySession };
}

function uniqueOccurrenceCount(rows) {
  return new Set(rows.map((row) => row.eventId)).size;
}

function buildAuditRows(allInputs, events, redact) {
  const confirmed = [];
  const candidate = [];
  const negative = [];
  for (const input of allInputs) {
    if (input.labels.length === 0) continue;
    const confirmedHit = input.detections.some((entry) => entry.status === "confirmed");
    const candidateHit = input.detections.some((entry) => entry.status === "candidate");
    const previousAssistantInterval = input.previousAssistantRecords
      .map((record) => ({
        type: record.entry.type,
        text: redact.redactSensitive(events.removeQuotedAndInjectedContent(readText(record.entry.message?.content))),
      }))
      .filter((record) => record.text.length > 0);
    const proposedRules = input.detections.map((entry) => ({
      text: redact.redactSensitive(entry.ruleText),
    }));
    for (const label of input.labels) {
      const row = {
        id: sha256(`${input.eventId}:${label}`).slice(0, 24),
        human_utterance: redact.redactSensitive(input.text),
        previous_assistant_interval: previousAssistantInterval,
        proposed_rules: proposedRules,
        bundle_label: label,
        group: confirmedHit ? "confirmed" : candidateHit ? "candidate" : "negative",
        eventId: input.eventId,
        bundleKey: input.detections[0]?.bundleKey ?? "",
      };
      if (confirmedHit) confirmed.push(row);
      else if (candidateHit) candidate.push(row);
      else negative.push(row);
    }
  }
  const groups = [
    { key: "confirmed", rows: deterministicSample(confirmed, 50, SAMPLE_SEED) },
    { key: "candidate", rows: deterministicSample(candidate, 50, SAMPLE_SEED) },
    { key: "negative", rows: deterministicSample(negative, 50, SAMPLE_SEED) },
  ];
  const selected = groups.flatMap((group) => group.rows.map((row) => ({ ...row, sample_group: group.key })));
  return {
    groups: Object.fromEntries(groups.map((group) => [group.key, { available: group.key === "confirmed" ? confirmed.length : group.key === "candidate" ? candidate.length : negative.length, sampled: group.rows.length }])),
    rows: selected,
  };
}

function classifyFailureReason(rows) {
  const counts = new Map();
  for (const row of rows) if (!row.result.prevented) counts.set(row.result.reason, (counts.get(row.result.reason) ?? 0) + 1);
  if (counts.size === 0) return "防げなかった再発はありません。";
  const [reason, count] = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0];
  return `${reasonLabel(reason)}が最多で${count}件です。`;
}

function groupedRows(rows, coverage, allInputs, sessions, runtime, actionSnapshotsByEvent, titleOnlyBaseline = false) {
  const detections = [];
  const saves = [];
  const emissions = [];
  for (const input of allInputs) {
    for (const detection of input.detections) {
      for (const label of input.labels) detections.push({
        ...detection,
        sessionId: input.sessionId,
        sessionHash: input.sessionHash,
        bundleLabel: label,
      });
    }
    for (const save of input.saves) {
      for (const label of input.labels) saves.push({
        ...save,
        sessionId: save.sessionId ?? input.sessionId,
        sessionHash: save.sessionHash ?? input.sessionHash,
        bundleLabel: label,
      });
    }
    for (const emission of input.emissions) {
      for (const label of emission.bundleLabels ?? []) emissions.push({ ...emission, bundleLabel: label });
    }
  }

  const resultRows = [];
  for (const occurrence of rows) {
    const matchingDetections = detections.filter((entry) => entry.bundleLabel === occurrence.bundleLabel);
    const matchingSaves = saves.filter((entry) => entry.bundleLabel === occurrence.bundleLabel);
    const matchingEmissions = titleOnlyBaseline
      ? matchingSaves.filter((entry) => entry.status === "confirmed").map((entry) => ({
        ...entry,
        bundleLabel: occurrence.bundleLabel,
        sessionId: occurrence.sessionId,
        compactEpoch: occurrence.compactEpoch,
        trigger: "start",
        humanOrdinal: 0,
        emittedAt: occurrence.actionStartAt,
        order: Number.isFinite(occurrence.actionOrder) ? occurrence.actionOrder - 1 : -1,
        ruleText: "legacy-title-only",
        bodyText: "[legacy title only]",
        bodyIncluded: false,
        stdoutStatus: "emitted",
        versionStatus: "confirmed",
      }))
      : emissions.filter((entry) => entry.bundleLabel === occurrence.bundleLabel);
    let snapshotsForActions = actionSnapshotsByEvent.get(occurrence.eventId);
    if (!snapshotsForActions) snapshotsForActions = [];
    const occurrenceActionRows = Array.isArray(occurrence.actionRows) ? occurrence.actionRows : [];
    const actionTimeline = occurrenceActionRows.map((action) => {
      const snapshot = snapshotsForActions.find((entry) => entry.order === action.order);
      let ruleSnapshots = snapshot?.ruleSnapshots;
      if (!Array.isArray(ruleSnapshots)) ruleSnapshots = [];
      return {
        ...action,
        ruleSnapshots,
      };
    });
    let actionRuleSnapshots = [];
    if (actionTimeline.length > 0) actionRuleSnapshots = actionTimeline[0].ruleSnapshots;
    const hints = allInputs.flatMap((input) => input.emissionHints ?? []);
    const cReason = deriveCReason(occurrence, matchingSaves, hints);
    const deliveryDiagnostics = titleOnlyBaseline ? {} : deriveDeliveryDiagnostics(
      occurrence,
      matchingSaves,
      allInputs,
      sessions,
      actionRuleSnapshots,
    );
    const result = adjudicatePrevention({
      occurrence,
      detections: matchingDetections,
      saves: matchingSaves,
      emissions: matchingEmissions,
      actionRuleSnapshots,
      actionTimeline,
      cReason,
      deliveryDiagnostics,
    });
    const source = result.sourceEventId ? matchingSaves.find((save) => save.eventId === result.sourceEventId) : null;
    resultRows.push({
      ...occurrence,
      result,
      sourceSessionId: source?.sessionId ?? null,
      coverage,
    });
  }
  return resultRows;
}

function computeOutputStats(inputs, startOutputs, promptOutputs) {
  const perInput = inputs.map((input) => {
    const prompt = promptOutputs.get(input.eventId) ?? { tokens: 0, relatedTokens: 0, reinjectionTokens: 0 };
    const start = startOutputs.get(input.eventId) ?? { tokens: 0, relatedTokens: 0, reinjectionTokens: 0 };
    return {
      total: prompt.tokens + start.tokens,
      withoutStart: prompt.tokens,
      related: prompt.relatedTokens + start.relatedTokens,
      reinjection: prompt.reinjectionTokens + start.reinjectionTokens,
    };
  });
  const stat = (values) => ({
    count: values.length,
    average: values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.length === 0 ? null : Math.max(...values),
    zeroRate: values.length === 0 ? null : values.filter((value) => value === 0).length / values.length,
  });
  return {
    sessionStartIncluded: stat(perInput.map((row) => row.total)),
    sessionStartExcluded: stat(perInput.map((row) => row.withoutStart)),
    relatedRuleBodyTokens: stat(perInput.map((row) => row.related)),
    reinjectionRuleBodyTokens: stat(perInput.map((row) => row.reinjection)),
  };
}

function summarizeHookObservations(sessions, inputs) {
  const summarize = (rows) => ({
    eventCount: rows.length,
    observedCount: rows.filter((row) => row.observed === true).length,
    invokedCount: rows.filter((row) => row.invoked === true).length,
    candidateCount: rows.reduce((sum, row) => sum + (Number.isFinite(row.candidateCount) ? row.candidateCount : 0), 0),
    selectedCount: rows.reduce((sum, row) => sum + (Number.isFinite(row.selectedCount) ? row.selectedCount : 0), 0),
    successfulOutputCount: rows.reduce((sum, row) => sum + (Number.isFinite(row.successfulOutputCount) ? row.successfulOutputCount : 0), 0),
    budgetOmittedCount: rows.reduce((sum, row) => sum + (Number.isFinite(row.budgetOmittedCount) ? row.budgetOmittedCount : 0), 0),
  });
  return {
    SessionStart: summarize(sessions.flatMap((session) => session.startHookObservations ?? [])),
    UserPromptSubmit: summarize(inputs.map((input) => input.hookMetrics).filter(Boolean)),
  };
}

async function initializeBlankStore(compiledRoot, scratchRoot) {
  const runtime = await createRuntime(compiledRoot, scratchRoot);
  return runtime;
}

function resetStore(scratchRoot, compiledRoot) {
  const dbPath = join(scratchRoot, "memory.db");
  const db = new Database(dbPath);
  try {
    db.pragma("foreign_keys = ON");
    db.transaction(() => {
      for (const table of [
        "owner_correction_injections",
        "owner_correction_pending",
        "owner_correction_evidence",
        "owner_correction_versions",
        "owner_correction_bundles",
        "owner_correction_events",
        "owner_correction_sessions",
        "owner_correction_imports",
      ]) db.prepare(`DELETE FROM ${table}`).run();
      db.prepare("DELETE FROM memories").run();
      try { db.prepare("DELETE FROM vectors").run(); } catch {}
    })();
  } finally {
    db.close();
  }
}

function summarizeOutputs(rendered, selection, estimateTokens) {
  const relatedTokens = rendered.includedRules.filter((rule) => rule.delivery === "related")
    .reduce((sum, rule) => sum + estimateTokens(rule.ruleText), 0);
  return {
    tokens: rendered.tokenCount,
    relatedTokens,
    reinjectionTokens: Math.max(0, rendered.tokenCount - relatedTokens),
    rules: rendered.includedRules,
    selection,
    rendered,
  };
}

async function runCoverage({ split, coverage, sessions, compiledRoot, scratchRoot }) {
  const coverageRoot = join(resolve(scratchRoot), "splits", split, coverage);
  await mkdir(coverageRoot, { recursive: true });
  const isolatedStoreRoot = coverageRoot;
  const runtime = await initializeBlankStore(compiledRoot, isolatedStoreRoot);
  const { storage } = runtime;
  resetStore(isolatedStoreRoot, compiledRoot);
  for (const session of sessions) {
    session.startHookObservations = [];
    session.deliveryAttempts = [];
    for (const input of session.humanInputs) {
      input.detections = [];
      input.saves = [];
      input.emissions = [];
      input.emissionHints = [];
      input.hookReached = false;
      input.hookMetrics = null;
      input.humanOrdinal = null;
      input.compactEpoch = 0;
    }
  }
  const { timeline, bySession } = buildTranscriptContext(sessions, runtime);
  const inputRows = sessions.flatMap((session) => session.humanInputs);
  for (const input of inputRows) {
    input.eventId = input.eventId ?? eventIdForInput(input, runtime);
    input.sessionHash = runtime.sessionStore.hashSessionId(input.sessionId);
  }
  const startOutputs = new Map();
  const promptOutputs = new Map();
  const sessionStates = new Map();
  const pendingStopInputs = new Map();
  const snapshotsByEvent = new Map();
  const allInputs = inputRows;
  const stopFailures = [];
  for (const input of inputRows) {
    input.eventId = input.eventId ?? eventIdForInput(input, runtime);
    if (!pendingStopInputs.has(input.sessionHash)) pendingStopInputs.set(input.sessionHash, []);
    if (!sessionStates.has(input.sessionHash)) sessionStates.set(input.sessionHash, { compactEpoch: 0, humanSeen: 0, progress: { humanOrdinal: 0, transcriptOffset: 0, transcriptIdentity: "" }, lastAvailableMs: 0 });
  }
  for (const session of sessions) session.humanInputs.sort((a, b) => a.lineOrder - b.lineOrder);
  const originalTimeline = [];
  for (const session of sessions) {
    const sessionRows = [];
    for (const row of session.timeline) {
      if (row.kind === "human") sessionRows.push(row);
      else if (["start", "stop", "compact"].includes(row.kind)) sessionRows.push(row);
    }
    const assistantRows = session.transcriptRecords
      .filter((record) => ["assistant", "tool_use", "tool_result"].includes(record.entry.type) && record.entry.isSidechain !== true)
      .map((record) => ({
        kind: "assistant",
        lineOrder: record.lineOrder,
        byteOffset: record.byteOffset,
        byteEndOffset: record.byteEndOffset,
        availableMs: numericTime(record.entry.timestamp) ?? session.startMs ?? PERIOD_START_MS,
        sessionHash: session.sessionHash,
        sessionId: session.sessionId,
      }));
    sessionRows.push(...assistantRows);
    sessionRows.sort((left, right) => left.lineOrder - right.lineOrder);
    const lastHuman = session.humanInputs.at(-1);
    const lastRecordedStop = session.timeline.filter((entry) => entry.kind === "stop")
      .reduce((latest, entry) => Math.max(latest, entry.lineOrder), -1);
    if (lastHuman && lastHuman.lineOrder > lastRecordedStop) {
      const lastRow = sessionRows.at(-1);
      sessionRows.push({
        kind: "stop",
        lineOrder: Math.max(lastRow?.lineOrder ?? 0, lastHuman.lineOrder) + 1,
        byteOffset: session.snapshotMeta.size,
        byteEndOffset: session.snapshotMeta.size,
        availableMs: lastRow?.availableMs ?? lastHuman.availableMs ?? PERIOD_START_MS,
        sessionHash: session.sessionHash,
        sessionId: session.sessionId,
        synthetic: true,
      });
    }
    const firstHumanOrder = session.humanInputs[0]?.lineOrder ?? Number.POSITIVE_INFINITY;
    const hasInitialStart = sessionRows.some((entry) => entry.kind === "start" && entry.lineOrder < firstHumanOrder);
    if (coverage === "contract" && !hasInitialStart) {
      sessionRows.push({
        kind: "start",
        source: "startup",
        observed: false,
        lineOrder: -1,
        byteOffset: 0,
        byteEndOffset: 0,
        availableMs: session.startMs ?? session.firstHumanMs ?? PERIOD_START_MS,
        sessionHash: session.sessionHash,
        sessionId: session.sessionId,
      });
    }
    sessionRows.sort((left, right) => left.lineOrder - right.lineOrder);
    let last = -Infinity;
    for (const row of sessionRows) {
      if (!Number.isFinite(row.availableMs)) row.availableMs = last === -Infinity ? PERIOD_START_MS : last;
      row.availableMs = Math.max(last, row.availableMs);
      last = row.availableMs;
      row.sessionHash = session.sessionHash;
      row.sessionId = session.sessionId;
      if (row.kind === "human") row.input.availableMs = row.availableMs;
      originalTimeline.push(row);
    }
    bySession.set(session.sessionHash, sessionRows);
  }
  originalTimeline.sort(compareAvailable);
  originalTimeline.forEach((row, index) => {
    row.globalOrder = index + 1;
    row.availableAt = Number.isFinite(row.availableMs) ? new Date(row.availableMs).toISOString() : null;
    if (row.kind === "human") {
      row.input.globalOrder = index + 1;
      row.input.availableMs = row.availableMs;
      row.input.availableAt = row.availableAt;
    }
    if (row.kind !== "human") return;
  });
  const targetRows = createReplayOccurrenceRows(originalTimeline);
  const targetMap = new Map(targetRows.map((entry) => [`${entry.eventId}:${entry.bundleLabel}`, entry]));

  const pendingCandidatesByEvent = new Map();
  const runStartOutput = (session, state, at, observed, source, sourceRow) => {
    if (coverage === "observed" && !observed) {
      session.startHookObservations.push({
        globalOrder: sourceRow.globalOrder,
        compactEpoch: state.compactEpoch,
        at,
        source,
        observed: false,
        invoked: false,
        candidateCount: null,
        selectedCount: 0,
        successfulOutputCount: 0,
      });
      return;
    }
    const input = { hook_event_name: "SessionStart", session_id: session.sessionId, source };
    const budget = runtime.budget.DEFAULT_INJECTION_TOKEN_BUDGET;
    const plan = runtime.context.getContextInjectionPlan(input, state.humanSeen, budget);
    const selection = runtime.policy.selectCorrectionInjections(storage, {
      project: SOURCE_PROJECT,
      scope: SOURCE_SCOPE,
      query: "",
      at,
      sessionIdHash: runtime.sessionStore.hashSessionId(session.sessionId),
      compactEpoch: state.compactEpoch,
      humanOrdinal: state.humanSeen,
      trigger: plan.requestTrigger,
    });
    const initial = runtime.render.renderCorrectionRules({ trigger: plan.renderTrigger, rules: selection.rules, budgetTokens: plan.budgetTokens });
    const rendered = runtime.render.finalizeCorrectionRender(initial, initial.text);
    addOutputLedger(storage, runtime.sessionStore.hashSessionId(session.sessionId), state.compactEpoch, state.humanSeen, plan.ledgerTrigger, at, rendered);
    const output = summarizeOutputs(rendered, selection, runtime.budget.estimateTokens);
    session.startHookObservations.push({
      globalOrder: sourceRow.globalOrder,
      compactEpoch: state.compactEpoch,
      at,
      source,
      observed: observed === true,
      invoked: true,
      candidateCount: selection.ftsCandidateCount + selection.alwaysOnCount,
      selectedCount: selection.rules.length,
      successfulOutputCount: rendered.ledger.filter((entry) => entry.bodyIncluded).length,
      budgetOmittedCount: rendered.omittedBundleKeys.length,
    });
    const emittedKeys = new Set(rendered.ledger.filter((entry) => entry.bodyIncluded)
      .map((entry) => entry.bundleKey + ":" + entry.version));
    for (const rule of selection.rules) {
      session.deliveryAttempts.push({
        bundleKey: rule.bundleKey,
        version: rule.version,
        compactEpoch: state.compactEpoch,
        globalOrder: sourceRow.globalOrder,
        trigger: "start",
        selected: true,
        emitted: emittedKeys.has(rule.bundleKey + ":" + rule.version),
        reason: rendered.omittedBundleKeys.includes(rule.bundleKey) ? "token_budget" : null,
      });
    }
    for (const rule of selection.unreached) {
      session.deliveryAttempts.push({
        bundleKey: rule.bundleKey,
        version: rule.version,
        compactEpoch: state.compactEpoch,
        globalOrder: sourceRow.globalOrder,
        trigger: "start",
        selected: false,
        emitted: false,
        reason: rule.reason === "item_limit" ? "item_limit" : rule.reason,
      });
    }
    const nextHuman = (bySession.get(session.sessionHash) ?? [])
      .find((entry) => entry.kind === "human" && entry.globalOrder > sourceRow.globalOrder);
    if (nextHuman) {
      const previous = startOutputs.get(nextHuman.input.eventId) ?? { tokens: 0, relatedTokens: 0, reinjectionTokens: 0 };
      startOutputs.set(nextHuman.input.eventId, {
        tokens: previous.tokens + output.tokens,
        relatedTokens: previous.relatedTokens + output.relatedTokens,
        reinjectionTokens: previous.reinjectionTokens + output.reinjectionTokens,
      });
    }
    for (const rule of rendered.includedRules) {
      const version = outputSnapshot(storage, rule.bundleKey, rule.version, []);
      if (!version) continue;
      const evidenceSources = queryEvidenceSources(storage, rule.bundleKey);
      for (const source of evidenceSources) {
        const sourceInput = allInputs.find((entry) => entry.eventId === source.eventId);
        if (!sourceInput) continue;
        const sourceLabels = sourceInput.labels;
        const emission = {
          sourceEventId: source.eventId,
          bundleKey: rule.bundleKey,
          version: rule.version,
          sessionId: session.sessionId,
          sessionHash: session.sessionHash,
          compactEpoch: state.compactEpoch,
          trigger: plan.ledgerTrigger,
          humanOrdinal: state.humanSeen,
          emittedAt: at,
          order: sourceRow.globalOrder,
          bodyText: rendered.text,
          ruleText: rule.ruleText,
          bodyIncluded: rendered.ledger.some((entry) => entry.bundleKey === rule.bundleKey && entry.bodyIncluded),
          stdoutStatus: "emitted",
          versionStatus: version.status,
          expiresAt: version.expiresAt,
          evidenceEventIds: version.evidenceEventIds,
          bundleLabels: sourceLabels,
        };
        const inputRow = allInputs.find((entry) => entry.sessionHash === session.sessionHash && entry.eventId === source.eventId) ?? allInputs.find((entry) => entry.eventId === source.eventId);
        if (inputRow) inputRow.emissions.push(emission);
      }
    }
  };

  for (const row of originalTimeline) {
    const session = sessions.find((entry) => entry.sessionHash === row.sessionHash);
    const state = sessionStates.get(row.sessionHash);
    const at = row.availableAt ?? new Date(row.availableMs).toISOString();
    if (row.kind === "start") {
      if (row.source === "resume" || row.source === "clear" || row.source === "compact") state.startHandled = false;
      if (!state.startHandled) {
        if (row.source === "compact" && !state.compactPending) state.compactEpoch += 1;
        if (row.source === "resume" || row.source === "clear") state.compactEpoch += 1;
        runStartOutput(session, state, at, row.observed, row.source, row);
        state.startHandled = true;
      }
      if (row.source === "compact") state.compactPending = false;
      continue;
    }
    if (row.kind === "compact") {
      state.compactEpoch += 1;
      state.compactPending = true;
      if (coverage === "contract") {
        state.startHandled = false;
        const nextHuman = session.humanInputs.find((input) => input.lineOrder > row.lineOrder);
        const hasRecordedCompactStart = session.timeline.some((entry) => entry.kind === "start" && entry.source === "compact" &&
          entry.lineOrder > row.lineOrder && (!nextHuman || entry.lineOrder < nextHuman.lineOrder));
        if (!hasRecordedCompactStart) {
          runStartOutput(session, state, at, true, "compact", row);
          state.startHandled = true;
        }
      } else {
        state.startHandled = false;
      }
      continue;
    }
    if (row.kind === "human") {
      const input = row.input;
      state.humanSeen += 1;
      input.humanOrdinal = state.humanSeen;
      input.compactEpoch = state.compactEpoch;
      input.at = at;
      for (const label of input.labels) {
        const occurrence = targetMap.get(`${input.eventId}:${label}`);
        if (!occurrence) continue;
        occurrence.compactEpoch = state.compactEpoch;
        occurrence.humanOrdinal = state.humanSeen;
        occurrence.sessionId = input.sessionId;
        occurrence.sessionHash = input.sessionHash;
      }
      const hooked = coverage === "contract" || input.observedUserHook;
      input.hookReached = hooked;
      input.hookMetrics = {
        observed: input.observedUserHook === true,
        invoked: hooked,
        candidateCount: 0,
        relatedCandidateCount: 0,
        selectedCount: 0,
        successfulOutputCount: 0,
        budgetOmittedCount: 0,
      };
      let selection = { rules: [], unreached: [], alwaysOnCount: 0, ftsCandidateCount: 0 };
      let rendered = runtime.render.renderCorrectionRules({ trigger: "prompt", rules: [], budgetTokens: 0 });
      let candidates = [];
      let plan = null;
      if (hooked) {
        const hookInput = { hook_event_name: "UserPromptSubmit", session_id: input.sessionId, prompt: input.text };
        plan = runtime.context.getContextInjectionPlan(hookInput, input.humanOrdinal, runtime.budget.DEFAULT_INJECTION_TOKEN_BUDGET);
        selection = runtime.policy.selectCorrectionInjections(storage, {
          project: SOURCE_PROJECT,
          scope: SOURCE_SCOPE,
          query: input.text,
          at,
          sessionIdHash: runtime.sessionStore.hashSessionId(input.sessionId),
          compactEpoch: state.compactEpoch,
          humanOrdinal: input.humanOrdinal,
          trigger: plan.requestTrigger,
        });
        rendered = runtime.render.finalizeCorrectionRender(
          runtime.render.renderCorrectionRules({ trigger: plan.renderTrigger, rules: selection.rules, budgetTokens: plan.budgetTokens }),
          runtime.render.renderCorrectionRules({ trigger: plan.renderTrigger, rules: selection.rules, budgetTokens: plan.budgetTokens }).text,
        );
        input.hookMetrics = {
          observed: input.observedUserHook === true,
          invoked: true,
          candidateCount: selection.ftsCandidateCount + selection.alwaysOnCount,
          relatedCandidateCount: selection.ftsCandidateCount,
          selectedCount: selection.rules.length,
          successfulOutputCount: rendered.ledger.filter((entry) => entry.bodyIncluded).length,
          budgetOmittedCount: rendered.omittedBundleKeys.length,
        };
        const emittedKeys = new Set(rendered.ledger.filter((entry) => entry.bodyIncluded)
          .map((entry) => entry.bundleKey + ":" + entry.version));
        for (const rule of selection.rules) {
          session.deliveryAttempts.push({
            bundleKey: rule.bundleKey,
            version: rule.version,
            compactEpoch: state.compactEpoch,
            globalOrder: row.globalOrder,
            humanOrdinal: input.humanOrdinal,
            trigger: plan.requestTrigger,
            selected: true,
            emitted: emittedKeys.has(rule.bundleKey + ":" + rule.version),
            reason: rendered.omittedBundleKeys.includes(rule.bundleKey) ? "token_budget" : null,
          });
        }
        for (const rule of selection.unreached) {
          session.deliveryAttempts.push({
            bundleKey: rule.bundleKey,
            version: rule.version,
            compactEpoch: state.compactEpoch,
            globalOrder: row.globalOrder,
            humanOrdinal: input.humanOrdinal,
            trigger: plan.requestTrigger,
            selected: false,
            emitted: false,
            reason: rule.reason,
          });
        }
        const output = summarizeOutputs(rendered, selection, runtime.budget.estimateTokens);
        promptOutputs.set(input.eventId, output);
        for (const rule of rendered.includedRules) {
          const version = outputSnapshot(storage, rule.bundleKey, rule.version, []);
          if (!version) continue;
          const evidenceSources = queryEvidenceSources(storage, rule.bundleKey);
          for (const source of evidenceSources) {
            const sourceInput = allInputs.find((entry) => entry.eventId === source.eventId);
            if (!sourceInput) continue;
            input.emissions.push({
              sourceEventId: source.eventId,
              bundleKey: rule.bundleKey,
              version: rule.version,
              sessionId: input.sessionId,
              sessionHash: input.sessionHash,
              compactEpoch: state.compactEpoch,
              trigger: plan.ledgerTrigger,
              humanOrdinal: input.humanOrdinal,
              emittedAt: at,
              order: row.globalOrder,
              bodyText: rendered.text,
              ruleText: rule.ruleText,
              bodyIncluded: rendered.ledger.some((entry) => entry.bundleKey === rule.bundleKey && entry.bodyIncluded),
              stdoutStatus: "emitted",
              versionStatus: version.status,
              expiresAt: version.expiresAt,
              evidenceEventIds: version.evidenceEventIds,
              bundleLabels: sourceInput.labels,
            });
          }
        }
        addOutputLedger(storage, runtime.sessionStore.hashSessionId(input.sessionId), state.compactEpoch, input.humanOrdinal, plan.ledgerTrigger, at, rendered);
        candidates = runtime.context.detectPendingCorrectionCandidates(input.text);
        const receiptId = runtime.context.addUserPromptPendingReceipt(
          storage,
          runtime.sessionStore.hashSessionId(input.sessionId),
          input.sessionId,
          input.uuid,
          state.progress.humanOrdinal,
          input.text,
          at,
          rendered.ledger.length > 0,
        );
        if (receiptId) pendingCandidatesByEvent.set(input.eventId, candidates);
        if (candidates.length > 0) {
          input.detections = candidates.map((candidate) => ({
            eventId: input.eventId,
            bundleKey: candidate.bundleKey,
            status: candidate.status,
            score: candidate.score,
            topic: candidate.topicKey,
            ruleText: candidate.ruleText,
            at,
            order: row.globalOrder,
          }));
        }
        for (const label of input.labels) {
          const relevantEmission = input.emissions.some((emission) => emission.bundleLabels.includes(label));
          if (!relevantEmission) {
            const hint = selectFailureHint(storage, selection, rendered, input, plan.requestTrigger, state.compactEpoch);
            input.emissionHints.push({
              eventId: input.eventId,
              bundleLabel: label,
              reason: hint,
              order: row.globalOrder,
              sessionId: input.sessionId,
              compactEpoch: state.compactEpoch,
              at,
            });
          }
        }
      } else {
        candidates = [];
      }
      pendingStopInputs.get(row.sessionHash).push({ input, hookCandidates: candidates, hasReceipt: pendingCandidatesByEvent.has(input.eventId) });
      continue;
    }
    if (row.kind === "assistant") {
      const nextHuman = session.humanInputs.find((input) => input.lineOrder > row.lineOrder);
      if (nextHuman && targetRows.some((entry) => entry.eventId === nextHuman.eventId)) {
        let actionSnapshots = snapshotsByEvent.get(nextHuman.eventId);
        if (!actionSnapshots) actionSnapshots = [];
        actionSnapshots.push({
          at: row.availableAt,
          order: row.globalOrder,
          compactEpoch: state.compactEpoch,
          ruleSnapshots: currentVersionSnapshots(storage),
        });
        snapshotsByEvent.set(nextHuman.eventId, actionSnapshots);
      }
      continue;
    }
    if (row.kind === "stop") {
      const toProcess = pendingStopInputs.get(row.sessionHash) ?? [];
      const progress = readCurrentSessionState(storage, runtime.sessionStore.hashSessionId(session.sessionId));
      const prior = {
        humanOrdinal: progress.humanOrdinal,
        transcriptOffset: progress.transcriptOffset,
        transcriptIdentity: progress.transcriptIdentity,
      };
      if (toProcess.length > 0) {
        const items = toProcess.map(({ input, hasReceipt, hookCandidates }) => {
          const context = assistantContextFor(input, runtime);
          const candidates = hasReceipt ? hookCandidates : runtime.detector.detectOwnerCorrections(runtime.events.extractOwnerEvent(input.event), context);
          return { input, context, candidates };
        });
        const eventItems = items.map(({ input, context }) => makeSessionEvent(input, context, runtime, at));
        const nextIdentity = nextCursorIdentity(session.snapshotMeta, session.snapshot, row.byteEndOffset);
        let commitResult;
        const candidatesByEvent = new Map(items.map((item) => [item.input.eventId, item.candidates]));
        for (const { input, candidates } of items) {
          input.detections = candidates.map((candidate) => ({
            eventId: input.eventId,
            bundleKey: candidate.bundleKey,
            status: candidate.status,
            score: candidate.score,
            topic: candidate.topicKey,
            ruleText: candidate.ruleText,
            at: input.availableAt,
            order: input.globalOrder,
          }));
        }
        try {
          storage.runCorrectionTransaction(({ db, save }) => {
          commitResult = runtime.sessionStore.commitTranscriptBatch(db, {
            sessionIdHash: runtime.sessionStore.hashSessionId(session.sessionId),
            expected: prior,
            nextCursor: { transcriptOffset: row.byteEndOffset, transcriptIdentity: nextIdentity },
            lastSeenAt: at,
            events: eventItems,
          });
          if (!commitResult.committed) throw new Error("Stop replay cursor conflict");
          for (const match of commitResult.matchedReceipts) {
            const pending = db.prepare(`SELECT extracted_candidates FROM owner_correction_pending WHERE receipt_id = ? AND matched_event_id = ?`).get(match.receiptId, match.eventId);
            if (!pending) throw new Error("Stop replay lost a pending receipt");
            candidatesByEvent.set(match.eventId, JSON.parse(pending.extracted_candidates));
          }
          for (const { input } of items) {
            const candidates = candidatesByEvent.get(input.eventId) ?? [];
            for (const candidate of candidates) {
              runtime.correctionStore.applyCorrectionEvidence({ db, save }, {
                eventId: input.eventId,
                at: input.availableAt ?? at,
                bundleKey: candidate.bundleKey,
                ruleText: candidate.ruleText,
                topicKey: candidate.topicKey,
                polarity: candidate.polarity,
                conditionKey: candidate.conditionKey,
                visibility: candidateVisibility(candidate),
                decision: candidate.status === "confirmed" ? "confirmed" : "candidate",
                lifetimeKind: candidate.lifetimeKind,
                continuationBasis: candidateContinuation(candidate),
                ...(candidate.lifetimeKind === "task" ? { sessionEndsAt: at } : {}),
                evidence: {
                  source: candidate.source,
                  score: candidate.score,
                  detectorVersion: DETECTOR_VERSION,
                  conditions: confidenceConditions(candidate, runtime.ruleTemplate),
                  polarity: candidate.polarity,
                },
              });
            }
            const rows = db.prepare(`
              SELECT e.bundle_key AS bundleKey, b.version, b.status, b.expires_at AS expiresAt, v.evidence_event_ids AS evidenceEventIds
              FROM owner_correction_evidence e JOIN owner_correction_bundles b ON b.bundle_key = e.bundle_key
              JOIN owner_correction_versions v ON v.bundle_key = b.bundle_key AND v.version = b.version
              WHERE e.event_id = ?
            `).all(input.eventId);
            input.detections = candidates.map((candidate) => ({
              eventId: input.eventId,
              bundleKey: candidate.bundleKey,
              status: candidate.status,
              score: candidate.score,
              topic: candidate.topicKey,
              ruleText: candidate.ruleText,
              at: input.availableAt,
              order: input.globalOrder,
            }));
            input.saves = rows.map((row) => ({
              eventId: input.eventId,
              sessionId: input.sessionId,
              sessionHash: input.sessionHash,
              bundleKey: row.bundleKey,
              version: row.version,
              status: row.status,
              savedAt: at,
              order: row.globalOrder,
              expiresAt: row.expiresAt,
              evidenceEventIds: JSON.parse(row.evidenceEventIds),
            }));
          }
          });
          state.progress = {
            humanOrdinal: commitResult.humanOrdinal,
            transcriptOffset: row.byteEndOffset,
            transcriptIdentity: nextIdentity,
          };
          pendingStopInputs.set(row.sessionHash, []);
        } catch (error) {
          for (const { input } of items) input.saves = [];
          const message = error instanceof Error ? error.message : String(error);
          stopFailures.push({
            message,
            sourceFileId: session.sourceFileId,
            lineOrder: row.lineOrder,
            previousOffset: progress.transcriptOffset,
            requestedOffset: row.byteEndOffset,
          });
        }
      }
    }
  }

  const actionSnapshotsByInput = new Map();
  for (const occurrence of targetRows) {
    const input = occurrence.input;
    occurrence.actionStartAt ??= null;
    occurrence.sessionId = input.sessionId;
    occurrence.sessionHash = input.sessionHash;
    occurrence.humanOrdinal ??= input.humanOrdinal ?? 0;
    occurrence.compactEpoch ??= input.compactEpoch ?? 0;
    occurrence.order = input.globalOrder ?? 0;
    actionSnapshotsByInput.set(input.eventId, snapshotsByEvent.get(input.eventId) ?? []);
  }
  const resultRows = groupedRows(targetRows, coverage, allInputs, sessions, runtime, actionSnapshotsByInput);
  const legacyRows = groupedRows(targetRows, coverage, allInputs, sessions, runtime, actionSnapshotsByInput, true);
  const stats = computeOutputStats(allInputs, startOutputs, promptOutputs);
  const counts = summarizePrevention(resultRows);
  const mainRows = resultRows.filter((row) => /^B(?:[2-9]|10)$/u.test(row.bundleLabel));
  const b1Rows = resultRows.filter((row) => row.bundleLabel === "B1");
  const diagnostics = preventionDiagnostics(mainRows);
  const b1Diagnostics = preventionDiagnostics(b1Rows);
  const legacyCounts = summarizePrevention(legacyRows);
  const legacyMainRows = legacyRows.filter((row) => /^B(?:[2-9]|10)$/u.test(row.bundleLabel));
  const legacyB1Rows = legacyRows.filter((row) => row.bundleLabel === "B1");
  const confirmedCounts = { ...counts };
  const allDetections = allInputs.flatMap((input) => input.detections);
  const audit = buildAuditRows(allInputs, runtime.events, runtime.redact);
  const hookObservations = summarizeHookObservations(sessions, allInputs);
  const report = {
    split,
    coverage,
    sampleSeed: SAMPLE_SEED,
    detectorVersion: DETECTOR_VERSION,
    sourceProject: SOURCE_PROJECT,
    sourceScope: SOURCE_SCOPE,
    population: {
      sessionCount: sessions.length,
      humanUtteranceCount: allInputs.length,
      periodHumanUtteranceCount: allInputs.filter((input) => input.dateJst >= DATE_START && input.dateJst <= DATE_END).length,
      recurrenceCountB2ToB10: counts.main.recurrenceCount,
      recurrenceCountB1: counts.b1.recurrenceCount,
    },
    prevention: {
      ...confirmedCounts,
      perTheme: perTheme(resultRows),
      diagnostics,
      b1Diagnostics,
      failureSentence: classifyFailureReason(mainRows),
      legacyComparison: {
        status: "title_only_projection",
        sameAdjudicator: true,
        assumption: "旧題名出力は規則本文なしとして同じ行動前判定器へ入力",
        main: legacyCounts.main,
        b1: legacyCounts.b1,
        diagnostics: preventionDiagnostics(legacyMainRows),
        b1Diagnostics: preventionDiagnostics(legacyB1Rows),
      },
      uniqueRecurrences: {
        all: uniqueOccurrenceCount(resultRows),
        b1: uniqueOccurrenceCount(resultRows.filter((row) => row.bundleLabel === "B1")),
        b2ToB10: uniqueOccurrenceCount(resultRows.filter((row) => row.bundleLabel !== "B1")),
      },
    },
    tokens: stats,
    hookObservations,
    auditSamples: audit.groups,
    auditSampleCounts: audit.groups,
    detectorOutputCounts: {
      confirmedUtterances: new Set(allInputs.filter((input) => input.detections.some((entry) => entry.status === "confirmed")).map((input) => input.eventId)).size,
      candidateUtterances: new Set(allInputs.filter((input) => input.detections.some((entry) => entry.status === "candidate" && !input.detections.some((candidate) => candidate.status === "confirmed"))).map((input) => input.eventId)).size,
      negativeThemeUtterances: new Set(allInputs.filter((input) => input.labels.length > 0 && input.detections.length === 0).map((input) => input.eventId)).size,
      totalDetections: allDetections.length,
    },
    replayErrors: {
      stopPersistenceFailureCount: stopFailures.length,
      stopPersistenceFailureSampleCount: stopFailures.length,
    },
  };
  storage.close();
  return { report, auditRows: audit.rows, auditGroups: audit.groups };
}

async function runHookTimings({ sessions, compiledRoot, scratchRoot }) {
  const root = join(resolve(scratchRoot), "hook-timing");
  await mkdir(root, { recursive: true });
  const runtime = await initializeBlankStore(compiledRoot, root);
  runtime.storage.close();
  const starts = sessions.map((session) => ({ session, row: session.timeline.find((event) => event.kind === "start") ?? null }));
  const users = sessions.flatMap((session) => session.humanInputs.map((input) => ({ session, input })));
  const stops = sessions.map((session) => ({ session, row: session.timeline.find((event) => event.kind === "stop") ?? null }));
  if (starts.length === 0 || users.length === 0 || stops.length === 0) {
    throw new Error("hook timing fixture must include a start, human input, and stop sample");
  }
  const startCount = 67;
  const userCount = 67;
  const stopCount = 66;
  const cases = [
    ...fixedSample(starts, startCount)
      .map((entry) => ({ kind: "SessionStart", entry })),
    ...fixedSample(users, userCount).map((entry) => ({ kind: "UserPromptSubmit", entry })),
    ...fixedSample(stops, stopCount).map((entry) => ({ kind: "Stop", entry })),
  ].slice(0, 200);
  if (cases.length !== 200) throw new Error(`hook timing requires 200 replay samples, found ${cases.length}`);
  const durations = { SessionStart: [], UserPromptSubmit: [], Stop: [] };
  let failures = 0;
  let timedOut = 0;
  const binPath = (name) => join(compiledRoot, "cli", name);
  const safeEnv = {
    PATH: process.env.PATH ?? "",
    HOME: join(root, "home"),
    TMPDIR: process.env.TMPDIR ?? join(root, "tmp"),
    MEMORY_DIR: resolve(root),
    WASURENAGUSA_CORRECTION_LOOP: "on",
    WASURENAGUSA_CORRECTION_INJECT: "on",
    WASURENAGUSA_STOP_LLM: "off",
    WASURENAGUSA_SCHEDULER: "0",
  };
  await mkdir(safeEnv.HOME, { recursive: true });
  await mkdir(safeEnv.TMPDIR, { recursive: true });

  for (const item of cases) {
    resetStore(root, compiledRoot);
    const { session } = item.entry;
    let command;
    let input;
    if (item.kind === "SessionStart") {
      command = binPath("context.js");
      input = {
        session_id: session.sessionId,
        cwd: ROOT,
        hook_event_name: "SessionStart",
        source: item.entry.row?.source ?? "startup",
      };
    } else if (item.kind === "UserPromptSubmit") {
      command = binPath("context.js");
      input = {
        session_id: item.entry.input.sessionId,
        cwd: ROOT,
        hook_event_name: "UserPromptSubmit",
        prompt: item.entry.input.text,
        uuid: item.entry.input.uuid,
      };
    } else {
      command = binPath("analyze.js");
      input = {
        session_id: session.sessionId,
        transcript_path: session.sourcePath,
        cwd: ROOT,
        hook_event_name: "Stop",
      };
    }
    const startedAt = process.hrtime.bigint();
    const result = spawnSync(process.execPath, [command], {
      cwd: ROOT,
      env: safeEnv,
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    const elapsed = Number(process.hrtime.bigint() - startedAt) / 1e6;
    durations[item.kind].push(elapsed);
    if (result.error || result.status !== 0) failures += 1;
    if (result.error?.code === "ETIMEDOUT" || elapsed > 4000) timedOut += 1;
  }
  return {
    sampleCount: cases.length,
    selection: "各hook種別からevent順に等間隔抽出。各caseを新規node processで起動。",
    byHook: Object.fromEntries(Object.entries(durations).map(([key, values]) => [key, summarizeDurations(values)])),
    failedProcessCount: failures,
    over4000MsProcessCount: timedOut,
    over5000MsProcessCount: durations.SessionStart.concat(durations.UserPromptSubmit, durations.Stop).filter((value) => value > 5000).length,
    intentionalTimeoutTest: { status: "not_run" },
  };
}

function pathContains(parent, child) {
  const childPath = relative(resolve(parent), resolve(child));
  return childPath === "" || (childPath !== ".." && !childPath.startsWith(".." + sep) && !isAbsolute(childPath));
}

async function hashCompiledTree(root) {
  const rows = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const filename = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("compiled root cannot contain symlinks");
      if (entry.isDirectory()) {
        await visit(filename);
        continue;
      }
      const key = relative(root, filename).split(sep).join("/");
      if (entry.name === ".env" || key.endsWith("/.env")) throw new Error("compiled root cannot contain .env files");
      rows.push([key, sha256(await readFile(filename))]);
    }
  }
  await visit(root);
  if (rows.length === 0) throw new Error("compiled root is empty");
  return sha256(JSON.stringify(rows));
}

async function computeReplayHashes(manifest, split, compiledRoot) {
  const sourceFiles = manifest.sessions
    .map((session) => [session.sessionHash, session.snapshotMeta.prefixHash, session.snapshotMeta.size])
    .sort((left, right) => left[0].localeCompare(right[0]));
  return {
    manifestHash: manifest.manifestHash,
    sourceHash: sha256(JSON.stringify(sourceFiles)),
    compiledHash: await hashCompiledTree(compiledRoot),
    splitHash: sha256(JSON.stringify({ seed: SAMPLE_SEED, tune: split.tune.map((entry) => entry.sessionHash), evaluation: split.evaluation.map((entry) => entry.sessionHash) })),
    auditPromptHash: sha256(AUDIT_PROMPT),
  };
}

function isExpectedReplaySplit(sessions, split) {
  return sessions.length === 98 && split.tune.length === 68 && split.evaluation.length === 30;
}

function reportPopulation(manifest) {
  return {
    fileCount: manifest.fileAudit.fileCount,
    includedSessionCount: manifest.fileAudit.included,
    excludedCount: manifest.fileAudit.excluded,
    noHumanCount: manifest.fileAudit.noHuman,
    outsidePeriodCount: manifest.fileAudit.outsidePeriod,
    periodSessionCount: manifest.sessions.length,
    periodHumanUtteranceCount: manifest.sessions.reduce((sum, session) =>
      sum + session.humanInputs.filter((input) => input.dateJst >= DATE_START && input.dateJst <= DATE_END).length, 0),
  };
}

async function writeAuditPrompts(scratchRoot, splitName, auditRows) {
  const outputDirectory = join(scratchRoot, "audit-prompts");
  await mkdir(outputDirectory, { recursive: true });
  const shuffled = deterministicSample(auditRows, auditRows.length, SAMPLE_SEED + 97);
  const rows = shuffled.map((row) => JSON.stringify({
    id: row.id,
    prompt: AUDIT_PROMPT,
    human_utterance: row.human_utterance,
    previous_assistant_interval: row.previous_assistant_interval,
    proposed_rules: row.proposed_rules,
  }));
  await writeFile(join(outputDirectory, `${splitName}.jsonl`), rows.join("\n") + (rows.length > 0 ? "\n" : ""), "utf8");
}

async function runColdSplit({ splitName, split, compiledRoot, scratchRoot, hashes, auditArgs }) {
  const coverageRuns = [];
  for (const coverage of ["observed", "contract"]) {
    coverageRuns.push(await runCoverage({
      split: splitName,
      coverage,
      sessions: split,
      compiledRoot,
      scratchRoot,
    }));
  }
  const auditRows = coverageRuns[0].auditRows;
  await writeAuditPrompts(scratchRoot, splitName, auditRows);
  const audit = await loadAuditResults(auditArgs, auditRows);
  return {
    split: splitName,
    sessionCount: split.length,
    hashes,
    population: {
      sessionCount: split.length,
      humanUtteranceCount: split.reduce((sum, session) => sum + session.humanInputs.length, 0),
      recurrenceCountByLabel: Object.fromEntries(["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10"].map((label) => [
        label,
        coverageRuns[0].report.prevention.perTheme[label].recurrenceCount,
      ])),
    },
    coverages: coverageRuns.map((entry) => entry.report),
    auditSampleCounts: coverageRuns[0].auditGroups,
    audit,
  };
}

function flattenNumericMetrics(value, prefix = "", output = {}) {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    if (prefix) output[prefix] = value;
    return output;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return output;
  for (const [key, entry] of Object.entries(value)) {
    if (["split", "coverage", "sampleSeed", "detectorVersion", "sourceProject", "sourceScope", "failureSentence", "auditSampleCounts", "round0TuneComparison"].includes(key)) continue;
    flattenNumericMetrics(entry, prefix ? `${prefix}.${key}` : key, output);
  }
  return output;
}

function formatMetric(value, pending = false) {
  if (pending) return "未実行";
  if (value === null || value === undefined) return "未算出";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/u, "").replace(/\.$/u, "");
  return String(value);
}

const BUNDLE_LABELS = Array.from({ length: 10 }, (_, index) => `B${index + 1}`);

function summarizeRound0Rows(rows) {
  const summaryFor = (selected) => {
    const preventedCount = selected.filter((row) => row.prevented).length;
    const recurrenceCount = selected.length;
    return { preventedCount, recurrenceCount, rate: recurrenceCount === 0 ? null : preventedCount / recurrenceCount };
  };
  const perTheme = Object.fromEntries(BUNDLE_LABELS.map((label) => [label, summaryFor(rows.filter((row) => row.bundleLabel === label))]));
  const mainRows = rows.filter((row) => /^B(?:[2-9]|10)$/u.test(row.bundleLabel));
  return {
    main: summaryFor(mainRows),
    b1: summaryFor(rows.filter((row) => row.bundleLabel === "B1")),
    perTheme,
  };
}

export function summarizeRound0SessionRows(rows, tuneSessionHashes) {
  const tuneHashes = new Set(tuneSessionHashes);
  return Object.fromEntries(["observed", "contract"].map((coverage) => {
    const coverageRows = rows.filter((row) => row.coverage === coverage);
    return [coverage, {
      all98: summarizeRound0Rows(coverageRows),
      tune: summarizeRound0Rows(coverageRows.filter((row) => tuneHashes.has(row.sessionHash))),
    }];
  }));
}

function matchesRound0Report(actual, expected) {
  if (actual.main.preventedCount !== expected.main.preventedCount || actual.main.recurrenceCount !== expected.main.recurrenceCount) return false;
  if (actual.b1.preventedCount !== expected.b1.preventedCount || actual.b1.recurrenceCount !== expected.b1.recurrenceCount) return false;
  return BUNDLE_LABELS.every((label) => actual.perTheme[label].preventedCount === expected.perTheme[label].preventedCount &&
    actual.perTheme[label].recurrenceCount === expected.perTheme[label].recurrenceCount);
}

export function summarizeRound0TuneComparison(baselineReport, tuneSessionCount, sessionRows = null, tuneSessionHashes = []) {
  if (!Array.isArray(baselineReport.coverageRuns) || baselineReport.coverageRuns.length === 0) {
    throw new Error("round 0 report is missing coverage aggregates");
  }
  if (!Number.isSafeInteger(tuneSessionCount) || tuneSessionCount < 0) {
    throw new Error("tune session count must be a non-negative safe integer");
  }
  const fullPopulationSessionCount = baselineReport.coverageRuns[0].population?.sessionCount;
  const all98 = baselineReport.coverageRuns.map((run) => {
    if (run.population?.sessionCount !== fullPopulationSessionCount || !run.prevention?.main || !run.prevention?.b1 || !run.prevention?.perTheme) {
      throw new Error("round 0 coverage aggregates do not share one population");
    }
    const perTheme = Object.fromEntries(BUNDLE_LABELS.map((label) => {
      const summary = run.prevention.perTheme[label];
      if (!summary || !Number.isSafeInteger(summary.preventedCount) || !Number.isSafeInteger(summary.recurrenceCount)) {
        throw new Error(`round 0 aggregate is missing ${label}`);
      }
      return [label, {
        preventedCount: summary.preventedCount,
        recurrenceCount: summary.recurrenceCount,
        rate: summary.rate,
      }];
    }));
    return {
      coverage: run.coverage,
      main: {
        preventedCount: run.prevention.main.preventedCount,
        recurrenceCount: run.prevention.main.recurrenceCount,
        rate: run.prevention.main.rate,
      },
      b1: {
        preventedCount: run.prevention.b1.preventedCount,
        recurrenceCount: run.prevention.b1.recurrenceCount,
        rate: run.prevention.b1.rate,
      },
      perTheme,
    };
  });
  const unavailable = {
    sessionCount: tuneSessionCount,
    status: "unavailable_from_aggregate_only_report",
    reason: "Round 0 session-level replay rows are unavailable",
  };
  if (sessionRows === null) {
    return { tune: unavailable, fullPopulationSessionCount, all98 };
  }
  const sliced = summarizeRound0SessionRows(sessionRows, tuneSessionHashes);
  const aggregateMatches = all98.every((run) => {
    const actual = sliced[run.coverage]?.all98;
    return actual && matchesRound0Report(actual, run);
  });
  if (!aggregateMatches) {
    return {
      tune: { ...unavailable, status: "unavailable_round0_rows_do_not_match_report", reason: "Round 0 replay rows do not match the published all-session aggregates" },
      fullPopulationSessionCount,
      all98,
    };
  }
  return {
    tune: {
      sessionCount: tuneSessionCount,
      status: "verified_from_round0_replay_store",
      perCoverage: Object.fromEntries(all98.map((run) => [run.coverage, sliced[run.coverage].tune])),
    },
    fullPopulationSessionCount,
    all98,
  };
}

function readRound0CoverageRows(sessions, coverage, databasePath) {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  let eventRows;
  let evidenceRows;
  let versions;
  let injections;
  try {
    eventRows = database.prepare("SELECT event_id AS eventId, session_id_hash AS sessionHash, human_ordinal AS humanOrdinal FROM owner_correction_events").all();
    evidenceRows = database.prepare("SELECT event_id AS eventId, bundle_key AS bundleKey FROM owner_correction_evidence").all();
    versions = database.prepare(`
      SELECT bundle_key AS bundleKey, version, rule_text AS ruleText, status,
        expires_at AS expiresAt, evidence_event_ids AS evidenceEventIds, effective_from AS effectiveFrom
      FROM owner_correction_versions ORDER BY effective_from, bundle_key, version
    `).all().map((row) => ({ ...row, evidenceEventIds: JSON.parse(row.evidenceEventIds) }));
    injections = database.prepare(`
      SELECT session_id_hash AS sessionHash, compact_epoch AS compactEpoch, bundle_key AS bundleKey,
        version, human_ordinal AS humanOrdinal, trigger, emitted_at AS emittedAt,
        body_included AS bodyIncluded, stdout_status AS stdoutStatus
      FROM owner_correction_injections
    `).all();
  } finally {
    database.close();
  }

  const eventByOrdinal = new Map(eventRows.map((row) => [`${row.sessionHash}:${row.humanOrdinal}`, row]));
  const eventSessionHashes = new Set(eventRows.map((row) => row.sessionHash));
  if (eventSessionHashes.size !== sessions.length || sessions.some((session) => !eventSessionHashes.has(session.sessionHash))) {
    throw new Error(`round 0 ${coverage} store does not match the 98-session manifest`);
  }
  const rowsBySession = new Map();
  const timeline = [];
  for (const session of sessions) {
    const sessionRows = session.timeline.filter((row) => ["human", "start", "stop", "compact"].includes(row.kind));
    const assistantRows = session.transcriptRecords
      .filter((record) => ["assistant", "tool_use", "tool_result"].includes(record.entry.type) && record.entry.isSidechain !== true)
      .map((record) => ({
        kind: "assistant",
        lineOrder: record.lineOrder,
        byteOffset: record.byteOffset,
        byteEndOffset: record.byteEndOffset,
        availableMs: numericTime(record.entry.timestamp) ?? session.startMs ?? PERIOD_START_MS,
        sessionHash: session.sessionHash,
        sessionId: session.sessionId,
      }));
    sessionRows.push(...assistantRows);
    const lastHuman = session.humanInputs.at(-1);
    const lastRecordedStop = session.timeline.filter((row) => row.kind === "stop")
      .reduce((latest, row) => Math.max(latest, row.lineOrder), -1);
    if (lastHuman && lastHuman.lineOrder > lastRecordedStop) {
      const lastRow = [...sessionRows].sort((left, right) => left.lineOrder - right.lineOrder).at(-1);
      sessionRows.push({
        kind: "stop",
        lineOrder: Math.max(lastRow?.lineOrder ?? 0, lastHuman.lineOrder) + 1,
        byteOffset: session.snapshotMeta.size,
        byteEndOffset: session.snapshotMeta.size,
        availableMs: lastRow?.availableMs ?? lastHuman.availableMs ?? PERIOD_START_MS,
        sessionHash: session.sessionHash,
        sessionId: session.sessionId,
        synthetic: true,
      });
    }
    const firstHumanOrder = session.humanInputs[0]?.lineOrder ?? Number.POSITIVE_INFINITY;
    const hasInitialStart = sessionRows.some((row) => row.kind === "start" && row.lineOrder < firstHumanOrder);
    if (coverage === "contract" && !hasInitialStart) {
      sessionRows.push({
        kind: "start",
        source: "startup",
        observed: false,
        lineOrder: -1,
        byteOffset: 0,
        byteEndOffset: 0,
        availableMs: session.startMs ?? session.firstHumanMs ?? PERIOD_START_MS,
        sessionHash: session.sessionHash,
        sessionId: session.sessionId,
      });
    }
    sessionRows.sort((left, right) => left.lineOrder - right.lineOrder);
    let last = -Infinity;
    let humanOrdinal = 0;
    for (const row of sessionRows) {
      if (!Number.isFinite(row.availableMs)) row.availableMs = last === -Infinity ? PERIOD_START_MS : last;
      row.availableMs = Math.max(last, row.availableMs);
      last = row.availableMs;
      row.sessionHash = session.sessionHash;
      row.sessionId = session.sessionId;
      if (row.kind !== "human") continue;
      humanOrdinal += 1;
      row.input.humanOrdinal = humanOrdinal;
      row.input.sessionHash = session.sessionHash;
      row.input.sessionId = session.sessionId;
      row.input.eventId = eventByOrdinal.get(`${session.sessionHash}:${humanOrdinal}`)?.eventId ?? `unmatched:${session.sessionHash}:${humanOrdinal}`;
    }
    rowsBySession.set(session.sessionHash, sessionRows);
    timeline.push(...sessionRows);
  }
  timeline.sort(compareAvailable);
  timeline.forEach((row, index) => {
    row.globalOrder = index + 1;
    row.availableAt = Number.isFinite(row.availableMs) ? new Date(row.availableMs).toISOString() : null;
    if (row.kind !== "human") return;
    row.input.globalOrder = index + 1;
    row.input.availableMs = row.availableMs;
    row.input.availableAt = row.availableAt;
  });
  const sessionStates = new Map(sessions.map((session) => [session.sessionHash, { compactEpoch: 0, compactPending: false, humanSeen: 0 }]));
  for (const row of timeline) {
    const state = sessionStates.get(row.sessionHash);
    if (row.kind === "start") {
      if (row.source === "compact" && !state.compactPending) state.compactEpoch += 1;
      if (row.source === "resume" || row.source === "clear") state.compactEpoch += 1;
      if (row.source === "compact") state.compactPending = false;
      continue;
    }
    if (row.kind === "compact") {
      state.compactEpoch += 1;
      state.compactPending = true;
      continue;
    }
    if (row.kind !== "human") continue;
    state.humanSeen += 1;
    row.input.humanOrdinal = state.humanSeen;
    row.input.compactEpoch = state.compactEpoch;
  }

  const inputs = timeline.filter((row) => row.kind === "human").map((row) => row.input);
  const inputByEvent = new Map(inputs.map((input) => [input.eventId, input]));
  if (new Set(eventRows.map((row) => row.eventId)).size !== eventRows.length || eventRows.some((row) => !inputByEvent.has(row.eventId))) {
    throw new Error(`round 0 ${coverage} store events do not match the fixed transcript`);
  }
  const occurrences = createReplayOccurrenceRows(timeline);
  for (const occurrence of occurrences) {
    occurrence.sessionId = occurrence.input.sessionId;
    occurrence.sessionHash = occurrence.input.sessionHash;
    occurrence.humanOrdinal = occurrence.input.humanOrdinal;
    occurrence.compactEpoch = occurrence.input.compactEpoch;
    occurrence.order = occurrence.input.globalOrder;
  }
  const evidenceByBundle = new Map();
  const detections = [];
  const saves = [];
  for (const evidence of evidenceRows) {
    const input = inputByEvent.get(evidence.eventId);
    if (!input) continue;
    if (!evidenceByBundle.has(evidence.bundleKey)) evidenceByBundle.set(evidence.bundleKey, []);
    evidenceByBundle.get(evidence.bundleKey).push({ eventId: evidence.eventId, input });
    for (const bundleLabel of input.labels) {
      detections.push({
        eventId: evidence.eventId,
        bundleKey: evidence.bundleKey,
        bundleLabel,
        sessionId: input.sessionId,
        sessionHash: input.sessionHash,
        status: "candidate",
        at: input.availableAt,
        order: input.globalOrder,
      });
    }
  }
  for (const evidenceRowsForBundle of evidenceByBundle.values()) {
    evidenceRowsForBundle.sort((left, right) => Date.parse(left.input.availableAt) - Date.parse(right.input.availableAt) ||
      left.input.globalOrder - right.input.globalOrder);
  }
  const versionsByBundle = new Map();
  for (const version of versions) {
    if (!versionsByBundle.has(version.bundleKey)) versionsByBundle.set(version.bundleKey, []);
    versionsByBundle.get(version.bundleKey).push(version);
  }
  for (const evidence of evidenceRows) {
    const input = inputByEvent.get(evidence.eventId);
    if (!input) continue;
    const state = (versionsByBundle.get(evidence.bundleKey) ?? [])
      .filter((version) => Date.parse(version.effectiveFrom) <= Date.parse(input.availableAt)).at(-1);
    if (!state) continue;
    for (const bundleLabel of input.labels) {
      saves.push({
        eventId: evidence.eventId,
        sessionId: input.sessionId,
        sessionHash: input.sessionHash,
        bundleKey: evidence.bundleKey,
        bundleLabel,
        version: state.version,
        status: state.status,
        savedAt: input.availableAt,
        order: input.globalOrder,
        expiresAt: state.expiresAt,
        evidenceEventIds: state.evidenceEventIds,
      });
    }
  }
  const emissions = [];
  const sessionByHash = new Map(sessions.map((session) => [session.sessionHash, session]));
  for (const injection of injections) {
    const session = sessionByHash.get(injection.sessionHash);
    if (!session) continue;
    const sessionRows = rowsBySession.get(injection.sessionHash) ?? [];
    let sourceRow;
    if (injection.trigger === "prompt" || injection.trigger === "refresh") {
      sourceRow = sessionRows.find((row) => row.kind === "human" && row.input.humanOrdinal === injection.humanOrdinal);
    }
    if (!sourceRow) sourceRow = sessionRows.find((row) => row.availableAt === injection.emittedAt && row.kind === "start");
    if (!sourceRow) sourceRow = sessionRows.find((row) => row.kind === "human" && row.input.humanOrdinal === injection.humanOrdinal);
    if (!sourceRow) sourceRow = sessionRows.find((row) => row.availableAt === injection.emittedAt);
    const version = (versionsByBundle.get(injection.bundleKey) ?? []).find((row) => row.version === injection.version);
    if (!sourceRow || !version) continue;
    const labels = new Set((evidenceByBundle.get(injection.bundleKey) ?? [])
      .filter((entry) => Date.parse(entry.input.availableAt) <= Date.parse(injection.emittedAt))
      .flatMap((entry) => entry.input.labels));
    for (const bundleLabel of labels) {
      emissions.push({
        bundleKey: injection.bundleKey,
        version: injection.version,
        bundleLabel,
        sessionId: session.sessionId,
        sessionHash: injection.sessionHash,
        compactEpoch: injection.compactEpoch,
        trigger: injection.trigger,
        humanOrdinal: injection.humanOrdinal,
        emittedAt: injection.emittedAt,
        order: sourceRow.globalOrder,
        ruleText: version.ruleText,
        bodyText: version.ruleText,
        bodyIncluded: injection.bodyIncluded === 1,
        stdoutStatus: injection.stdoutStatus,
        versionStatus: version.status,
        expiresAt: version.expiresAt,
        evidenceEventIds: version.evidenceEventIds,
      });
    }
  }
  const outcomeRows = [];
  for (const occurrence of occurrences) {
    const occurrenceActionRows = Array.isArray(occurrence.actionRows) ? occurrence.actionRows : [];
    const actionTimeline = occurrenceActionRows.map((action) => {
      let actionAt = Number.NaN;
      if (typeof action.at === "string") actionAt = Date.parse(action.at);
      const ruleSnapshots = [];
      if (Number.isFinite(actionAt)) {
        for (const [bundleKey, bundleVersions] of versionsByBundle) {
          const version = bundleVersions.filter((row) => Date.parse(row.effectiveFrom) <= actionAt).at(-1);
          if (version) ruleSnapshots.push({
            bundleKey,
            version: version.version,
            status: version.status,
            expiresAt: version.expiresAt,
            evidenceEventIds: version.evidenceEventIds,
          });
        }
      }
      return { ...action, ruleSnapshots };
    });
    let actionRuleSnapshots = [];
    if (actionTimeline.length > 0) actionRuleSnapshots = actionTimeline[0].ruleSnapshots;
    const result = adjudicatePrevention({
      occurrence,
      detections: detections.filter((row) => row.bundleLabel === occurrence.bundleLabel),
      saves: saves.filter((row) => row.bundleLabel === occurrence.bundleLabel),
      emissions: emissions.filter((row) => row.bundleLabel === occurrence.bundleLabel),
      actionRuleSnapshots,
      actionTimeline,
      cReason: "not_emitted",
    });
    outcomeRows.push({ coverage, sessionHash: occurrence.sessionHash, bundleLabel: occurrence.bundleLabel, prevented: result.prevented });
  }
  return outcomeRows;
}

async function readRound0SessionRows(sessions) {
  const outcomes = [];
  for (const coverage of ["observed", "contract"]) {
    const databasePath = join(ROOT, ".tmp", "replay", "cold", coverage, "memory.db");
    try {
      await stat(databasePath);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    outcomes.push(...readRound0CoverageRows(sessions, coverage, databasePath));
  }
  return outcomes;
}

function preventionCell(summary) {
  if (summary.rate === null) return `${summary.preventedCount}/${summary.recurrenceCount} (未算出)`;
  return `${summary.preventedCount}/${summary.recurrenceCount} (${(summary.rate * 100).toFixed(1)}%)`;
}

function tableForColumns(title, left, right, leftPending = false, rightPending = false) {
  const leftMetrics = flattenNumericMetrics(left ?? {});
  const rightMetrics = flattenNumericMetrics(right ?? {});
  const paths = [...new Set([...Object.keys(leftMetrics), ...Object.keys(rightMetrics)])].sort();
  if (paths.length === 0) return `### ${title}\n\n指標なし\n`;
  return [
    `### ${title}`,
    "",
    "| 指標 | 調整用70% | 評価用30% |",
    "|---|---:|---:|",
    ...paths.map((path) => `| ${path} | ${formatMetric(leftMetrics[path], leftPending)} | ${formatMetric(rightMetrics[path], rightPending)} |`),
    "",
  ].join("\n");
}

function metricsForCoverage(run, coverage) {
  return run?.coverages.find((entry) => entry.coverage === coverage) ?? null;
}

function metricsForAudit(run) {
  if (!run) return null;
  const judges = Object.fromEntries(run.audit.judges.map((judge) => [judge.label, {
    modelVersion: judge.modelVersion,
    matchedCount: judge.matchedCount,
    byGroup: judge.byGroup ?? null,
  }]));
  return {
    sampleCounts: run.auditSampleCounts,
    judges,
    disagreementCount: run.audit.disagreementCount,
    falseSaveUpperBound: run.audit.falseSaveUpperBound,
    falseSaveUpperBoundNumerator: run.audit.falseSaveUpperBoundNumerator,
    falseSaveUpperBoundDenominator: run.audit.falseSaveUpperBoundDenominator,
    unresolvedRows: run.audit.unresolvedRows,
  };
}

function buildEffectMarkdown(body) {
  const tune = body.columns.adjustment70;
  const evaluation = body.columns.evaluation30;
  const sections = [
    "# 訂正規則の分割別再生",
    "",
    `評価状態: ${body.evaluationStatus}`,
    `調整用: ${tune.status} (${tune.sessionCount ?? "未実行"} session)`,
    `評価用: ${evaluation.status} (${evaluation.sessionCount ?? "未実行"} session)`,
    "",
    "## 母集団",
    "",
    "| 指標 | 調整用70% | 評価用30% |",
    "|---|---:|---:|",
    `| session数 | ${tune.sessionCount ?? "未実行"} | ${evaluation.sessionCount ?? "未実行"} |`,
    `| 再発分母 B2〜B10 | ${tune.summary?.population.recurrenceCountByLabel ? Object.entries(tune.summary.population.recurrenceCountByLabel).filter(([key]) => key !== "B1").reduce((sum, [, count]) => sum + count, 0) : "未実行"} | ${evaluation.summary?.population.recurrenceCountByLabel ? Object.entries(evaluation.summary.population.recurrenceCountByLabel).filter(([key]) => key !== "B1").reduce((sum, [, count]) => sum + count, 0) : "未実行"} |`,
    "",
  ];
  for (const coverage of ["observed", "contract"]) {
    sections.push(tableForColumns(
      `${coverage}: 全指標`,
      metricsForCoverage(tune.run, coverage),
      metricsForCoverage(evaluation.run, coverage),
      tune.status !== "完了",
      evaluation.status !== "完了",
    ));
  }
  sections.push(tableForColumns(
    "独立監査・標本別誤検出 / 誤保存 / 見逃し・Wilson95%区間",
    metricsForAudit(tune.run),
    metricsForAudit(evaluation.run),
    tune.status !== "完了",
    evaluation.status !== "完了",
  ));
  const round0 = body.round0TuneComparison;
  sections.push(
    "## ラウンド0と調整用sessionの比較",
    "",
    round0.tune.status === "verified_from_round0_replay_store"
      ? `ラウンド0 tune値は全${round0.fullPopulationSessionCount} sessionの再生DBから復元し、JSONの全体集計と照合済み。対象: ${round0.tune.sessionCount} session。`
      : `ラウンド0 tune値は算出不可。${round0.tune.reason}。対象: ${round0.tune.sessionCount} session。`,
    "",
    "| coverage | bundle | ラウンド0 tune | ラウンド0 全98 session |",
    "|---|---|---:|---:|",
    ...round0.all98.flatMap((run) => [
      `| ${run.coverage} | B2〜B10 | ${round0.tune.perCoverage?.[run.coverage] ? preventionCell(round0.tune.perCoverage[run.coverage].main) : "算出不可"} | ${preventionCell(run.main)} |`,
      ...BUNDLE_LABELS.map((label) =>
        `| ${run.coverage} | ${label} | ${round0.tune.perCoverage?.[run.coverage] ? preventionCell(round0.tune.perCoverage[run.coverage].perTheme[label]) : "算出不可"} | ${preventionCell(run.perTheme[label])} |`),
    ]),
    "",
  );
  sections.push(
    "## 監査の合否",
    "",
    "| 指標 | 調整用70% | 評価用30% |",
    "|---|---:|---:|",
    `| Sol / Opus監査 | ${tune.run?.audit.status ?? "未実行"} | ${evaluation.run?.audit.status ?? "未実行"} |`,
    `| 監査モデル版 | ${tune.run?.audit.judges.map((judge) => `${judge.label}: ${judge.modelVersion ?? "利用不可"}`).join("; ") ?? "未実行"} | ${evaluation.run?.audit.judges.map((judge) => `${judge.label}: ${judge.modelVersion ?? "利用不可"}`).join("; ") ?? "未実行"} |`,
    `| false save上界 | ${formatMetric(tune.run?.audit.falseSaveUpperBound, tune.status !== "完了")} | ${formatMetric(evaluation.run?.audit.falseSaveUpperBound, evaluation.status !== "完了")} |`,
    `| 不一致 | ${formatMetric(tune.run?.audit.disagreementCount, tune.status !== "完了")} | ${formatMetric(evaluation.run?.audit.disagreementCount, evaluation.status !== "完了")} |`,
    "",
    "評価用の実行後にコード・閾値・seedを変更しない。再実行は固定台帳が拒否。",
    "旧実装は本文なし・題名だけの投影として同じ行動前判定器で比較。旧版hook台帳の実数照合ではない。",
    "",
  );
  return sections.join("\n");
}

async function readRunState(filename) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeEffectReports(scratchRoot, hashes, population, manifest) {
  const stateDirectory = join(scratchRoot, "state");
  const tune = await readRunState(join(stateDirectory, "tune-run.json"));
  const evaluation = await readRunState(join(stateDirectory, "evaluation-run.json"));
  const baselineReport = JSON.parse(await readFile(join(ROOT, ".wasurenagusa", "reports", "replay", "simulate-cold.json"), "utf8"));
  const tuneSessions = splitReplaySessions(manifest.sessions).tune;
  const round0Manifest = await readManifest(manifest.manifestPath);
  const round0SessionRows = await readRound0SessionRows(round0Manifest.sessions);
  const body = {
    reportVersion: REPORT_VERSION,
    evaluationStatus: evaluation ? "評価済み" : "評価未実行",
    dateRangeJst: { start: DATE_START, end: DATE_END },
    split: { seed: SAMPLE_SEED, adjustmentPercent: 70, evaluationPercent: 30, adjustmentSessions: 68, evaluationSessions: 30 },
    population,
    hashes,
    round0TuneComparison: summarizeRound0TuneComparison(baselineReport, tuneSessions.length, round0SessionRows,
      tuneSessions.map((session) => session.sessionHash)),
    columns: {
      adjustment70: tune
        ? { status: "完了", sessionCount: tune.sessionCount, summary: tune.summary, run: tune.run }
        : { status: "未実行", sessionCount: null, summary: null, run: null },
      evaluation30: evaluation
        ? { status: "完了", sessionCount: evaluation.sessionCount, summary: evaluation.summary, run: evaluation.run }
        : { status: "未実行", sessionCount: null, summary: null, run: null },
    },
    gates: {
      current98Sessions: population.periodSessionCount === 98,
      fixedSplit: true,
      evaluationFrozen: Boolean(await readRunState(join(scratchRoot, "evaluation-freeze.json"))),
      evaluationConsumedOnce: Boolean(await readRunState(join(scratchRoot, "evaluation-claim.json"))),
      independentSolOpusAudit: Boolean(evaluation?.run.audit.status === "監査結果読込済み"),
      falseSaveAuditUnderTwoPercent: evaluation?.run.audit.falseSaveUpperBound === null
        ? null
        : evaluation?.run.audit.falseSaveUpperBound <= 0.02,
      oldImplementationLedgerLoaded: false,
      legacyTitleOnlySameAdjudicator: true,
    },
  };
  const outputDirectory = join(scratchRoot, "reports");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, "simulate.json"), JSON.stringify(body, null, 2) + "\n", "utf8");
  await writeFile(join(outputDirectory, "simulate.md"), buildEffectMarkdown(body), "utf8");
  return body;
}

async function runColdSimulation({ splitName, manifest, split, compiledRoot, scratchRoot, hashes, auditArgs }) {
  const tuneStatePath = join(scratchRoot, "state", "tune-run.json");
  const evaluationStatePath = join(scratchRoot, "state", "evaluation-run.json");
  const freezePath = join(scratchRoot, "evaluation-freeze.json");
  if (splitName === "tune") {
    if (await readRunState(freezePath)) throw new Error("tuning is frozen; evaluation inputs cannot be changed");
  } else {
    const frozen = await readRunState(freezePath);
    if (!frozen) throw new Error("evaluation requires frozen tune inputs");
    if (JSON.stringify(frozen.hashes) !== JSON.stringify(hashes)) throw new Error("evaluation input hashes differ from the frozen tune run");
    if (await readRunState(evaluationStatePath)) throw new Error("evaluation split has already run");
    await claimReplayEvaluation(scratchRoot, hashes);
  }
  const splitRun = await runColdSplit({
    splitName,
    split,
    compiledRoot,
    scratchRoot,
    hashes,
    auditArgs,
  });
  const state = {
    sessionCount: splitRun.sessionCount,
    hashes,
    population: splitRun.population,
    summary: { population: splitRun.population, auditSampleCounts: splitRun.auditSampleCounts },
    run: { coverages: splitRun.coverages, auditSampleCounts: splitRun.auditSampleCounts, audit: splitRun.audit },
  };
  await mkdir(join(scratchRoot, "state"), { recursive: true });
  await writeFile(splitName === "tune" ? tuneStatePath : evaluationStatePath, JSON.stringify(state) + "\n", "utf8");
  const report = await writeEffectReports(scratchRoot, hashes, reportPopulation(manifest), manifest);
  return {
    mode: "cold",
    split: splitName,
    sessionCount: split.length,
    evaluationStatus: report.evaluationStatus,
    reportFiles: ["reports/simulate.json", "reports/simulate.md"],
    auditPromptFile: `audit-prompts/${splitName}.jsonl`,
  };
}

function hookEnvironment(scratchRoot, memoryRoot) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: join(scratchRoot, "home"),
    TMPDIR: process.env.TMPDIR ?? join(scratchRoot, "tmp"),
    MEMORY_DIR: resolve(memoryRoot),
    WASURENAGUSA_CORRECTION_LOOP: "on",
    WASURENAGUSA_CORRECTION_INJECT: "on",
    WASURENAGUSA_STOP_LLM: "off",
    WASURENAGUSA_SCHEDULER: "0",
  };
}

function runIsolatedHook(compiledRoot, scratchRoot, memoryRoot, kind, input, transcriptPath) {
  const command = kind === "Stop" ? "analyze.js" : "context.js";
  const filename = join(compiledRoot, "cli", command);
  const env = hookEnvironment(scratchRoot, memoryRoot);
  const startedAt = process.hrtime.bigint();
  const result = spawnSync(process.execPath, [filename], {
    cwd: ROOT,
    env,
    input: JSON.stringify({ ...input, ...(transcriptPath ? { transcript_path: transcriptPath } : {}) }),
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  if (result.error || result.status !== 0) {
    const errorCode = result.error?.code ?? "exit-" + String(result.status);
    throw new Error(`isolated ${kind} hook failed (${errorCode})`);
  }
  const output = result.stdout ?? "";
  return {
    elapsedMs,
    outputCharacters: Array.from(output).length,
    correctionBodyEmitted: output.includes("### オーナーからの確認済み規則"),
  };
}

async function runIsolatedHookFlow(manifest, compiledRoot, scratchRoot) {
  const root = join(scratchRoot, "acceptance");
  const memoryRoot = join(root, "store");
  const transcriptRoot = join(root, "transcripts");
  await mkdir(root, { recursive: true });
  await mkdir(transcriptRoot, { recursive: true });
  const bootstrap = await initializeBlankStore(compiledRoot, memoryRoot);
  bootstrap.storage.close();
  const calls = [];
  const sessionMetrics = [];
  const relatedTopicCalls = [];
  const processEvent = (session, row, sourcePath, kind, input) => {
    const result = runIsolatedHook(compiledRoot, root, memoryRoot, kind, {
      session_id: session.sessionId,
      cwd: ROOT,
      hook_event_name: kind === "Stop" ? "Stop" : input.hook_event_name,
      ...input,
    }, sourcePath);
    const metric = { kind, lineOrder: row.lineOrder, ...result };
    calls.push(metric);
    return metric;
  };
  for (const session of manifest.sessions) {
    const temporaryTranscript = join(transcriptRoot, `${session.sessionHash}.jsonl`);
    const humanRows = session.humanInputs.map((input) => ({ kind: "human", input, lineOrder: input.lineOrder, byteEndOffset: input.byteEndOffset }));
    const hookRows = session.timeline.filter((row) => ["start", "compact", "stop"].includes(row.kind));
    const rows = [...humanRows, ...hookRows].sort((left, right) => left.lineOrder - right.lineOrder);
    const firstHumanOrder = humanRows[0]?.lineOrder ?? Number.POSITIVE_INFINITY;
    const hasStartup = hookRows.some((row) => row.kind === "start" && row.lineOrder < firstHumanOrder);
    if (!hasStartup && humanRows.length > 0) rows.push({
      kind: "start",
      source: "startup",
      lineOrder: -1,
      byteEndOffset: 0,
      synthetic: true,
    });
    if (!hookRows.some((row) => row.kind === "stop" && row.lineOrder > (humanRows.at(-1)?.lineOrder ?? -1))) {
      rows.push({
        kind: "stop",
        lineOrder: Math.max(...rows.map((row) => row.lineOrder), 0) + 1,
        byteEndOffset: session.snapshotMeta.size,
        synthetic: true,
      });
    }
    rows.sort((left, right) => left.lineOrder - right.lineOrder);
    let humanOrdinal = 0;
    const outputs = { start: 0, prompt: 0, compact: 0, ordinal31: 0 };
    for (const row of rows) {
      const inputRow = row.kind === "human" ? row.input : null;
      if (inputRow) humanOrdinal += 1;
      let transcript = session.snapshot.subarray(0, row.byteEndOffset ?? 0);
      if (row.synthetic && row.kind === "stop") {
        const stopRow = JSON.stringify({
          type: "system",
          subtype: "stop_hook_summary",
          sessionId: session.sessionId,
          timestamp: new Date().toISOString(),
          hookInfos: [{ command: STOP_COMMAND }],
        }) + "\n";
        transcript = Buffer.concat([transcript, Buffer.from(stopRow)]);
      }
      await writeFile(temporaryTranscript, transcript);
      let metric = null;
      if (row.kind === "start") {
        metric = processEvent(session, row, temporaryTranscript, "SessionStart", {
          hook_event_name: "SessionStart",
          source: row.source ?? "startup",
        });
        outputs.start += Number(metric.correctionBodyEmitted);
        if (row.source === "compact") outputs.compact += Number(metric.correctionBodyEmitted);
      } else if (row.kind === "compact") {
        processEvent(session, row, temporaryTranscript, "PreCompact", { hook_event_name: "PreCompact" });
        const nextHuman = humanRows.find((entry) => entry.lineOrder > row.lineOrder);
        const recordedCompactStart = session.timeline.some((entry) => entry.kind === "start" && entry.source === "compact" &&
          entry.lineOrder > row.lineOrder && (!nextHuman || entry.lineOrder < nextHuman.lineOrder));
        if (!recordedCompactStart) {
          metric = processEvent(session, row, temporaryTranscript, "SessionStart", {
            hook_event_name: "SessionStart",
            source: "compact",
          });
          outputs.start += Number(metric.correctionBodyEmitted);
          outputs.compact += Number(metric.correctionBodyEmitted);
        }
      } else if (row.kind === "human") {
        metric = processEvent(session, row, temporaryTranscript, "UserPromptSubmit", {
          hook_event_name: "UserPromptSubmit",
          prompt: inputRow.text,
          ...(inputRow.uuid ? { uuid: inputRow.uuid } : {}),
        });
        outputs.prompt += Number(metric.correctionBodyEmitted);
        if (humanOrdinal === 31) outputs.ordinal31 += 1;
        const documentAliases = [...inputRow.text.matchAll(/文案|報告|資料|文書作成/gu)].map((match) => match[0]);
        if (documentAliases.length > 0 && humanOrdinal > 10 && outputs.start > 0) {
          relatedTopicCalls.push({ emitted: metric.correctionBodyEmitted, aliases: [...new Set(documentAliases)] });
        }
      } else if (row.kind === "stop") {
        processEvent(session, row, temporaryTranscript, "Stop", {});
      }
    }
    sessionMetrics.push({ sessionHash: session.sessionHash, outputs, humanCount: humanRows.length });
  }
  const db = new Database(join(memoryRoot, "memory.db"), { readonly: true, fileMustExist: true });
  let confirmedRuleCount;
  let bodyInjectionCount;
  let confirmedRuleTexts;
  try {
    confirmedRuleCount = db.prepare("SELECT COUNT(*) AS count FROM owner_correction_bundles WHERE status = 'confirmed'").get().count;
    bodyInjectionCount = db.prepare("SELECT COUNT(*) AS count FROM owner_correction_injections WHERE stdout_status = 'emitted' AND body_included = 1").get().count;
    confirmedRuleTexts = db.prepare(`
      SELECT v.rule_text AS ruleText FROM owner_correction_versions v
      JOIN owner_correction_bundles b ON b.bundle_key = v.bundle_key AND b.version = v.version
      WHERE b.status = 'confirmed' AND v.status = 'confirmed'
    `).all().map((row) => row.ruleText);
  } finally {
    db.close();
  }
  const firstSessionMetric = sessionMetrics[0];
  const nextSessionStartOutputCount = sessionMetrics.slice(1).reduce((sum, row) => sum + row.outputs.start, 0);
  const compactStartOutputCount = sessionMetrics.reduce((sum, row) => sum + row.outputs.compact, 0);
  const ordinal31HookCount = sessionMetrics.reduce((sum, row) => sum + row.outputs.ordinal31, 0);
  const relatedTopicBodyOutputCount = relatedTopicCalls.filter((entry) => entry.emitted &&
    entry.aliases.every((alias) => confirmedRuleTexts.every((ruleText) => !ruleText.includes(alias)))).length;
  const checks = {
    stopRan: calls.some((row) => row.kind === "Stop"),
    confirmedRuleSaved: confirmedRuleCount > 0,
    laterSessionStartReceivedBody: sessionMetrics.length > 1 && nextSessionStartOutputCount > 0,
    compactStartReceivedBody: compactStartOutputCount > 0,
    thirtyFirstPromptReached: ordinal31HookCount > 0,
    lexicalMismatchTopicQueryReceivedBody: relatedTopicBodyOutputCount > 0,
  };
  const status = Object.values(checks).every(Boolean) ? "pass" : "fail";
  return {
    status,
    checks,
    processCount: calls.length,
    processFailureCount: 0,
    confirmedRuleCount,
    bodyInjectionCount,
    correctionBodyStartOutputCount: sessionMetrics.reduce((sum, row) => sum + row.outputs.start, 0),
    correctionBodyPromptOutputCount: sessionMetrics.reduce((sum, row) => sum + row.outputs.prompt, 0),
    correctionBodyCompactOutputCount: compactStartOutputCount,
    correctionBodyOutputAfterStartCount: nextSessionStartOutputCount,
    thirtyFirstPromptHookCount: ordinal31HookCount,
    lexicalMismatchTopicBodyOutputCount: relatedTopicBodyOutputCount,
    timing: summarizeDurations(calls.map((row) => row.elapsedMs)),
  };
}

async function writeSimpleReport(scratchRoot, name, body, markdown) {
  const outputDirectory = join(scratchRoot, "reports");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, `${name}.json`), JSON.stringify(body, null, 2) + "\n", "utf8");
  await writeFile(join(outputDirectory, `${name}.md`), markdown + "\n", "utf8");
}

function buildSimpleMarkdown(title, body) {
  const rows = flattenNumericMetrics(body);
  return [
    `# ${title}`,
    "",
    `状態: ${body.status ?? "完了"}`,
    "",
    "| 指標 | 値 |",
    "|---|---:|",
    ...Object.entries(rows).map(([key, value]) => `| ${key} | ${formatMetric(value)} |`),
    "",
    ...(body.checks ? Object.entries(body.checks).map(([key, value]) => `- ${key}: ${value ? "pass" : "fail"}`) : []),
  ].join("\n");
}

async function validateRunPaths(compiledRoot, scratchRoot) {
  const temporaryRoot = join(ROOT, ".tmp");
  const compiled = resolve(compiledRoot);
  const scratch = resolve(scratchRoot);
  if (!pathContains(temporaryRoot, compiled) || !pathContains(temporaryRoot, scratch)) {
    throw new Error("compiled root and scratch must stay under the worktree .tmp directory");
  }
  if (compiled === scratch || pathContains(compiled, scratch) || pathContains(scratch, compiled)) {
    throw new Error("compiled root and scratch must be separate directories");
  }
  if (compiled === join(ROOT, "dist") || pathContains(join(ROOT, "dist"), compiled)) {
    throw new Error("dist is not an allowed replay build source");
  }
  if (!(await stat(join(compiled, "cli", "context.js")).catch(() => null))) {
    throw new Error("scratch build not found; compile with --outDir under .tmp first");
  }
  const compiledParentEnv = resolve(compiled, "..", ".env");
  if (await stat(compiledParentEnv).catch(() => null)) {
    throw new Error("refusing a replay build whose parent contains .env");
  }
  return { compiled, scratch };
}

export async function runSimulation({ mode, manifest: manifestPath, compiledRoot, scratchRoot, split, auditArgs }) {
  if (!["cold", "freeze", "acceptance", "hook-timing"].includes(mode)) {
    throw new Error("unsupported replay mode");
  }
  const { compiled, scratch } = await validateRunPaths(compiledRoot, scratchRoot);
  const manifest = await readManifest(manifestPath);
  if (mode === "cold" || mode === "freeze") {
    if (manifest.sessions.length !== 98 || manifest.fileAudit.included !== 98) {
      throw new Error("cold replay requires exactly 98 valid period sessions");
    }
  } else if (manifest.fixtureKind !== "synthetic") {
    throw new Error("acceptance and hook-timing require a synthetic manifest fixture");
  }
  const partition = splitReplaySessions(manifest.sessions);
  if ((mode === "cold" || mode === "freeze") && !isExpectedReplaySplit(manifest.sessions, partition)) {
    throw new Error("current 98-session split must be fixed at 68:30");
  }
  const hashes = await computeReplayHashes(manifest, partition, compiled);
  const population = reportPopulation(manifest);
  if (mode === "freeze") {
    const tuneState = await readRunState(join(scratch, "state", "tune-run.json"));
    if (!tuneState) throw new Error("freeze requires a completed tune split");
    if (JSON.stringify(tuneState.hashes) !== JSON.stringify(hashes)) throw new Error("tune inputs changed before evaluation freeze");
    const frozen = await freezeReplayEvaluation(scratch, hashes);
    const body = { mode, status: "frozen", hashes: frozen.hashes, sessionCount: manifest.sessions.length, split: { adjustment: 68, evaluation: 30 } };
    await writeSimpleReport(scratch, "evaluation-freeze", body, buildSimpleMarkdown("評価入力の固定", body));
    return body;
  }
  if (mode === "cold") {
    if (!["tune", "evaluation"].includes(split)) throw new Error("cold mode requires split tune|evaluation");
    const sessions = split === "tune" ? partition.tune : partition.evaluation;
    return runColdSimulation({
      splitName: split,
      manifest,
      split: sessions,
      compiledRoot: compiled,
      scratchRoot: scratch,
      hashes,
      auditArgs,
    });
  }
  if (mode === "acceptance") {
    const body = await runIsolatedHookFlow(manifest, compiled, scratch);
    await writeSimpleReport(scratch, "acceptance", body, buildSimpleMarkdown("実bin隔離通し試験", body));
    return body;
  }
  const timing = await runHookTimings({ sessions: manifest.sessions, compiledRoot: compiled, scratchRoot: scratch });
  const body = { mode, status: timing.failedProcessCount === 0 ? "pass" : "fail", ...timing };
  await writeSimpleReport(scratch, "hook-timing", body, buildSimpleMarkdown("実bin処理時間", body));
  return body;
}

export const internal = { deterministicSample, wilsonInterval, nextCursorIdentity, hashCompiledTree, reportPopulation, confidenceConditions };
