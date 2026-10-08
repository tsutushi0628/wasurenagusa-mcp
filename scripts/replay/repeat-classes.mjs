#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { REPEAT_CLASS_PATTERNS, REPEAT_SIGNAL_PATTERN } from "./lib/repeat-class-patterns.mjs";
import { readSessionIndexForTranscripts, sessionIndexEntry, validateProjectName } from "./lib/session-project.mjs";

const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/u;
const SLASH_COMMAND_PREFIX = /^\/[a-z][a-z0-9-]*(?:\s|$)/iu;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validateDate(value, name) {
  if (!DATE_FORMAT.test(value)) {
    throw new Error(`${name} must use YYYY-MM-DD`);
  }
  const parsedDate = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== value) {
    throw new Error(`${name} must be a real calendar date`);
  }
  return value;
}

function readOptionValue(args, index, name) {
  const value = args[index + 1];
  if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export function parseRepeatClassesArguments(args) {
  const options = { since: null, until: null };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (["--transcripts", "--compiled-root", "--out", "--since", "--until", "--project", "--manifest"].includes(argument)) {
      const value = readOptionValue(args, index, argument);
      index += 1;
      if (argument === "--transcripts") {
        options.transcriptsDirectory = value;
      } else if (argument === "--compiled-root") {
        options.compiledRoot = value;
      } else if (argument === "--out") {
        options.outputPath = value;
      } else if (argument === "--project") {
        options.project = validateProjectName(value);
      } else if (argument === "--manifest") {
        options.manifestPath = value;
      } else if (argument === "--since") {
        options.since = validateDate(value, argument);
      } else {
        options.until = validateDate(value, argument);
      }
      continue;
    }
    throw new Error(`unsupported argument: ${argument}`);
  }

  if (!options.transcriptsDirectory || !options.compiledRoot || !options.outputPath) {
    throw new Error("--transcripts <dir>, --compiled-root <dir>, and --out <path> are required");
  }
  if (options.since && options.until && options.since > options.until) {
    throw new Error("--since must not be after --until");
  }
  return options;
}

async function readFixedManifest(manifestPath, transcriptsRoot) {
  const resolvedManifestPath = resolve(manifestPath);
  const resolvedTranscriptsRoot = resolve(transcriptsRoot);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(resolvedManifestPath, "utf8"));
  } catch (error) {
    throw new Error("repeat classes manifest could not be read", { cause: error });
  }
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.sessions)) {
    throw new Error("repeat classes manifest is invalid");
  }
  const snapshots = new Map();
  for (const session of manifest.sessions) {
    if (!session || typeof session.fileId !== "string" || !/^[^/\\]+$/u.test(session.fileId) ||
      typeof session.path !== "string" || !Number.isSafeInteger(session.readEndByteOffset) ||
      session.readEndByteOffset <= 0 || typeof session.prefixSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(session.prefixSha256)) {
      throw new Error("repeat classes manifest session is invalid");
    }
    const transcriptPath = resolve(resolvedTranscriptsRoot, session.path);
    const relativePath = relative(resolvedTranscriptsRoot, transcriptPath);
    if (isAbsolute(session.path) || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath) ||
      basename(transcriptPath) !== `${session.fileId}.jsonl`) {
      throw new Error("repeat classes manifest transcript path does not match --transcripts");
    }
    if (snapshots.has(session.fileId)) throw new Error("repeat classes manifest contains a duplicate fileId");
    snapshots.set(session.fileId, {
      filename: transcriptPath,
      readEndByteOffset: session.readEndByteOffset,
      prefixSha256: session.prefixSha256,
    });
  }
  return snapshots;
}

