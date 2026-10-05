#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SESSION_BASIS = new Set(["written_files", "worklog_only", "launch_dir"]);

export function launchDirectoryName(directoryName) {
  const marker = "-projects-";
  const markerIndex = directoryName.indexOf(marker);
  if (markerIndex >= 0) {
    const suffix = directoryName.slice(markerIndex + marker.length);
    if (suffix.length > 0) return suffix;
  }
  return directoryName;
}

function isMissingPath(error) {
  return error && typeof error === "object" && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

async function realpathWithMissingTail(filename) {
  let currentPath = resolve(filename);
  const missingParts = [];

  while (true) {
    try {
      const currentRealpath = await realpath(currentPath);
      return resolve(currentRealpath, ...missingParts);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      const parentPath = dirname(currentPath);
      if (parentPath === currentPath) throw error;
      missingParts.unshift(basename(currentPath));
      currentPath = parentPath;
    }
  }
}

function projectNameFromPath(filename, projectsRoot) {
  const relativePath = relative(projectsRoot, filename);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return null;
  }
  const parts = relativePath.split(sep);
  if (parts.length < 2 || parts[0] === "" || parts[0] === "." || parts[0] === "..") return null;
  if (parts.slice(1).includes(".tmp")) return null;
  return parts[0];
}

function isWorklogPath(filename, projectRoot) {
  const relativePath = relative(projectRoot, filename);
  const parts = relativePath.split(sep);
  return parts.length === 3
    && parts[0] === "docs"
    && parts[1] === "findings"
    && parts[2].startsWith("worklog-");
}

function toolUsePaths(row) {
  if (row.type !== "assistant") return [];
  const blocks = row.message && typeof row.message === "object" ? row.message.content : null;
  if (!Array.isArray(blocks)) return [];
  const paths = [];

  for (const block of blocks) {
    if (!block || typeof block !== "object" || block.type !== "tool_use" || !WRITE_TOOLS.has(block.name)) continue;
    const toolInput = block.input && typeof block.input === "object" ? block.input : {};
    const filename = toolInput.file_path || toolInput.notebook_path;
    if (typeof filename === "string" && isAbsolute(filename)) paths.push(filename);
  }

  return paths;
}

