#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { config, getCliMemoryDirectory } from "../config.js";
import { computeCorrectionFunnel } from "../corrections/funnel.js";
import { isMainModule, reportCliFailure } from "../utils/cli-entry.js";
import { findProjectRoot } from "../utils/projectRoot.js";

export interface CorrectionFunnelArguments {
  since: string;
  until: string;
  memoryDirectory?: string;
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

export function parseCorrectionFunnelArguments(args: string[]): CorrectionFunnelArguments {
  let since: string | undefined;
  let until: string | undefined;
  let memoryDirectory: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--since" || argument === "--until" || argument === "--memory-dir") {
      if (index + 1 >= args.length || args[index + 1].startsWith("--") || args[index + 1] === "") {
        throw new Error(`${argument} requires one value`);
      }
      const value = args[index + 1];
      if (argument === "--since") {
        if (since !== undefined) throw new Error("--since cannot be repeated");
        if (!validTimestamp(value)) throw new Error("--since requires an ISO timestamp");
        since = value;
      } else if (argument === "--until") {
        if (until !== undefined) throw new Error("--until cannot be repeated");
        if (!validTimestamp(value)) throw new Error("--until requires an ISO timestamp");
        until = value;
      } else {
        if (memoryDirectory !== undefined) throw new Error("--memory-dir cannot be repeated");
        memoryDirectory = value;
      }
      index += 1;
      continue;
    }
    if (argument === "--json") {
      if (json) throw new Error("--json cannot be repeated");
      json = true;
      continue;
    }
    throw new Error("unsupported correction-funnel argument");
  }
  if (since === undefined) throw new Error("--since is required");
  if (until === undefined) throw new Error("--until is required");
  if (!json) throw new Error("--json is required");
  return {
    since,
    until,
    ...(memoryDirectory === undefined ? {} : { memoryDirectory }),
  };
}

function openReadonlyDatabase(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

export function runCorrectionFunnelCli(args: string[] = process.argv.slice(2)) {
  const parsed = parseCorrectionFunnelArguments(args);
  const memoryDirectory = parsed.memoryDirectory === undefined
    ? getCliMemoryDirectory(findProjectRoot(process.cwd()))
    : resolve(parsed.memoryDirectory);
  const dbPath = resolve(memoryDirectory, config.sqliteFile);
  if (!existsSync(dbPath)) throw new Error("correction-funnel memory store does not exist");
  const db = openReadonlyDatabase(dbPath);
  try {
    db.pragma("query_only = ON");
    return computeCorrectionFunnel(db, { since: parsed.since, until: parsed.until });
  } finally {
    db.close();
  }
}

if (isMainModule(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(runCorrectionFunnelCli())}\n`);
  } catch (error) {
    reportCliFailure("correction-funnel", error);
  }
}
