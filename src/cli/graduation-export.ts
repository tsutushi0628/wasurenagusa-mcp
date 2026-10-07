#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { config, getCliMemoryDirectory } from "../config.js";
import { readCorrectionFeatureModes } from "../corrections/environment-mode.js";
import { createCorrectionGraduationProposal } from "../corrections/graduation.js";
import { CORRECTION_PRINCIPLES_SCHEMA_VERSION } from "../storage/correction-schema.js";
import { getSchemaVersion } from "../storage/schema.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { isMainModule, reportCliFailure } from "../utils/cli-entry.js";
import { findProjectRoot } from "../utils/projectRoot.js";

export interface GraduationExportArguments {
  outputPath?: string;
}

export interface GraduationExportResult {
  mode: "off" | "on";
  status: "disabled" | "schema_unavailable" | "written";
  skippedReason?: "correction_loop_off" | "feature_off";
  generatedAt?: string;
  principleCount: number;
  outputPath?: string;
}

export function parseGraduationExportArguments(args: string[]): GraduationExportArguments {
  let outputPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== "--out") throw new Error("unsupported graduation-export argument");
    if (outputPath !== undefined) throw new Error("--out cannot be repeated");
    if (index + 1 >= args.length || args[index + 1].startsWith("--") || args[index + 1] === "") {
      throw new Error("--out requires one path");
    }
    outputPath = args[index + 1];
    index += 1;
  }
  return outputPath === undefined ? {} : { outputPath };
}

function findPackageRoot(startPath: string): string {
  let currentPath = resolve(startPath);
  while (true) {
    if (existsSync(join(currentPath, "package.json"))) return currentPath;
    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) throw new Error("graduation-export package root was not found");
    currentPath = parentPath;
  }
}

function readSourceHead(packageRoot: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function readSchemaVersion(storage: SQLiteStorage): number {
  return storage.runCorrectionTransaction(({ db }) => getSchemaVersion(db as unknown as Database.Database));
}

export function runGraduationExportCli(args: string[] = process.argv.slice(2)): GraduationExportResult {
  const parsedArgs = parseGraduationExportArguments(args);
  const featureModes = readCorrectionFeatureModes();
  const mode = featureModes.graduation;
  if (featureModes.correctionLoop === "off" || mode === "off") {
    return {
      mode,
      status: "disabled",
      principleCount: 0,
      skippedReason: featureModes.correctionLoop === "off" ? "correction_loop_off" : "feature_off",
    };
  }

  const packageRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
  const memoryPath = getCliMemoryDirectory(findProjectRoot(process.cwd()));
  const dbPath = resolve(memoryPath, config.sqliteFile);
  if (!existsSync(dbPath)) throw new Error("graduation-export memory store does not exist");

  const storage = SQLiteStorage.openExistingForHook(dbPath, { mode: "correction" });
  try {
    if (readSchemaVersion(storage) < CORRECTION_PRINCIPLES_SCHEMA_VERSION) {
      return { mode, status: "schema_unavailable", principleCount: 0 };
    }
    const generatedAt = new Date().toISOString();
    const outputPath = parsedArgs.outputPath === undefined
      ? join(memoryPath, "reports", "graduation", `proposal-${generatedAt.slice(0, 10)}.json`)
      : resolve(parsedArgs.outputPath);
    mkdirSync(dirname(outputPath), { recursive: true });
    const proposal = createCorrectionGraduationProposal(storage, {
      at: generatedAt,
      sourceHead: readSourceHead(packageRoot),
    }, (generatedProposal) => {
      writeFileSync(outputPath, `${JSON.stringify(generatedProposal, null, 2)}\n`, "utf8");
    });
    if (proposal === null) return { mode, status: "schema_unavailable", principleCount: 0 };
    return {
      mode,
      status: "written",
      generatedAt,
      principleCount: proposal.principles.length,
      outputPath,
    };
  } finally {
    storage.close();
  }
}

if (isMainModule(import.meta.url)) {
  try {
    const result = runGraduationExportCli();
    process.stdout.write(`${JSON.stringify({
      mode: result.mode,
      status: result.status,
      skipped_reason: result.skippedReason,
      generated_at: result.generatedAt,
      principles: result.principleCount,
    })}\n`);
  } catch (error) {
    reportCliFailure("graduation-export", error);
  }
}
