#!/usr/bin/env node
import { join } from "path";
import { config, getMemoryPath } from "../config.js";
import {
  CorrectionImportError,
  importCorrectionMemories,
  migrateCorrectionComplianceDatabase,
  migrateCorrectionDatabase,
} from "../corrections/import.js";
import { isDirectRun } from "../utils/cli-entry.js";
import { findProjectRoot } from "../utils/projectRoot.js";

type ParsedArguments = {
  sourcePath?: string;
  apply: boolean;
  migrateV11: boolean;
  migrateV12: boolean;
};

export type CorrectionImportCliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function parseArguments(args: string[]): ParsedArguments {
  let sourcePath: string | undefined;
  let apply = false;
  let migrateV11 = false;
  let migrateV12 = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--source") {
      if (sourcePath !== undefined || index + 1 >= args.length || args[index + 1].startsWith("--")) {
        throw new CorrectionImportError("--source requires one database path");
      }
      sourcePath = args[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--apply") {
      if (apply) {
        throw new CorrectionImportError("--apply cannot be repeated");
      }
      apply = true;
      continue;
    }
    if (argument === "--migrate-v11") {
      if (migrateV11) {
        throw new CorrectionImportError("--migrate-v11 cannot be repeated");
      }
      migrateV11 = true;
      continue;
    }
    if (argument === "--migrate-v12") {
      if (migrateV12) {
        throw new CorrectionImportError("--migrate-v12 cannot be repeated");
      }
      migrateV12 = true;
      continue;
    }
    throw new CorrectionImportError("unsupported argument");
  }

  if (migrateV11 && migrateV12) {
    throw new CorrectionImportError("choose either --source or one migration");
  }
  if ((migrateV11 && sourcePath !== undefined) || (!migrateV11 && !migrateV12 && sourcePath === undefined)) {
    throw new CorrectionImportError("choose either --source or --migrate-v11");
  }
  if (migrateV12 && sourcePath !== undefined) {
    throw new CorrectionImportError("choose either --source or --migrate-v12");
  }
  return { sourcePath, apply, migrateV11, migrateV12 };
}

function formatImportSummary(
  summary: ReturnType<typeof importCorrectionMemories>,
  apply: boolean,
): string {
  return [
    "mode=import",
    `apply=${Number(apply)}`,
    `source=${summary.sourceCount}`,
    `skipped=${summary.skippedCount}`,
    `add=${summary.addedCount}`,
    `duplicate=${summary.duplicateCount}`,
    `already=${summary.alreadyImportedCount}`,
    `id_collision=${summary.idCollisionCount}`,
    `candidate=${summary.generatedCandidates}`,
    `expiry=${summary.expiryChanges}`,
    `migrate_required=${Number(summary.migrationRequired)}`,
  ].join(" ") + "\n";
}

export function runCorrectionImportCli(
  args: string[],
  targetPath: string,
  importedAt?: string,
): CorrectionImportCliResult {
  try {
    const parsed = parseArguments(args);
    if (parsed.migrateV11) {
      const summary = migrateCorrectionDatabase(targetPath, parsed.apply);
      return {
        exitCode: 0,
        stdout: "mode=migrate apply=" + Number(parsed.apply)
          + " schema=" + summary.schemaVersion
          + " ddl=" + summary.ddlCount + "\n",
        stderr: "",
      };
    }
    if (parsed.migrateV12) {
      const summary = migrateCorrectionComplianceDatabase(targetPath, parsed.apply);
      return {
        exitCode: 0,
        stdout: "mode=migrate apply=" + Number(parsed.apply)
          + " schema=" + summary.schemaVersion
          + " ddl=" + summary.ddlCount + "\n",
        stderr: "",
      };
    }
    const summary = importCorrectionMemories({
      sourcePath: parsed.sourcePath as string,
      targetPath,
      apply: parsed.apply,
      importedAt,
    });
    return { exitCode: 0, stdout: formatImportSummary(summary, parsed.apply), stderr: "" };
  } catch (error) {
    const message = error instanceof CorrectionImportError ? error.message : "correction import failed";
    const argumentError = error instanceof CorrectionImportError && [
      "--source requires one database path",
      "--apply cannot be repeated",
      "--migrate-v11 cannot be repeated",
      "--migrate-v12 cannot be repeated",
      "unsupported argument",
      "choose either --source or --migrate-v11",
      "choose either --source or --migrate-v12",
      "choose either --source or one migration",
    ].includes(error.message);
    return { exitCode: argumentError ? 2 : 1, stdout: "", stderr: `error: ${message}\n` };
  }
}

function resolveTargetPath(): string {
  const memoryPath = process.env.WASURENAGUSA_MEMORY_PATH ?? getMemoryPath(findProjectRoot(process.cwd()));
  return join(memoryPath, config.sqliteFile);
}

function main(): void {
  const result = runCorrectionImportCli(process.argv.slice(2), resolveTargetPath());
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

if (isDirectRun(process.argv[1], import.meta.url)) {
  main();
}