async function readWriteVotes(filename, projectsRoot, cache, sequence) {
  const reader = createInterface({
    input: createReadStream(filename, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  const votes = [];

  for await (const line of reader) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    for (const writtenPath of toolUsePaths(row)) {
      let canonicalPath = cache.get(writtenPath);
      if (canonicalPath === undefined) {
        canonicalPath = await realpathWithMissingTail(writtenPath);
        cache.set(writtenPath, canonicalPath);
      }
      const project = projectNameFromPath(canonicalPath, projectsRoot);
      if (!project) continue;
      const projectRoot = join(projectsRoot, project);
      votes.push({
        project,
        weak: isWorklogPath(canonicalPath, projectRoot),
        order: sequence.value,
      });
      sequence.value += 1;
    }
  }

  return votes;
}

function countVotes(votes, isWeak) {
  const counts = new Map();
  for (const vote of votes) {
    if (vote.weak !== isWeak) continue;
    counts.set(vote.project, (counts.get(vote.project) ?? 0) + 1);
  }
  return counts;
}

function chooseProject(counts, firstSeen) {
  let selectedProject = null;
  let selectedCount = -1;
  let selectedOrder = Number.POSITIVE_INFINITY;

  for (const [project, count] of counts) {
    const order = firstSeen.get(project);
    if (count > selectedCount || (count === selectedCount && order < selectedOrder)) {
      selectedProject = project;
      selectedCount = count;
      selectedOrder = order;
    }
  }

  return selectedProject;
}

export async function inferSessionProject({
  transcriptPath,
  subagentsDirectory,
  launchDir,
  homeDirectory = homedir(),
}) {
  if (typeof launchDir !== "string" || launchDir.length === 0) {
    throw new Error("launchDir is required");
  }
  let projectsRoot = resolve(homeDirectory, "projects");
  try {
    projectsRoot = await realpath(projectsRoot);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
  const transcriptFiles = [transcriptPath];
  try {
    const entries = await readdir(subagentsDirectory, { withFileTypes: true });
    transcriptFiles.push(...entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(subagentsDirectory, entry.name))
      .sort());
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }

  const cache = new Map();
  const sequence = { value: 0 };
  const votes = [];
  for (const filename of transcriptFiles) {
    votes.push(...await readWriteVotes(filename, projectsRoot, cache, sequence));
  }
  const allVotes = new Map();
  const strongVotes = countVotes(votes, false);
  const weakVotes = countVotes(votes, true);
  const firstStrongSeen = new Map();
  const firstWeakSeen = new Map();
  for (const vote of votes) {
    allVotes.set(vote.project, (allVotes.get(vote.project) ?? 0) + 1);
    const firstSeen = vote.weak ? firstWeakSeen : firstStrongSeen;
    if (!firstSeen.has(vote.project)) firstSeen.set(vote.project, vote.order);
  }

  const project = strongVotes.size > 0
    ? chooseProject(strongVotes, firstStrongSeen)
    : chooseProject(weakVotes, firstWeakSeen);
  const basis = strongVotes.size > 0 ? "written_files" : weakVotes.size > 0 ? "worklog_only" : "launch_dir";

  return {
    project: project ?? launchDir,
    basis,
    projects: Object.fromEntries(allVotes),
  };
}

export function sessionIndexFilePath(transcriptsDirectory) {
  return join(dirname(resolve(transcriptsDirectory)), "sessions-index.json");
}

function isSingleName(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("/") && !value.includes("\\")
    && value !== "." && value !== ".." && !value.includes("\n") && !value.includes("\r");
}

export function validateProjectName(value) {
  if (!isSingleName(value)) throw new Error("--project requires a single project name");
  return value;
}

function validateSessionIndex(index) {
  if (!index || typeof index !== "object" || Array.isArray(index) || index.version !== 1 || !Array.isArray(index.sessions)) {
    throw new Error("sessions-index.json has an invalid structure");
  }

  const sessions = index.sessions.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || !isSingleName(entry.sessionId) || !isSingleName(entry.launchDir) || !isSingleName(entry.project)
      || !SESSION_BASIS.has(entry.basis) || !entry.projects || typeof entry.projects !== "object" || Array.isArray(entry.projects)) {
      throw new Error("sessions-index.json contains an invalid session entry");
    }
    const projects = {};
    for (const [project, count] of Object.entries(entry.projects)) {
      if (!isSingleName(project) || !Number.isSafeInteger(count) || count < 0) {
        throw new Error("sessions-index.json contains an invalid project vote");
      }
      projects[project] = count;
    }
    return {
      sessionId: entry.sessionId,
      launchDir: entry.launchDir,
      project: entry.project,
      basis: entry.basis,
      projects,
    };
  });

  return { version: 1, sessions };
}

export async function readSessionIndex(indexPath) {
  let content;
  try {
    content = await readFile(indexPath, "utf8");
  } catch (error) {
    if (isMissingPath(error)) return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("sessions-index.json contains invalid JSON");
  }
  return validateSessionIndex(parsed);
}

export async function readSessionIndexForTranscripts(transcriptsDirectory, { required = false } = {}) {
  const indexPath = sessionIndexFilePath(transcriptsDirectory);
  const index = await readSessionIndex(indexPath);
  if (!index && required) throw new Error("--project requires sessions-index.json next to the archive directory");
  return index;
}

export function sessionIndexEntry(index, sessionId, launchDir) {
  if (!index) return null;
  return index.sessions.find((entry) => entry.sessionId === sessionId && entry.launchDir === launchDir) ?? null;
}