function jstDate(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function loadOwnerEventExtractor(compiledRoot) {
  const modulePath = resolve(compiledRoot, "corrections", "events.js");
  const eventsModule = await import(pathToFileURL(modulePath).href);
  if (typeof eventsModule.extractOwnerEvent !== "function") {
    throw new Error("compiled module does not export extractOwnerEvent");
  }
  return eventsModule.extractOwnerEvent;
}

function classifyText(text) {
  const normalizedText = text.normalize("NFKC");
  for (const item of REPEAT_CLASS_PATTERNS) {
    if (item.pattern.test(normalizedText)) return item.id;
  }
  return null;
}

function isExcluded(ownerEvent) {
  const text = ownerEvent.text.trimStart();
  if (ownerEvent.isHandoffPaste === true) return true;
  if (text.startsWith("<pasted_content")) return true;
  if (text.startsWith("<command-")) return true;
  if (ownerEvent.isSlashCommand === true || SLASH_COMMAND_PREFIX.test(text)) return true;
  return false;
}

function makeClassStats() {
  const stats = new Map();
  for (const { id } of REPEAT_CLASS_PATTERNS) {
    stats.set(id, { count: 0, sessions: new Set(), days: new Set() });
  }
  return stats;
}

async function readTranscriptFile({ filename, extractOwnerEvent, options, state, project, snapshot }) {
  let streamOptions = { encoding: "utf8" };
  let snapshotHash = null;
  if (snapshot) {
    const fileStat = await stat(filename);
    if (fileStat.size < snapshot.readEndByteOffset) {
      throw new Error(`manifest transcript is shorter than its fixed byte offset: ${basename(filename)}`);
    }
    streamOptions = { start: 0, end: snapshot.readEndByteOffset - 1 };
    snapshotHash = createHash("sha256");
  }
  const input = createReadStream(filename, streamOptions);
  if (snapshotHash) input.on("data", (chunk) => snapshotHash.update(chunk));
  const lineReader = createInterface({
    input,
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  const fallbackSessionId = basename(filename, ".jsonl");

  for await (const line of lineReader) {
    lineNumber += 1;
    if (!line.trim()) continue;

    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`invalid transcript JSONL at ${basename(filename)}:${lineNumber}`);
    }
    if (typeof row !== "object" || row === null || Array.isArray(row)) continue;

    const ownerEvent = extractOwnerEvent(row);
    if (!ownerEvent || typeof ownerEvent.text !== "string" || isExcluded(ownerEvent)) continue;

    let timestamp = ownerEvent.timestamp;
    if (timestamp === undefined) timestamp = row.timestamp;
    if (timestamp === undefined) continue;
    const date = jstDate(timestamp);
    if (!date) continue;
    if (options.since && date < options.since) continue;
    if (options.until && date > options.until) continue;

    let sessionId = ownerEvent.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      sessionId = fallbackSessionId;
    }
    const sessionHash = sha256(sessionId);
    state.utterances += 1;
    state.activeDates.add(date);

    const text = ownerEvent.text.normalize("NFKC");
    const dateTime = new Date(timestamp);
    const minute = dateTime.toISOString().slice(0, 16);
    const broadcastKey = `${minute}\u0000${text}`;
    let group = state.broadcastGroups.get(broadcastKey);
    if (!group) {
      group = new Set();
      state.broadcastGroups.set(broadcastKey, group);
    }
    group.add(sessionHash);
    state.utterancesDeduped.add(broadcastKey);
    if (REPEAT_SIGNAL_PATTERN.test(text)) {
      state.repeatSignalCount += 1;
      state.repeatSignalDeduped.add(broadcastKey);
    }

    const classId = classifyText(ownerEvent.text);
    if (!classId) continue;

    const stats = state.classStats.get(classId);
    stats.count += 1;
    stats.sessions.add(sessionHash);
    stats.days.add(date);
    const projectClassCounts = state.classProjectCounts.get(classId);
    projectClassCounts.set(project, (projectClassCounts.get(project) ?? 0) + 1);
    let dailyTotal = state.dailyTotals.get(date);
    if (dailyTotal === undefined) dailyTotal = 0;
    state.dailyTotals.set(date, dailyTotal + 1);

    state.matches.push({
      classId,
      date,
      minute,
      sessionHash,
      textHash: sha256(text),
      textPrefix: "",
    });
  }
  if (snapshot && snapshotHash?.digest("hex") !== snapshot.prefixSha256) {
    throw new Error(`manifest transcript prefix digest does not match: ${basename(filename)}`);
  }
}

