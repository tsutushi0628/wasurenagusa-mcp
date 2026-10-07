#!/usr/bin/env node
import { existsSync } from "fs";
import { resolve } from "path";
import { config, getCliMemoryDirectory } from "../config.js";
import { readCorrectionFeatureModes } from "../corrections/environment-mode.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { isMainModule, reportCliFailure } from "../utils/cli-entry.js";
import { findProjectRoot } from "../utils/projectRoot.js";
import { runStrengthJob, type StrengthJobSummary } from "../corrections/strength.js";

export interface StrengthJobCliSummary extends StrengthJobSummary {
  skippedReason?: "correction_loop_off" | "feature_off";
}

export interface StrengthJobArguments {
  now: string;
}

export function parseStrengthJobArguments(args: string[]): StrengthJobArguments {
  let now: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== "--now") throw new Error("unsupported strength-job argument");
    if (now !== undefined || index + 1 >= args.length || args[index + 1].startsWith("--")) {
      throw new Error("--now requires one timestamp and cannot be repeated");
    }
    const parsedTime = Date.parse(args[index + 1]);
    if (!Number.isFinite(parsedTime)) throw new Error("--now requires a valid timestamp");
    now = new Date(parsedTime).toISOString();
    index += 1;
  }
  if (now === undefined) now = new Date().toISOString();
  return { now };
}

export function runStrengthJobCli(args: string[] = process.argv.slice(2)): StrengthJobCliSummary {
  const { now } = parseStrengthJobArguments(args);
  const featureModes = readCorrectionFeatureModes();
  const mode = featureModes.strength;
  if (featureModes.correctionLoop === "off" || mode === "off") {
    return {
      mode,
      bundlesExamined: 0,
      eventsRecorded: 0,
      intensityChanges: 0,
      failureEvents: 0,
      settledEvents: 0,
      idleEvents: 0,
      skippedReason: featureModes.correctionLoop === "off" ? "correction_loop_off" : "feature_off",
    };
  }

  const memoryPath = getCliMemoryDirectory(findProjectRoot(process.cwd()));
  const dbPath = resolve(memoryPath, config.sqliteFile);
  if (!existsSync(dbPath)) throw new Error("strength-job memory store does not exist");

  const storage = SQLiteStorage.openExistingForHook(dbPath, { mode: "correction" });
  try {
    return runStrengthJob(storage, { now, mode });
  } finally {
    storage.close();
  }
}

if (isMainModule(import.meta.url)) {
  try {
    const result = runStrengthJobCli();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    reportCliFailure("strength-job", error);
  }
}
