#!/usr/bin/env node

import { createHash } from "node:crypto";
import { open, mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { extractHumanUtterance, jstDate } from "./lib/analysis.mjs";
import { readManifest } from "./lib/simulate-engine.mjs";

const DATE_START = "2026-09-22";
const DATE_END = "2026-10-02";
const DEFAULT_EXCLUDE_PREFIXES = ["dccb7da4", "57b0207c"];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseMakeManifestArguments(args) {
  const options = { excludePrefixes: [...DEFAULT_EXCLUDE_PREFIXES] };
  let hasExcludePrefixArgument = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (["--transcripts", "--out", "--exclude-prefix"].includes(argument)) {
      const value = args[index + 1];
      if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;
      if (argument === "--transcripts") {
        options.transcriptsDirectory = value;
      } else if (argument === "--out") {
        options.outputPath = value;
      } else {
        if (!hasExcludePrefixArgument) {
          options.excludePrefixes = [];
        }
        options.excludePrefixes.push(value);
        hasExcludePrefixArgument = true;
      }
      continue;
    }
    throw new Error(`unsupported argument: ${argument}`);
  }

  if (!options.transcriptsDirectory || !options.outputPath) {
    throw new Error("--transcripts <dir> and --out <path> are required");
  }
  return options;
}

async function readFixedSnapshot(filename) {
  const handle = await open(filename, "r");
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || !Number.isSafeInteger(fileStat.size) || fileStat.size < 0) {
      throw new Error("transcript must be a regular file with a safe size");
    }
    const source = Buffer.alloc(fileStat.size);
    let total = 0;
    while (total < fileStat.size) {
      const result = await handle.read(source, total, fileStat.size - total, total);
      if (result.bytesRead === 0) {
        break;
      }
      total += result.bytesRead;
    }
    if (total !== fileStat.size) {
      throw new Error("transcript changed during snapshot read");
    }

    const completeLength = source.lastIndexOf(0x0a) + 1;
    const snapshot = source.subarray(0, completeLength);
    return {
      snapshot,
      readEndByteOffset: completeLength,
      prefixSha256: sha256(snapshot),
    };
  } finally {
    await handle.close();
  }
}

function inspectSnapshot(snapshot, fallbackSessionId) {
  let sessionId = fallbackSessionId;
  let humanUtteranceCount = 0;
  let inPeriodHumanUtteranceCount = 0;
  let lineOrder = 0;
  let offset = 0;

  while (offset < snapshot.length) {
    lineOrder += 1;
    const lineEnd = snapshot.indexOf(0x0a, offset);
    const line = snapshot.subarray(offset, lineEnd).toString("utf8").replace(/\r$/u, "");
    offset = lineEnd + 1;
    if (!line.trim()) {
      continue;
    }

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error(`transcript contains invalid JSONL at line ${lineOrder}`);
    }
    if (!event || typeof event !== "object") {
      throw new Error("transcript JSONL row must be an object");
    }
    if (typeof event.sessionId === "string") {
      sessionId = event.sessionId;
    }

    const utterance = extractHumanUtterance(event);
    if (!utterance) {
      continue;
    }
    humanUtteranceCount += 1;
    const date = jstDate(event.timestamp);
    if (date && date >= DATE_START && date <= DATE_END) {
      inPeriodHumanUtteranceCount += 1;
    }
  }

  return { sessionId, humanUtteranceCount, inPeriodHumanUtteranceCount };
}

async function makeManifest({ transcriptsDirectory, outputPath, excludePrefixes = DEFAULT_EXCLUDE_PREFIXES }) {
  const transcriptsRoot = resolve(transcriptsDirectory);
  const manifestPath = resolve(outputPath);
  const filenames = (await readdir(transcriptsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name)
    .sort();
  if (filenames.length === 0) {
    throw new Error("transcripts directory contains no JSONL files");
  }
  const files = [];
  const sessions = [];
  const fileAudit = {
    fileCount: filenames.length,
    included: 0,
    excluded: 0,
    noHuman: 0,
    outsidePeriod: 0,
  };

  for (const filename of filenames) {
    const fileId = basename(filename, ".jsonl");
    const sourcePath = resolve(transcriptsRoot, filename);
    const fixed = await readFixedSnapshot(sourcePath);
    const parsed = inspectSnapshot(fixed.snapshot, fileId);
    let disposition;
    if (excludePrefixes.some((prefix) => parsed.sessionId.startsWith(prefix))) {
      disposition = "excluded";
    } else if (parsed.humanUtteranceCount === 0) {
      disposition = "no-human";
    } else if (parsed.inPeriodHumanUtteranceCount === 0) {
      disposition = "outside-period";
    } else {
      disposition = "included";
    }

    const metadata = {
      fileId,
      readEndByteOffset: fixed.readEndByteOffset,
      prefixSha256: fixed.prefixSha256,
      disposition,
      humanUtteranceCount: parsed.humanUtteranceCount,
      inPeriodHumanUtteranceCount: parsed.inPeriodHumanUtteranceCount,
    };
    files.push(metadata);
    if (disposition === "included") {
      sessions.push({
        sessionId: parsed.sessionId,
        sessionHash: sha256(parsed.sessionId),
        fileId,
        path: sourcePath,
        readEndByteOffset: fixed.readEndByteOffset,
        prefixSha256: fixed.prefixSha256,
      });
      fileAudit.included += 1;
    } else if (disposition === "excluded") {
      fileAudit.excluded += 1;
    } else if (disposition === "no-human") {
      fileAudit.noHuman += 1;
    } else {
      fileAudit.outsidePeriod += 1;
    }
  }

  const manifest = { version: 1, sessions, files, fileAudit };
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const validated = await readManifest(manifestPath);
  return {
    fileAudit: validated.fileAudit,
    periodSessionCount: validated.sessions.length,
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseMakeManifestArguments(process.argv.slice(2));
    const result = await makeManifest(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export { makeManifest, parseMakeManifestArguments };