export async function measureRepeatClasses(options) {
  const since = typeof options.since === "string" ? validateDate(options.since, "--since") : null;
  const until = typeof options.until === "string" ? validateDate(options.until, "--until") : null;
  if (since && until && since > until) {
    throw new Error("--since must not be after --until");
  }

  const extractOwnerEvent = await loadOwnerEventExtractor(options.compiledRoot);
  const transcriptsRoot = resolve(options.transcriptsDirectory);
  const manifestSnapshots = options.manifestPath
    ? await readFixedManifest(options.manifestPath, transcriptsRoot)
    : null;
  const sessionIndex = await readSessionIndexForTranscripts(transcriptsRoot, { required: Boolean(options.project) });
  const launchDir = basename(transcriptsRoot);
  let filenames;
  if (manifestSnapshots) {
    filenames = [...manifestSnapshots.values()].map((snapshot) => snapshot.filename);
  } else {
    const entries = await readdir(transcriptsRoot, { withFileTypes: true });
    filenames = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(transcriptsRoot, entry.name))
      .sort();
  }
  if (options.project) {
    filenames = filenames.filter((filename) => sessionIndexEntry(sessionIndex, basename(filename, ".jsonl"), launchDir)?.project === options.project);
  }
  if (filenames.length === 0) {
    if (options.project) throw new Error(`transcripts directory contains no JSONL files for project: ${options.project}`);
    throw new Error("transcripts directory contains no JSONL files");
  }

  const dailyTotals = new Map();
  const classProjectCounts = new Map(REPEAT_CLASS_PATTERNS.map(({ id }) => [id, new Map()]));
  const projectNames = new Set();
  const state = {
    utterances: 0,
    activeDates: new Set(),
    classStats: makeClassStats(),
    classProjectCounts,
    projectNames,
    dailyTotals,
    broadcastGroups: new Map(),
    utterancesDeduped: new Set(),
    repeatSignalCount: 0,
    repeatSignalDeduped: new Set(),
    matches: [],
  };
  for (const filename of filenames) {
    const sessionId = basename(filename, ".jsonl");
    const indexedSession = sessionIndexEntry(sessionIndex, sessionId, launchDir);
    const project = indexedSession?.project ?? launchDir;
    state.projectNames.add(project);
    await readTranscriptFile({
      filename,
      extractOwnerEvent,
      options: { since, until },
      state,
      project,
      snapshot: manifestSnapshots?.get(sessionId),
    });
  }

  const classes = {};
  let total = 0;
  for (const { id } of REPEAT_CLASS_PATTERNS) {
    const stats = state.classStats.get(id);
    classes[id] = {
      count: stats.count,
      sessionCount: stats.sessions.size,
      dayCount: stats.days.size,
    };
    total += stats.count;
  }

  const activeDateList = [...state.activeDates].sort();
  for (const date of activeDateList) {
    if (!dailyTotals.has(date)) dailyTotals.set(date, 0);
  }
  let broadcastGroupCount = 0;
  for (const sessions of state.broadcastGroups.values()) {
    if (sessions.size >= 2) broadcastGroupCount += 1;
  }

  const projectBreakdown = {};
  for (const project of [...state.projectNames].sort()) {
    projectBreakdown[project] = Object.fromEntries(REPEAT_CLASS_PATTERNS.map(({ id }) => [
      id,
      state.classProjectCounts.get(id).get(project) ?? 0,
    ]));
  }

  return {
    version: 1,
    period: { since, until },
    total,
    utterances: state.utterances,
    repeatSignal: {
      count: state.repeatSignalCount,
      utterances: state.utterances,
      per100: state.utterances === 0 ? null : (state.repeatSignalCount / state.utterances) * 100,
      countDeduped: state.repeatSignalDeduped.size,
      utterancesDeduped: state.utterancesDeduped.size,
      per100Deduped: state.utterancesDeduped.size === 0
        ? null
        : (state.repeatSignalDeduped.size / state.utterancesDeduped.size) * 100,
    },
    classes,
    dailyTotals: activeDateList.map((date) => ({ date, total: dailyTotals.get(date) })),
    activeDays: activeDateList.length,
    averagePerDay: activeDateList.length === 0 ? 0 : total / activeDateList.length,
    broadcastGroups: broadcastGroupCount,
    projectBreakdown,
    matches: state.matches,
  };
}

async function writeReport(report, outputPath) {
  const destination = resolve(outputPath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function formatSummary(report) {
  const classSummary = REPEAT_CLASS_PATTERNS.map(({ id }) => `${id}=${report.classes[id].count}`).join(" ");
  return `total=${report.total} ${classSummary} utterances=${report.utterances} activeDays=${report.activeDays} broadcastGroups=${report.broadcastGroups} repeatSignal=${report.repeatSignal.count}/${report.repeatSignal.utterances}`;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const options = parseRepeatClassesArguments(process.argv.slice(2));
  const report = await measureRepeatClasses(options);
  await writeReport(report, options.outputPath);
  process.stdout.write(`${formatSummary(report)}\n`);
}
