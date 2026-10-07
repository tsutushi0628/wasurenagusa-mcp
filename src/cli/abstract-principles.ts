#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { config, getCliMemoryDirectory } from "../config.js";
import { readCorrectionFeatureModes } from "../corrections/environment-mode.js";
import { CORRECTION_PRINCIPLES_SCHEMA_VERSION } from "../storage/correction-schema.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { getSchemaVersion } from "../storage/schema.js";
import { findProjectRoot } from "../utils/projectRoot.js";
import { generateJstDatePart, generateJstTimestamp } from "../utils/operation-logger.js";
import { isMainModule, reportCliFailure } from "../utils/cli-entry.js";
import {
  addCorrectionPrincipleMembers,
  buildCorrectionPrincipleAbstractionGroups,
  confirmEligibleCorrectionPrinciples,
  confirmCorrectionPrinciple,
  createCorrectionPrinciple,
  guardCorrectionPrincipleAbstraction,
  type CorrectionPrincipleAbstractionGroup,
  type CorrectionPrincipleAbstractionOutput,
  type CorrectionPrinciplesMode,
} from "../corrections/principles.js";
import {
  runCodexAbstractionBatch,
  type CodexAbstractionBatchResult,
} from "../corrections/codex-batch.js";

export interface AbstractPrinciplesJobOptions {
  mode: CorrectionPrinciplesMode;
  at: string;
  memoryPath: string;
  runId?: string;
  dryRun?: boolean;
  promptTemplate: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  runBatch?: (prompt: string, runId: string) => Promise<CodexAbstractionBatchResult>;
}

export interface AbstractPrinciplesJobSummary {
  mode: CorrectionPrinciplesMode;
  groups: number;
  calls: number;
  adopted: number;
  rejectedGuard: number;
  rejectedNone: number;
  skippedReason: string | null;
  quotaBeforePct: number | null;
  quotaAfterPct: number | null;
  rejectionReasons: string[];
  dryRun: boolean;
  candidateGroups: Array<{
    groupId: string;
    kind: "cluster" | "later_attach";
    memberCount: number;
    distinctSessionCount: number;
    memberBundleKeys: string[];
  }>;
}

export interface AbstractPrinciplesCliArguments {
  dryRun: boolean;
  at: string;
}

function emptySummary(mode: CorrectionPrinciplesMode, dryRun: boolean): AbstractPrinciplesJobSummary {
  return {
    mode,
    groups: 0,
    calls: 0,
    adopted: 0,
    rejectedGuard: 0,
    rejectedNone: 0,
    skippedReason: null,
    quotaBeforePct: null,
    quotaAfterPct: null,
    rejectionReasons: [],
    dryRun,
    candidateGroups: [],
  };
}

function getCandidateGroupSummaries(groups: readonly CorrectionPrincipleAbstractionGroup[]) {
  return groups.map((group) => ({
    groupId: group.groupId,
    kind: group.kind,
    memberCount: group.memberBundleKeys.length,
    distinctSessionCount: group.distinctSessionCount,
    memberBundleKeys: group.memberBundleKeys,
  }));
}

export function buildCorrectionPrincipleAbstractionPrompt(
  promptTemplate: string,
  groups: readonly CorrectionPrincipleAbstractionGroup[],
): string {
  const placeholder = "{{GROUPS_JSON}}";
  if (promptTemplate.split(placeholder).length !== 2) {
    throw new Error("principle abstraction prompt must contain one groups placeholder");
  }
  const payload = groups.map((group) => ({
    group_id: group.groupId,
    items: group.items.map((item) => ({ id: item.id, rule_text: item.ruleText })),
  }));
  return promptTemplate.replace(placeholder, JSON.stringify(payload));
}

function parseAbstractionOutput(
  output: string,
  groups: readonly CorrectionPrincipleAbstractionGroup[],
): Map<string, CorrectionPrincipleAbstractionOutput | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("correction abstraction returned invalid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("correction abstraction returned an invalid response");
  const expectedGroupIds = new Set(groups.map((group) => group.groupId));
  const outputByGroup = new Map<string, CorrectionPrincipleAbstractionOutput | null>();
  for (const value of parsed) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("correction abstraction returned an invalid response");
    }
    const record = value as Record<string, unknown>;
    if (typeof record.group_id !== "string" || !expectedGroupIds.has(record.group_id)) {
      throw new Error("correction abstraction returned an unknown group");
    }
    if (outputByGroup.has(record.group_id)) {
      outputByGroup.set(record.group_id, null);
      continue;
    }
    const expectedKeys = ["group_id", "verdict", "principle", "odd_ids"];
    if (Object.keys(record).length !== expectedKeys.length
      || Object.keys(record).some((key) => !expectedKeys.includes(key))
      || (record.verdict !== "merge" && record.verdict !== "none")
      || typeof record.principle !== "string"
      || !Array.isArray(record.odd_ids)
      || record.odd_ids.some((id) => !Number.isSafeInteger(id))) {
      outputByGroup.set(record.group_id, null);
      continue;
    }
    outputByGroup.set(record.group_id, record as unknown as CorrectionPrincipleAbstractionOutput);
  }
  return outputByGroup;
}

