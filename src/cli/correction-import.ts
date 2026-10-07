#!/usr/bin/env node
import { join } from "path";
import Database from "better-sqlite3";
import { config, getMemoryPath } from "../config.js";
import {
  CorrectionImportError,
  backfillCorrectionRuleText,
  importCorrectionMemories,
  migrateCorrectionComplianceDatabase,
  migrateCorrectionDatabase,
} from "../corrections/import.js";
import { CORRECTION_PRINCIPLES_DDL } from "../storage/correction-schema.js";
import { migrateV12ToV13 } from "../storage/migration.js";
import { isDirectRun } from "../utils/cli-entry.js";
import { findProjectRoot } from "../utils/projectRoot.js";

type ParsedArguments = {
  sourcePath?: string;
  apply: boolean;
  migrateV11: boolean;
  migrateV12: boolean;
  migrateV13: boolean;
  backfillRuleText: boolean;
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
  let migrateV13 = false;
  let backfillRuleText = false;
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
    if (argument === "--migrate-v13") {
      if (migrateV13) {
        throw new CorrectionImportError("--migrate-v13 cannot be repeated");
      }
      migrateV13 = true;
      continue;
    }
    if (argument === "--backfill-rule-text") {
      if (backfillRuleText) {
        throw new CorrectionImportError("--backfill-rule-text cannot be repeated");
      }
      backfillRuleText = true;
      continue;
    }
    throw new CorrectionImportError("unsupported argument");
  }

  if (migrateV11 && migrateV12) {
    throw new CorrectionImportError("choose either --source or one migration");
  }
  const migrationCount = Number(migrateV11) + Number(migrateV12) + Number(migrateV13) + Number(backfillRuleText);
  if (migrationCount > 1) {
    throw new CorrectionImportError("choose one migration");
  }
  if (migrateV11 && sourcePath !== undefined) {
    throw new CorrectionImportError("choose either --source or --migrate-v11");
  }
  if (migrateV12 && sourcePath !== undefined) {
    throw new CorrectionImportError("choose either --source or --migrate-v12");
  }
  if (migrateV13 && sourcePath !== undefined) {
    throw new CorrectionImportError("choose either --source or --migrate-v13");
  }
  if (backfillRuleText && sourcePath !== undefined) {
    throw new CorrectionImportError("choose either --source or --backfill-rule-text");
  }
  if (migrationCount === 0 && sourcePath === undefined) {
    throw new CorrectionImportError("choose either --source or --migrate-v11");
  }
  return { sourcePath, apply, migrateV11, migrateV12, migrateV13, backfillRuleText };
}

function formatRuleTextBackfillSummary(
  summary: ReturnType<typeof backfillCorrectionRuleText>,
  apply: boolean,
): string {
  const lines = [
    "mode=backfill-rule-text"
      + ` apply=${Number(apply)} schema=${summary.schemaVersion}`
      + ` candidates=${summary.candidateCount} fill=${summary.fillCount}`
      + ` unfilled=${summary.unfilledCount} polarity_changed=${summary.polarityChangedCount}`
      + ` backup=${Number(summary.backupCreated)}`,
    `unfilled_reasons=${Object.entries(summary.reasons).sort(([left], [right]) => left.localeCompare(right))
      .map(([reason, count]) => `${reason}=${count}`).join(",") || "none"}`,
    ...summary.examples.map((example, index) => `example_${index + 1}`
      + ` source=${JSON.stringify(example.sourceCommand)}`
      + ` before=${JSON.stringify(example.beforeRuleText)}`
      + ` after=${JSON.stringify(example.afterRuleText)}`
      + ` polarity=${example.beforePolarity}->${example.afterPolarity}`),
  ];
  return lines.join("\n") + "\n";
}

function runV13Migration(targetPath: string, apply: boolean): { schemaVersion: number; ddlCount: number } {
  const db = new Database(targetPath, { fileMustExist: true, readonly: !apply });
  try {
    return migrateV12ToV13(db, apply);
  } finally {
    db.close();
  }
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
    if (parsed.migrateV13) {
      const summary = runV13Migration(targetPath, parsed.apply);
      const ddlPreview = parsed.apply ? "" : "\n" + CORRECTION_PRINCIPLES_DDL.trim()
        .split(/\r?\n/u)
        .filter((line) => line.trim().length > 0)
        .map((line) => "+ " + line)
        .join("\n");
      return {
        exitCode: 0,
        stdout: "mode=migrate apply=" + Number(parsed.apply)
          + " schema=" + summary.schemaVersion
          + " ddl=" + summary.ddlCount + ddlPreview + "\n",
        stderr: "",
      };
    }
    if (parsed.backfillRuleText) {
      const summary = backfillCorrectionRuleText(targetPath, parsed.apply);
      return { exitCode: 0, stdout: formatRuleTextBackfillSummary(summary, parsed.apply), stderr: "" };
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
      "--migrate-v13 cannot be repeated",
      "--backfill-rule-text cannot be repeated",
      "unsupported argument",
      "choose either --source or --migrate-v11",
      "choose either --source or --migrate-v12",
      "choose either --source or --migrate-v13",
      "choose either --source or --backfill-rule-text",
      "choose either --source or one migration",
      "choose one migration",
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
