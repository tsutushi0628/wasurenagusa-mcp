#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { appendFile, copyFile, lstat, mkdir, readdir, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { inferSessionProject, launchDirectoryName, readSessionIndex } from "../replay/lib/session-project.mjs";

const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MTIME_PRECISION_TOLERANCE_MS = 0.002;

class TranscriptChangedDuringCopyError extends Error {}

function getJstTimestamp(date = new Date()) {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().replace("Z", "+09:00");
}

function getJstDatePart(date = new Date()) {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

function encodeProjectDirectory(projectDirectory) {
  return resolve(projectDirectory).replaceAll(sep, "-");
}

function getDefaultArchivePaths(projectDirectory = process.cwd(), homeDirectory = homedir()) {
  const projectRoot = resolve(projectDirectory);
  return {
    projectDirectory: projectRoot,
    sourceDirectory: join(homeDirectory, ".claude", "projects", encodeProjectDirectory(projectRoot)),
    destinationDirectory: join(projectRoot, ".wasurenagusa", "transcripts-archive", basename(projectRoot)),
  };
}

function parseArchiveArguments(args) {
  const options = { dryRun: false };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--all") {
      options.all = true;
      continue;
    }
    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (argument === "--source" || argument === "--project-root") {
      const value = args[index + 1];
      if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;
      if (argument === "--source") {
        options.sourceDirectory = value;
      } else {
        options.projectDirectory = value;
      }
      continue;
    }
    throw new Error(`unsupported argument: ${argument}`);
  }

  if (options.all && (options.sourceDirectory || options.projectDirectory)) {
    throw new Error("--all cannot be combined with --source or --project-root");
  }

  return options;
}