function insertAbstractionRun(
  storage: Pick<SQLiteStorage, "runCorrectionTransaction">,
  input: {
    runId: string;
    at: string;
    mode: Exclude<CorrectionPrinciplesMode, "off">;
    calls: number;
    groups: number;
    adopted: number;
    rejectedGuard: number;
    rejectedNone: number;
    skippedReason: string | null;
    quotaBeforePct: number | null;
    quotaAfterPct: number | null;
  },
  ignoreDuplicate: boolean,
): boolean {
  return storage.runCorrectionTransaction(({ db }) => {
    const conflictClause = ignoreDuplicate ? "ON CONFLICT(run_id) DO NOTHING" : "";
    const result = db.prepare(`
      INSERT INTO owner_correction_abstraction_runs (
        run_id, ran_at, mode, calls, groups, adopted, rejected_guard, rejected_none,
        skipped_reason, quota_before_pct, quota_after_pct
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ${conflictClause}
    `).run(
      input.runId,
      input.at,
      input.mode,
      input.calls,
      input.groups,
      input.adopted,
      input.rejectedGuard,
      input.rejectedNone,
      input.skippedReason,
      input.quotaBeforePct,
      input.quotaAfterPct,
    );
    return result.changes === 1;
  });
}

function recordAbstractionRun(
  storage: Pick<SQLiteStorage, "runCorrectionTransaction">,
  input: Parameters<typeof insertAbstractionRun>[1],
): void {
  insertAbstractionRun(storage, input, false);
}

function reserveDailyAbstractionRun(
  storage: Pick<SQLiteStorage, "runCorrectionTransaction">,
  input: Parameters<typeof insertAbstractionRun>[1],
): boolean {
  return insertAbstractionRun(storage, input, true);
}

function updateAbstractionRun(
  storage: Pick<SQLiteStorage, "runCorrectionTransaction">,
  input: Omit<Parameters<typeof insertAbstractionRun>[1], "at" | "mode">,
): void {
  storage.runCorrectionTransaction(({ db }) => {
    db.prepare(`
      UPDATE owner_correction_abstraction_runs SET calls = ?, groups = ?, adopted = ?,
        rejected_guard = ?, rejected_none = ?, skipped_reason = ?, quota_before_pct = ?, quota_after_pct = ?
      WHERE run_id = ?
    `).run(
      input.calls,
      input.groups,
      input.adopted,
      input.rejectedGuard,
      input.rejectedNone,
      input.skippedReason,
      input.quotaBeforePct,
      input.quotaAfterPct,
      input.runId,
    );
  });
}

async function recordOperationFailure(memoryPath: string, at: Date): Promise<void> {
  const logsDirectory = join(memoryPath, "logs");
  const logPath = join(logsDirectory, `operation-${generateJstDatePart(at)}.jsonl`);
  const line = `${JSON.stringify({
    ts: generateJstTimestamp(at),
    operation_type: "correction_abstraction",
    status: "failed",
  })}\n`;
  await mkdir(logsDirectory, { recursive: true, mode: 0o700 });
  await appendFile(logPath, line, { encoding: "utf8", mode: 0o600 });
}

function applyAcceptedPrinciple(
  storage: Pick<SQLiteStorage, "runCorrectionTransaction">,
  input: {
    group: CorrectionPrincipleAbstractionGroup;
    ruleText: string;
    polarity: "positive" | "negative";
    mode: Exclude<CorrectionPrinciplesMode, "off">;
    at: string;
  },
): { adopted: boolean; rejectionReason: "terminal_principle" | null } {
  return storage.runCorrectionTransaction((transaction) => {
    let principleKey = input.group.principleKey;
    if (input.group.kind === "cluster") {
      const creation = createCorrectionPrinciple(transaction, {
        ruleText: input.ruleText,
        polarity: input.polarity,
        at: input.at,
      });
      if (creation.status === "disabled") throw new Error("correction principle creation was disabled");
      if (creation.status === "terminal") {
        return { adopted: false, rejectionReason: "terminal_principle" as const };
      }
      principleKey = creation.principleKey;
    }
    if (principleKey === null) throw new Error("correction principle key is missing");
    const addedCount = addCorrectionPrincipleMembers(transaction, {
      principleKey,
      memberBundleKeys: input.group.memberBundleKeys,
      attachedAt: input.at,
      attachSource: input.group.kind,
    });
    if (addedCount === 0) return { adopted: false, rejectionReason: null };
    if (input.mode === "on") confirmCorrectionPrinciple(transaction, { principleKey, at: input.at });
    return { adopted: true, rejectionReason: null };
  });
}

export async function runAbstractPrinciplesJob(
  storage: Pick<SQLiteStorage, "runCorrectionTransaction">,
  options: AbstractPrinciplesJobOptions,
): Promise<AbstractPrinciplesJobSummary> {
  const summary = emptySummary(options.mode, options.dryRun === true);
  if (options.mode === "off") return summary;
  const atValue = Date.parse(options.at);
  if (!Number.isFinite(atValue)) throw new Error("correction abstraction time must be valid");
  const at = new Date(atValue).toISOString();
  const schemaVersion = storage.runCorrectionTransaction(({ db }) => getSchemaVersion(db as Database.Database));
  if (schemaVersion < CORRECTION_PRINCIPLES_SCHEMA_VERSION) {
    summary.skippedReason = "schema_unavailable";
    return summary;
  }
  const groups = storage.runCorrectionTransaction(({ db }) => buildCorrectionPrincipleAbstractionGroups(db, at));
  summary.groups = groups.length;
  summary.candidateGroups = getCandidateGroupSummaries(groups);
  if (options.dryRun) return summary;

  const runId = groups.length > 0
    ? `principle-abstraction-${generateJstDatePart(new Date(at))}`
    : options.runId ?? randomUUID();
  const runRecord = {
    runId,
    at,
    mode: options.mode,
    calls: 0,
    groups: groups.length,
    adopted: 0,
    rejectedGuard: 0,
    rejectedNone: 0,
    skippedReason: groups.length === 0 ? "no_eligible_groups" : null,
    quotaBeforePct: null as number | null,
    quotaAfterPct: null as number | null,
  };
  if (groups.length > 0) {
    const reserved = reserveDailyAbstractionRun(storage, runRecord);
    if (!reserved) {
      summary.skippedReason = "already_ran_today";
      return summary;
    }
  } else {
    recordAbstractionRun(storage, runRecord);
  }
  const updateRun = (): void => updateAbstractionRun(storage, runRecord);
  try {
    if (options.mode === "on") {
      summary.adopted = storage.runCorrectionTransaction((transaction) =>
        confirmEligibleCorrectionPrinciples(transaction, at).length,
      );
      runRecord.adopted = summary.adopted;
      if (summary.adopted > 0) runRecord.skippedReason = null;
    }
    if (groups.length === 0) {
      summary.skippedReason = runRecord.skippedReason;
      updateRun();
      return summary;
    }
    const prompt = buildCorrectionPrincipleAbstractionPrompt(options.promptTemplate, groups);
    const runBatch = options.runBatch ?? ((batchPrompt: string, batchRunId: string) => runCodexAbstractionBatch({
      prompt: batchPrompt,
      memoryPath: options.memoryPath,
      runId: batchRunId,
      now: new Date(at),
      env: options.env,
      timeoutMs: options.timeoutMs,
    }));
    const batchResult = await runBatch(prompt, runId);
    runRecord.calls = batchResult.calls;
    runRecord.quotaBeforePct = batchResult.quotaBeforePct;
    runRecord.quotaAfterPct = batchResult.quotaAfterPct;
    if (batchResult.status === "skipped") {
      runRecord.skippedReason = batchResult.skippedReason;
      updateRun();
      summary.calls = runRecord.calls;
      summary.skippedReason = runRecord.skippedReason;
      summary.quotaBeforePct = runRecord.quotaBeforePct;
      summary.quotaAfterPct = runRecord.quotaAfterPct;
      return summary;
    }
    if (batchResult.status === "failed" || batchResult.output === null) {
      throw new Error(`correction abstraction failed: ${batchResult.failureReason ?? "codex_execution_failed"}`);
    }

    const outputByGroup = parseAbstractionOutput(batchResult.output, groups);
    for (const group of groups) {
      const output = outputByGroup.get(group.groupId);
      if (output === undefined) {
        summary.rejectedNone += 1;
        summary.rejectionReasons.push("missing_group");
        continue;
      }
      if (output === null) {
        summary.rejectedGuard += 1;
        summary.rejectionReasons.push("invalid_shape");
        continue;
      }
      const groupPolarity = group.kind === "later_attach"
        ? output.verdict === "merge" && group.principleKey !== null
          ? storage.runCorrectionTransaction(({ db }) => {
            const row = db.prepare("SELECT polarity FROM owner_correction_bundles WHERE bundle_key = ?")
              .get(group.principleKey) as { polarity: "positive" | "negative" } | undefined;
            if (!row) throw new Error("correction principle disappeared before attachment");
            return row.polarity;
          })
          : "positive"
        : storage.runCorrectionTransaction(({ db }) => {
          const memberKey = group.memberBundleKeys[0];
          const row = db.prepare("SELECT polarity FROM owner_correction_bundles WHERE bundle_key = ?")
            .get(memberKey) as { polarity: "positive" | "negative" } | undefined;
          if (!row) throw new Error("correction principle member disappeared before adoption");
          return row.polarity;
        });
      const guarded = guardCorrectionPrincipleAbstraction(group, output, groupPolarity);
      if (!guarded.accepted) {
        const reason = guarded.reason ?? "invalid_shape";
        summary.rejectionReasons.push(reason);
        if (reason === "none") summary.rejectedNone += 1;
        else summary.rejectedGuard += 1;
        continue;
      }
      const accepted = applyAcceptedPrinciple(storage, {
        group,
        ruleText: guarded.principle as string,
        polarity: groupPolarity,
        mode: options.mode,
        at,
      });
      if (accepted.rejectionReason !== null) {
        summary.rejectedGuard += 1;
        summary.rejectionReasons.push(accepted.rejectionReason);
        continue;
      }
      if (accepted.adopted) summary.adopted += 1;
    }

    runRecord.adopted = summary.adopted;
    runRecord.rejectedGuard = summary.rejectedGuard;
    runRecord.rejectedNone = summary.rejectedNone;
    runRecord.skippedReason = null;
    updateRun();
    summary.calls = runRecord.calls;
    summary.quotaBeforePct = runRecord.quotaBeforePct;
    summary.quotaAfterPct = runRecord.quotaAfterPct;
    return summary;
  } catch (error) {
    runRecord.adopted = summary.adopted;
    runRecord.rejectedGuard = summary.rejectedGuard;
    runRecord.rejectedNone = summary.rejectedNone;
    updateRun();
    await recordOperationFailure(options.memoryPath, new Date(at));
    if (error instanceof Error) throw error;
    throw new Error("correction abstraction failed");
  }
}