async function readDestinationStat(filename) {
  try {
    const destinationStat = await lstat(filename);
    if (!destinationStat.isFile()) {
      throw new Error("archive target is not a regular file");
    }
    return destinationStat;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function hasSameSnapshot(sourceStat, destinationStat) {
  return destinationStat !== null
    && sourceStat.size === destinationStat.size
    && Math.abs(sourceStat.mtimeMs - destinationStat.mtimeMs) <= MTIME_PRECISION_TOLERANCE_MS;
}

async function listArchiveFiles(destinationDirectory) {
  try {
    const entries = await readdir(destinationDirectory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function getArchiveUsage(destinationDirectory) {
  const entries = await listArchiveFiles(destinationDirectory);
  let totalBytes = 0;
  let oldestMtime = Number.POSITIVE_INFINITY;

  for (const entry of entries) {
    const fileStat = await stat(join(destinationDirectory, entry.name));
    totalBytes += fileStat.size;
    oldestMtime = Math.min(oldestMtime, fileStat.mtimeMs);
  }

  return { totalBytes, oldestMtime };
}

async function copyTranscript(sourcePath, destinationPath, sourceStat, copyFileImpl = copyFile) {
  const destinationTempPath = `${destinationPath}.${randomUUID()}.tmp`;
  try {
    await copyFileImpl(sourcePath, destinationTempPath);
    const latestSourceStat = await stat(sourcePath);
    if (latestSourceStat.size !== sourceStat.size || latestSourceStat.mtimeMs !== sourceStat.mtimeMs) {
      throw new TranscriptChangedDuringCopyError("transcript changed during archive copy");
    }
    await utimes(destinationTempPath, sourceStat.atimeMs / 1000, sourceStat.mtimeMs / 1000);
    await rename(destinationTempPath, destinationPath);
  } catch (error) {
    try {
      await unlink(destinationTempPath);
    } catch (cleanupError) {
      if (!(cleanupError && typeof cleanupError === "object" && "code" in cleanupError && cleanupError.code === "ENOENT")) {
        throw new AggregateError([error, cleanupError], "transcript archive copy and cleanup failed");
      }
    }
    throw error;
  }
}

async function writeFailureLog(projectDirectory, error) {
  const logsDirectory = join(projectDirectory, ".wasurenagusa", "logs");
  const errorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : error instanceof Error
      ? error.name
      : "UNKNOWN";
  const logEntry = {
    ts: getJstTimestamp(),
    operation_type: "archive_transcripts",
    status: "failed",
    error_code: errorCode,
  };

  await mkdir(logsDirectory, { recursive: true });
  await appendFile(join(logsDirectory, `operation-${getJstDatePart()}.jsonl`), `${JSON.stringify(logEntry)}\n`, "utf8");
}

async function writeSkippedFilesLog(projectDirectory, skippedCount) {
  const logsDirectory = join(projectDirectory, ".wasurenagusa", "logs");
  const logEntry = {
    ts: getJstTimestamp(),
    operation_type: "archive_transcripts",
    status: "completed_with_skips",
    skipped_count: skippedCount,
  };

  await mkdir(logsDirectory, { recursive: true });
  await appendFile(join(logsDirectory, `operation-${getJstDatePart()}.jsonl`), `${JSON.stringify(logEntry)}\n`, "utf8");
}

async function listTopLevelTranscripts(transcriptsDirectory) {
  try {
    const entries = await readdir(transcriptsDirectory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function archiveDirectory({ transcriptsDirectory, destinationDirectory, dryRun, copyFileImpl = copyFile }) {
  const transcriptEntries = await listTopLevelTranscripts(transcriptsDirectory);
  if (transcriptEntries === null) {
    return { plannedCount: 0, copiedCount: 0, skippedCount: 0, filenames: [], plannedFilenames: [] };
  }
  const pendingCopies = [];

  for (const entry of transcriptEntries) {
    const sourcePath = join(transcriptsDirectory, entry.name);
    const destinationPath = join(destinationDirectory, entry.name);
    const sourceStat = await stat(sourcePath);
    const destinationStat = await readDestinationStat(destinationPath);
    if (!hasSameSnapshot(sourceStat, destinationStat)) {
      pendingCopies.push({ sourcePath, destinationPath, sourceStat });
    }
  }

  if (dryRun) {
    return {
      plannedCount: pendingCopies.length,
      copiedCount: 0,
      skippedCount: 0,
      filenames: transcriptEntries.map((entry) => entry.name),
      plannedFilenames: pendingCopies.map((pendingCopy) => basename(pendingCopy.sourcePath)),
    };
  }

  if (pendingCopies.length > 0) {
    await mkdir(destinationDirectory, { recursive: true });
  }
  let copiedCount = 0;
  let skippedCount = 0;
  for (const pendingCopy of pendingCopies) {
    try {
      await copyTranscript(pendingCopy.sourcePath, pendingCopy.destinationPath, pendingCopy.sourceStat, copyFileImpl);
      copiedCount += 1;
    } catch (error) {
      if (!(error instanceof TranscriptChangedDuringCopyError)) throw error;
      skippedCount += 1;
    }
  }

  const archiveUsage = await getArchiveUsage(destinationDirectory);
  if (archiveUsage.totalBytes > MAX_ARCHIVE_BYTES && Number.isFinite(archiveUsage.oldestMtime)) {
    const oldestMonth = new Date(archiveUsage.oldestMtime).toISOString().slice(0, 7);
    process.stderr.write(`WARN: transcript archive exceeds 2 GiB; oldest month=${oldestMonth}\n`);
  }

  return {
    plannedCount: pendingCopies.length,
    copiedCount,
    skippedCount,
    filenames: transcriptEntries.map((entry) => entry.name),
    plannedFilenames: pendingCopies.map((pendingCopy) => basename(pendingCopy.sourcePath)),
  };
}

async function listSourceDirectories(projectsDirectory) {
  try {
    const entries = await readdir(projectsDirectory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        launchDir: launchDirectoryName(entry.name),
        transcriptsDirectory: join(projectsDirectory, entry.name),
      }))
      .sort((left, right) => left.launchDir.localeCompare(right.launchDir));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

function sessionIndexKey(launchDir, sessionId) {
  return `${launchDir}\u0000${sessionId}`;
}

async function collectSessionIndex({ archiveRoot, sourceDirectories, homeDirectory, includeUnarchived }) {
  const previousIndex = await readSessionIndex(join(archiveRoot, "sessions-index.json"));
  const previousEntries = new Map((previousIndex?.sessions ?? [])
    .map((entry) => [sessionIndexKey(entry.launchDir, entry.sessionId), entry]));
  const sourceByLaunchDir = new Map(sourceDirectories.map((source) => [source.launchDir, source.transcriptsDirectory]));
  const sessions = new Map();

  for (const source of sourceDirectories) {
    const sourceEntries = await listTopLevelTranscripts(source.transcriptsDirectory);
    if (sourceEntries === null) continue;
    for (const entry of sourceEntries) {
      const sessionId = basename(entry.name, ".jsonl");
      const key = sessionIndexKey(source.launchDir, sessionId);
      const archivedPath = join(archiveRoot, source.launchDir, entry.name);
      const sourcePath = join(source.transcriptsDirectory, entry.name);
      let transcriptPath = sourcePath;
      if (!includeUnarchived) {
        try {
          await stat(archivedPath);
          transcriptPath = archivedPath;
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
          continue;
        }
      }
      const inferred = await inferSessionProject({
        transcriptPath,
        subagentsDirectory: join(source.transcriptsDirectory, sessionId, "subagents"),
        launchDir: source.launchDir,
        homeDirectory,
      });
      sessions.set(key, { sessionId, launchDir: source.launchDir, ...inferred });
    }
  }

  let archiveDirectories = [];
  try {
    archiveDirectories = (await readdir(archiveRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }

  for (const launchDir of archiveDirectories) {
    const archivedFiles = await listTopLevelTranscripts(join(archiveRoot, launchDir));
    if (archivedFiles === null) continue;
    for (const entry of archivedFiles) {
      const sessionId = basename(entry.name, ".jsonl");
      const key = sessionIndexKey(launchDir, sessionId);
      if (sessions.has(key)) continue;
      const previousEntry = previousEntries.get(key);
      if (previousEntry) {
        sessions.set(key, previousEntry);
        continue;
      }
      const sourceDirectory = sourceByLaunchDir.get(launchDir);
      const inferred = await inferSessionProject({
        transcriptPath: join(archiveRoot, launchDir, entry.name),
        subagentsDirectory: sourceDirectory ? join(sourceDirectory, sessionId, "subagents") : join(archiveRoot, launchDir, sessionId, "subagents"),
        launchDir,
        homeDirectory,
      });
      sessions.set(key, { sessionId, launchDir, ...inferred });
    }
  }

  return [...sessions.values()].sort((left, right) => left.launchDir.localeCompare(right.launchDir)
    || left.sessionId.localeCompare(right.sessionId));
}

function projectSessionCounts(sessions) {
  const counts = {};
  for (const session of sessions) {
    counts[session.project] = (counts[session.project] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function launchProjectSessionCounts(sessions) {
  const counts = new Map();
  for (const session of sessions) {
    const key = `${session.launchDir}\u0000${session.project}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [launchDir, project] = key.split("\u0000");
      return { launchDir, project, sessions: count };
    })
    .sort((left, right) => left.launchDir.localeCompare(right.launchDir) || left.project.localeCompare(right.project));
}

function countPlannedCopiesByProject(sessions, plannedSessionKeys) {
  const counts = {};
  for (const session of sessions) {
    counts[session.project] = counts[session.project] ?? 0;
    const key = sessionIndexKey(session.launchDir, session.sessionId);
    if (plannedSessionKeys.has(key)) counts[session.project] += 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

async function countDirectoryPlannedCopiesByProject({ transcriptsDirectory, launchDir, plannedFilenames, homeDirectory }) {
  const counts = {};
  if (plannedFilenames.length === 0) return { [launchDir]: 0 };

  for (const filename of plannedFilenames) {
    const sessionId = basename(filename, ".jsonl");
    const inferred = await inferSessionProject({
      transcriptPath: join(transcriptsDirectory, filename),
      subagentsDirectory: join(transcriptsDirectory, sessionId, "subagents"),
      launchDir,
      homeDirectory,
    });
    counts[inferred.project] = (counts[inferred.project] ?? 0) + 1;
  }

  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

async function writeSessionIndex(archiveRoot, sessions) {
  if (sessions.length === 0) return;
  await mkdir(archiveRoot, { recursive: true });
  await writeFile(join(archiveRoot, "sessions-index.json"), `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`, "utf8");
}

async function archiveAll({ projectDirectory, projectsDirectory, homeDirectory, dryRun, copyFileImpl }) {
  const projectRoot = resolve(projectDirectory);
  const archiveRoot = join(projectRoot, ".wasurenagusa", "transcripts-archive");
  const resolvedHomeDirectory = resolve(homeDirectory ?? homedir());
  const resolvedProjectsDirectory = resolve(projectsDirectory ?? join(resolvedHomeDirectory, ".claude", "projects"));
  const sourceDirectories = await listSourceDirectories(resolvedProjectsDirectory);
  const launchDirectories = [];
  const plannedSessionKeys = new Set();
  let plannedCount = 0;
  let copiedCount = 0;
  let skippedCount = 0;

  for (const source of sourceDirectories) {
    const result = await archiveDirectory({
      transcriptsDirectory: source.transcriptsDirectory,
      destinationDirectory: join(archiveRoot, source.launchDir),
      dryRun,
      copyFileImpl,
    });
    plannedCount += result.plannedCount;
    copiedCount += result.copiedCount;
    skippedCount += result.skippedCount;
    for (const filename of result.plannedFilenames) {
      plannedSessionKeys.add(sessionIndexKey(source.launchDir, basename(filename, ".jsonl")));
    }
    launchDirectories.push({
      launchDir: source.launchDir,
      plannedCount: result.plannedCount,
      copiedCount: result.copiedCount,
    });
  }

  const sessions = await collectSessionIndex({
    archiveRoot,
    sourceDirectories,
    homeDirectory: resolvedHomeDirectory,
    includeUnarchived: dryRun,
  });
  if (!dryRun) await writeSessionIndex(archiveRoot, sessions);

  return {
    plannedCount,
    copiedCount,
    skippedCount,
    launchDirectories,
    projectCounts: projectSessionCounts(sessions),
    launchProjectCounts: launchProjectSessionCounts(sessions),
    plannedProjectCounts: countPlannedCopiesByProject(sessions, plannedSessionKeys),
  };
}

async function archiveTranscripts({
  projectDirectory = process.cwd(),
  sourceDirectory,
  projectsDirectory,
  homeDirectory,
  all = false,
  dryRun = false,
  copyFileImpl = copyFile,
} = {}) {
  const paths = getDefaultArchivePaths(projectDirectory);
  const projectRoot = paths.projectDirectory;

  try {
    let result;
    if (all) {
      result = await archiveAll({ projectDirectory: projectRoot, projectsDirectory, homeDirectory, dryRun, copyFileImpl });
    } else {
      const transcriptsDirectory = resolve(sourceDirectory ?? paths.sourceDirectory);
      const directoryResult = await archiveDirectory({
        transcriptsDirectory,
        destinationDirectory: paths.destinationDirectory,
        dryRun,
        copyFileImpl,
      });
      if (!dryRun && directoryResult.filenames.length > 0) {
        const launchDir = basename(paths.destinationDirectory);
        const sessions = await collectSessionIndex({
          archiveRoot: join(projectRoot, ".wasurenagusa", "transcripts-archive"),
          sourceDirectories: [{ launchDir, transcriptsDirectory }],
          homeDirectory: resolve(homeDirectory ?? homedir()),
          includeUnarchived: false,
        });
        await writeSessionIndex(join(projectRoot, ".wasurenagusa", "transcripts-archive"), sessions);
      }
      result = {
        plannedCount: directoryResult.plannedCount,
        copiedCount: directoryResult.copiedCount,
        skippedCount: directoryResult.skippedCount,
      };
      if (dryRun) {
        result.plannedProjectCounts = await countDirectoryPlannedCopiesByProject({
          transcriptsDirectory,
          launchDir: basename(paths.destinationDirectory),
          plannedFilenames: directoryResult.plannedFilenames,
          homeDirectory: resolve(homeDirectory ?? homedir()),
        });
      }
    }
    if (!dryRun && result.skippedCount > 0) await writeSkippedFilesLog(projectRoot, result.skippedCount);
    return result;
  } catch (error) {
    if (!dryRun) {
      try {
        await writeFailureLog(projectRoot, error);
      } catch (logError) {
        throw new AggregateError([error, logError], "transcript archive failed and operation log could not be written");
      }
    }
    throw error;
  }
}

function formatAllArchiveSummary(result, dryRun) {
  const mode = dryRun ? "dry-run" : "archived";
  const launchLines = result.launchDirectories.map(({ launchDir, plannedCount, copiedCount }) => (
    `launchDir=${launchDir} plannedCopies=${plannedCount} copied=${copiedCount}`
  ));
  const projectLines = Object.entries(result.projectCounts)
    .map(([project, count]) => `project=${project} sessions=${count} plannedCopies=${result.plannedProjectCounts[project] ?? 0}`);
  const launchProjectLines = result.launchProjectCounts
    .map(({ launchDir, project, sessions }) => `launchProject=${launchDir} project=${project} sessions=${sessions}`);
  return [`mode=${mode} skipped=${result.skippedCount}`, ...launchLines, ...projectLines, ...launchProjectLines].join("\n") + "\n";
}

function writeAllArchiveSummary(result, dryRun, stdout = process.stdout) {
  stdout.write(formatAllArchiveSummary(result, dryRun));
}

async function main() {
  const options = parseArchiveArguments(process.argv.slice(2));
  const result = await archiveTranscripts(options);
  if (options.all) {
    writeAllArchiveSummary(result, options.dryRun);
    return;
  }
  if (options.dryRun) {
    const projectLines = Object.entries(result.plannedProjectCounts)
      .map(([project, count]) => `project=${project} plannedCopies=${count}`);
    process.stdout.write(`${projectLines.join("\n")}\n`);
    return;
  }
  process.stdout.write(`${options.dryRun ? result.plannedCount : result.copiedCount}\n`);
  if (!options.dryRun && result.skippedCount > 0) process.stdout.write(`skipped=${result.skippedCount}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    const errorDetails = error instanceof Error ? error.stack || `${error.name}: ${error.message}` : String(error);
    process.stderr.write(`archive failed: ${errorDetails}\n`);
    process.exitCode = 1;
  });
}

export { archiveTranscripts, formatAllArchiveSummary, getDefaultArchivePaths, parseArchiveArguments, writeAllArchiveSummary };