export function parseAbstractPrinciplesArguments(args: string[]): AbstractPrinciplesCliArguments {
  let dryRun = false;
  let at: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run") {
      if (dryRun) throw new Error("--dry-run cannot be repeated");
      dryRun = true;
      continue;
    }
    if (argument === "--now") {
      if (at !== undefined || index + 1 >= args.length || args[index + 1].startsWith("--")) {
        throw new Error("--now requires one timestamp and cannot be repeated");
      }
      const parsedTime = Date.parse(args[index + 1]);
      if (!Number.isFinite(parsedTime)) throw new Error("--now requires a valid timestamp");
      at = new Date(parsedTime).toISOString();
      index += 1;
      continue;
    }
    throw new Error("unsupported abstract-principles argument");
  }
  return { dryRun, at: at ?? new Date().toISOString() };
}

export async function runAbstractPrinciplesCli(args: string[] = process.argv.slice(2)):
Promise<AbstractPrinciplesJobSummary> {
  const parsedArguments = parseAbstractPrinciplesArguments(args);
  const featureModes = readCorrectionFeatureModes();
  const mode = featureModes.principles;
  if (featureModes.correctionLoop === "off" || mode === "off") {
    const summary = emptySummary(mode, parsedArguments.dryRun);
    summary.skippedReason = featureModes.correctionLoop === "off" ? "correction_loop_off" : "feature_off";
    return summary;
  }
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const memoryPath = getCliMemoryDirectory(findProjectRoot(process.cwd()));
  const dbPath = resolve(memoryPath, config.sqliteFile);
  if (!existsSync(dbPath)) throw new Error("correction abstraction memory store does not exist");
  const promptPath = join(packageRoot, "prompts", "principle-abstraction.md");
  const promptTemplate = await readFile(promptPath, "utf8");
  const storage = SQLiteStorage.openExistingForHook(dbPath, { mode: "correction" });
  try {
    return await runAbstractPrinciplesJob(storage, {
      mode,
      at: parsedArguments.at,
      memoryPath,
      dryRun: parsedArguments.dryRun,
      promptTemplate,
    });
  } finally {
    storage.close();
  }
}

if (isMainModule(import.meta.url)) {
  runAbstractPrinciplesCli().then((summary) => {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  }).catch((error: unknown) => {
    reportCliFailure("abstract-principles", error);
  });
}
