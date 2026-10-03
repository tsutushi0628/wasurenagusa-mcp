#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import {
  buildOccurrenceMetrics,
  countHumanInputTypes,
  extractHumanUtterance,
  extractInjectedEntries,
  isHandoffPaste,
  isSlashCommand,
  jstDate,
  percentile,
  transcriptContextBucket,
} from "./lib/analysis.mjs";
import { THEMES } from "./lib/themes.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DATE_START = "2026-09-22";
const DATE_END = "2026-10-02";
const EXCLUDED_SESSION_PREFIXES = ["dccb7da4", "57b0207c"];
const SOURCE_DIRECTORY = join(
  homedir(),
  ".claude",
  "projects",
  `${homedir().replace(/[/.]/gu, "-")}-projects-firebase-kit`,
);

function timestampValue(value) {
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function isContextHook(command, hookName) {
  if (hookName !== "SessionStart:startup" && hookName !== "SessionStart:resume") return false;
  if (typeof command !== "string") return false;
  return command.split(/\s+/u).some((part) => {
    const cleaned = part.replace(/^['"]|['"]$/gu, "");
    return cleaned === "wasurenagusa-context" || cleaned.endsWith("/wasurenagusa-context");
  });
}

function outputFromHook(attachment) {
  if (typeof attachment.stdout === "string" && attachment.stdout.trim().length > 0) return attachment.stdout;
  if (typeof attachment.content === "string") return attachment.content;
  return "";
}

function createSession(sessionId) {
  return {
    sessionId,
    startAt: null,
    firstHumanAt: null,
    humanInputs: [],
    stopEvents: [],
    injectionEvents: [],
    hookAttempts: [],
    auditCounts: {
      taskNotifications: 0,
      peerInputs: 0,
      sidechainInputs: 0,
      systemKeepAliveInputs: 0,
    },
  };
}

function updateMinimumDate(session, field, timestamp) {
  const value = timestampValue(timestamp);
  if (value === null) return;
  const existing = timestampValue(session[field]);
  if (existing === null || value < existing) session[field] = timestamp;
}

async function* readTranscriptLines(filename) {
  let pending = Buffer.alloc(0);
  let bytesRead = 0;
  for await (const chunk of createReadStream(filename)) {
    const combined = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
    const combinedOffset = bytesRead - pending.length;
    let start = 0;
    while (true) {
      const newline = combined.indexOf(0x0a, start);
      if (newline < 0) break;
      const end = newline > start && combined[newline - 1] === 0x0d ? newline - 1 : newline;
      yield {
        line: combined.subarray(start, end).toString("utf8"),
        byteOffset: combinedOffset + start,
      };
      start = newline + 1;
    }
    pending = combined.subarray(start);
    bytesRead += chunk.length;
  }
  if (pending.length > 0) {
    const end = pending[pending.length - 1] === 0x0d ? pending.length - 1 : pending.length;
    yield {
      line: pending.subarray(0, end).toString("utf8"),
      byteOffset: bytesRead - pending.length,
    };
  }
}

async function readTranscriptSessions() {
  const files = (await readdir(SOURCE_DIRECTORY, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name)
    .sort();
  const sessions = [];
  const audit = {
    directJsonlFileCount: files.length,
    excludedSessionIds: [],
    periodOutsideCount: 0,
    zeroHumanInputCount: 0,
    unknownFirstHumanDateCount: 0,
    humanUtterancesOutsidePeriodCount: 0,
    periodOutsideHumanInputCount: 0,
    periodOutsideHumanInputCounts: { main: 0, queued: 0, total: 0 },
    humanUtterancesOutsidePeriodCounts: { main: 0, queued: 0, total: 0 },
    r2ComparableMainHumanUtterances: 0,
    r2ComparableQueuedHumanUtterances: 0,
    excludedSessionHumanInputCounts: [],
  };

  for (const file of files) {
    const filenameSessionId = basename(file, ".jsonl");
    const session = createSession(filenameSessionId);
    let order = 0;

    for await (const { line, byteOffset } of readTranscriptLines(join(SOURCE_DIRECTORY, file))) {
      order += 1;
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (typeof event.sessionId === "string") session.sessionId = event.sessionId;
      updateMinimumDate(session, "startAt", event.timestamp);

      const utterance = extractHumanUtterance(event);
      if (utterance) {
        session.humanInputs.push({
          order,
          timestamp: event.timestamp,
          text: utterance.text,
          queued: utterance.queued,
          sourceType: utterance.sourceType,
          transcriptByteOffset: byteOffset,
        });
        updateMinimumDate(session, "firstHumanAt", event.timestamp);
      } else if (event.type === "user") {
        if (event.isSidechain === true) session.auditCounts.sidechainInputs += 1;
        if (event.origin?.kind === "peer" || event.origin?.kind === "task-notification") {
          session.auditCounts.peerInputs += 1;
        }
        if (event.isMeta === true && event.promptSource === "system") {
          session.auditCounts.systemKeepAliveInputs += 1;
        }
      }

      const attachment = event.attachment ?? {};
      if (event.type === "attachment" && attachment.type === "queued_command") {
        if (attachment.commandMode === "task-notification") session.auditCounts.taskNotifications += 1;
        const originKind = event.origin?.kind ?? attachment.origin?.kind;
        if (originKind === "peer" || originKind === "task-notification") session.auditCounts.peerInputs += 1;
      }

      if (event.type === "system" && event.subtype === "stop_hook_summary") {
        for (const hookInfo of event.hookInfos ?? []) {
          if (hookInfo.command !== "wasurenagusa-analyze") continue;
          session.stopEvents.push({
            order,
            timestamp: event.timestamp,
            durationMs: Number.isFinite(hookInfo.durationMs) ? hookInfo.durationMs : null,
          });
        }
      }

      if (event.type === "attachment" && isContextHook(attachment.command, attachment.hookName)) {
        const success = attachment.type === "hook_success";
        const text = success ? outputFromHook(attachment) : "";
        const entries = success ? extractInjectedEntries(text) : [];
        const attempt = {
          order,
          timestamp: event.timestamp,
          success,
          hookName: attachment.hookName,
          command: attachment.command,
          exitCode: Number.isFinite(attachment.exitCode) ? attachment.exitCode : null,
          durationMs: Number.isFinite(attachment.durationMs) ? attachment.durationMs : null,
          outputLength: text.length,
          errorType: /TypeError/iu.test(String(attachment.stderr ?? "")) ? "TypeError" : null,
          entries,
          text,
        };
        session.hookAttempts.push(attempt);
        if (success) session.injectionEvents.push(attempt);
      }
    }

    if (!filenameSessionId.startsWith("dccb7da4")) {
      const counts = countHumanInputTypes(session.humanInputs);
      audit.r2ComparableMainHumanUtterances += counts.main;
      audit.r2ComparableQueuedHumanUtterances += counts.queued;
    }

    const firstHumanDate = session.firstHumanAt ? jstDate(session.firstHumanAt) : null;
    const excludedSession = EXCLUDED_SESSION_PREFIXES.some((prefix) => session.sessionId.startsWith(prefix));
    if (excludedSession) {
      audit.excludedSessionIds.push(session.sessionId.slice(0, 8));
      audit.excludedSessionHumanInputCounts.push({
        id: session.sessionId.slice(0, 8),
        ...countHumanInputTypes(session.humanInputs),
      });
    } else if (session.humanInputs.length === 0) {
      audit.zeroHumanInputCount += 1;
    } else if (!firstHumanDate) {
      audit.unknownFirstHumanDateCount += 1;
    } else if (firstHumanDate < DATE_START || firstHumanDate > DATE_END) {
      audit.periodOutsideCount += 1;
      const counts = countHumanInputTypes(session.humanInputs);
      audit.periodOutsideHumanInputCount += counts.total;
      for (const key of ["main", "queued", "total"]) {
        audit.periodOutsideHumanInputCounts[key] += counts[key];
      }
    } else {
      const inPeriodInputs = [];
      for (const input of session.humanInputs) {
        const inputDate = jstDate(input.timestamp);
        if (inputDate && inputDate >= DATE_START && inputDate <= DATE_END) {
          inPeriodInputs.push(input);
        } else {
          audit.humanUtterancesOutsidePeriodCount += 1;
          const key = input.queued ? "queued" : "main";
          audit.humanUtterancesOutsidePeriodCounts[key] += 1;
          audit.humanUtterancesOutsidePeriodCounts.total += 1;
        }
      }
      session.humanInputs = inPeriodInputs;
      sessions.push(session);
    }
  }

  return { sessions, directJsonlFileCount: files.length, audit };
}

function readMemoryRows(databasePath, store) {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return database.prepare(`
      SELECT id, timestamp, category, title, content, tags, project, scope, intensity, state, deleted_at, created_at
      FROM memories
    `).all().map((row) => ({ ...row, store }));
  } finally {
    database.close();
  }
}

function summarizeDurations(values) {
  const durations = values.filter(Number.isFinite);
  return {
    count: durations.length,
    medianMs: percentile(durations, 0.5),
    p90Ms: percentile(durations, 0.9),
    atLeast3000Ms: durations.filter((value) => value >= 3000).length,
    unavailableCount: values.length - durations.length,
  };
}

function countByStoreAndCategory(rows) {
  const counts = {};
  for (const row of rows) {
    counts[row.store] ??= {};
    counts[row.store][row.category] = (counts[row.store][row.category] ?? 0) + 1;
  }
  return counts;
}

function buildMemorySaveCounts(memoryRows) {
  const stores = {};
  for (const row of memoryRows) {
    const day = jstDate(row.timestamp);
    if (!day || day < DATE_START || day > DATE_END) continue;
    stores[row.store] ??= { total: 0, byCategory: {}, byDayAndCategory: {} };
    const summary = stores[row.store];
    summary.total += 1;
    summary.byCategory[row.category] = (summary.byCategory[row.category] ?? 0) + 1;
    summary.byDayAndCategory[day] ??= {};
    summary.byDayAndCategory[day][row.category] = (summary.byDayAndCategory[day][row.category] ?? 0) + 1;
  }
  return stores;
}

function countInjectionOverview(sessions, memoryRows) {
  const attempts = sessions.flatMap((session) => session.hookAttempts.map((attempt) => ({
    ...attempt,
    sessionId: session.sessionId,
  })));
  const successfulRecords = attempts.filter((attempt) => attempt.success);
  const latestAttempts = new Map();
  const latestSuccessful = new Map();
  for (const attempt of attempts) {
    latestAttempts.set(attempt.sessionId, attempt);
    if (attempt.success) latestSuccessful.set(attempt.sessionId, attempt);
  }

  const titleDistribution = {};
  for (const attempt of latestSuccessful.values()) {
    const titleCount = new Set(attempt.entries.map((entry) => entry.title)).size;
    titleDistribution[titleCount] = (titleDistribution[titleCount] ?? 0) + 1;
  }

  const allInjectedTitles = new Set();
  const injectedRowKeys = new Set();
  const bodyIncludedRowKeys = new Set();
  const injectedRowAppearancesByStore = {};
  const bodyIncludedRowAppearancesByStore = {};
  let injectedTitleEntryCount = 0;
  let unmatchedTitleEntryCount = 0;
  for (const attempt of successfulRecords) {
    const at = timestampValue(attempt.timestamp);
    for (const entry of attempt.entries) {
      injectedTitleEntryCount += 1;
      allInjectedTitles.add(entry.title);
      const matchingRows = memoryRows.filter((row) => row.title === entry.title
        && timestampValue(row.timestamp) !== null
        && at !== null
        && timestampValue(row.timestamp) <= at);
      if (matchingRows.length === 0) unmatchedTitleEntryCount += 1;
      for (const row of matchingRows) {
        const rowKey = `${row.store}:${row.id}`;
        injectedRowKeys.add(rowKey);
        injectedRowAppearancesByStore[row.store] = (injectedRowAppearancesByStore[row.store] ?? 0) + 1;
        const normalizedBody = String(row.content ?? "").replace(/\s+/gu, " ").trim();
        const normalizedInjection = attempt.text.replace(/\s+/gu, " ").trim();
        if (normalizedBody && normalizedInjection.includes(normalizedBody)) {
          bodyIncludedRowKeys.add(rowKey);
          bodyIncludedRowAppearancesByStore[row.store] = (bodyIncludedRowAppearancesByStore[row.store] ?? 0) + 1;
        }
      }
    }
  }

  const centralFirebaseKitRows = memoryRows.filter((row) => row.store === "central" && row.project === "firebase-kit");
  return {
    targetSessionCount: sessions.length,
    sessionStartAttemptCount: attempts.length,
    sessionsWithAttempt: latestAttempts.size,
    sessionsWithSuccessfulInjectionRecord: latestSuccessful.size,
    sessionsWithNoRecordedAttempt: sessions.length - latestAttempts.size,
    sessionsWithNoSuccessfulRecord: sessions.length - latestSuccessful.size,
    sessionsWithZeroTitleOnSuccessfulRecord: [...latestSuccessful.values()]
      .filter((attempt) => new Set(attempt.entries.map((entry) => entry.title)).size === 0).length,
    sessionsWithZeroTitleOnLatestAttempt: sessions.length - [...latestAttempts.values()]
      .filter((attempt) => attempt.success && attempt.entries.length > 0).length,
    failedAttemptCount: attempts.filter((attempt) => !attempt.success).length,
    typeErrorAttemptCount: attempts.filter((attempt) => attempt.errorType === "TypeError").length,
    titleCountDistribution: titleDistribution,
    injectedTitleEntryCount,
    unmatchedTitleEntryCount,
    uniqueInjectedMemoryRows: injectedRowKeys.size,
    uniqueInjectedMemoryRowsByStore: Object.fromEntries([...injectedRowKeys].reduce((map, key) => {
      const store = key.split(":", 1)[0];
      map.set(store, (map.get(store) ?? 0) + 1);
      return map;
    }, new Map())),
    uniqueBodyIncludedMemoryRows: bodyIncludedRowKeys.size,
    uniqueBodyIncludedMemoryRowsByStore: Object.fromEntries([...bodyIncludedRowKeys].reduce((map, key) => {
      const store = key.split(":", 1)[0];
      map.set(store, (map.get(store) ?? 0) + 1);
      return map;
    }, new Map())),
    centralFirebaseKitMemoryRows: centralFirebaseKitRows.length,
    centralFirebaseKitRowsNeverInjected: centralFirebaseKitRows.filter((row) => !allInjectedTitles.has(row.title)).length,
    injectedRowAppearancesByStore,
    bodyIncludedRowAppearancesByStore,
  };
}

function countBundleSamples(theme) {
  const hash = (value) => {
    let result = 2166136261;
    for (const character of value) {
      result ^= character.codePointAt(0);
      result = Math.imul(result, 16777619);
    }
    return result >>> 0;
  };
  const redact = (value) => value
    .replace(/(?:\/Users\/|\/home\/|\/private\/var\/)[^\s"'`]+/gu, "[path]")
    .replace(/~\/[^\s"'`]+/gu, "[path]")
    .replace(/(?:sk-ant-|sk-proj-|AIza|gh[pousr]_|xox[baprs]-)[A-Za-z0-9_-]{10,}/gu, "[secret]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]{12,}/giu, "Bearer [secret]")
    .replace(/[|]/gu, "｜")
    .replace(/[<>]/gu, "‹›")
    .replace(/\s+/gu, " ")
    .trim();

  return [...theme.occurrences]
    .sort((left, right) => hash(`T1-baseline:${theme.id}:${left.sessionId}:${left.order}`)
      - hash(`T1-baseline:${theme.id}:${right.sessionId}:${right.order}`))
    .slice(0, 10)
    .map((occurrence) => {
      const pattern = THEMES.find((item) => item.id === theme.id).pattern;
      const normalizedText = occurrence.quoteSource.replace(/\s+/gu, " ").trim();
      const match = pattern.exec(normalizedText);
      const start = Math.max(0, (match?.index ?? 0) - 8);
      const excerpt = Array.from(normalizedText).slice(start, start + 42).join("");
      return {
        session: occurrence.sessionId.slice(0, 8),
        date: occurrence.dateJst,
        quote: Array.from(redact(excerpt)).slice(0, 30).join(""),
      };
    });
}

function ordinalBucket(value) {
  if (value <= 10) return "1-10";
  if (value <= 30) return "11-30";
  if (value <= 100) return "31-100";
  return "101+";
}

function countBuckets(occurrences, selector, bucket) {
  const counts = {};
  for (const occurrence of occurrences) {
    const key = bucket(selector(occurrence));
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function safeOccurrence(occurrence) {
  const { quoteSource, sessionId, previousSessionId, ...rest } = occurrence;
  return {
    ...rest,
    session: sessionId.slice(0, 8),
    previousSession: previousSessionId?.slice(0, 8) ?? null,
    contextUnavailableReason: occurrence.contextByteOffset === null
      ? "会話記録の行開始 byte offset なし"
      : null,
  };
}

function safeQuoteText(value) {
  return String(value ?? "")
    .replace(/(?:\/Users\/|\/home\/|\/private\/var\/)[^\s"'`]+/gu, "[path]")
    .replace(/~\/[^\s"'`]+/gu, "[path]")
    .replace(/(?:sk-ant-|sk-proj-|AIza|gh[pousr]_|xox[baprs]-)[A-Za-z0-9_-]{10,}/gu, "[secret]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]{12,}/giu, "Bearer [secret]")
    .replace(/[|]/gu, "｜")
    .replace(/[<>]/gu, "‹›")
    .replace(/\s+/gu, " ")
    .trim();
}

function sampleCorrectionFalsePositives(inputs) {
  const hash = (value) => {
    let result = 2166136261;
    for (const character of value) {
      result ^= character.codePointAt(0);
      result = Math.imul(result, 16777619);
    }
    return result >>> 0;
  };
  return [...inputs]
    .sort((left, right) => hash(`T1-correction:${left.sessionId}:${left.order}`)
      - hash(`T1-correction:${right.sessionId}:${right.order}`))
    .slice(0, 30)
    .map((item) => ({
      session: item.sessionId.slice(0, 8),
      quote: Array.from(safeQuoteText(item.quoteSource)).slice(0, 30).join(""),
    }));
}

function buildMarkdown(report) {
  const lines = [];
  const additionalR2ExcludedIdCount = report.population.excludedSessionIds
    .filter((id) => id !== "dccb7da4")
    .length;
  lines.push("| 集計 | 再発件数 | 趣旨一致の保存済み | 注入題名に載った | 注入されても再発 | 通し番号31以降 |");
  lines.push("|---|---:|---:|---:|---:|---:|");
  for (const row of report.summaryTable) {
    lines.push(`| ${row.bundle} | ${row.recurrenceCount} | ${row.storedAtRecurrenceCount} | ${row.injectedTitleMemoryCount} | ${row.injectedThenRepeatedCount} | ${row.ordinal31PlusCount} |`);
  }
  lines.push("");
  lines.push(report.conclusion);
  lines.push("");
  lines.push("## 母数と抽出");
  lines.push("");
  lines.push(`対象セッション: ${report.population.targetSessions}。本流発話: ${report.population.mainHumanUtterances}。割り込み発話: ${report.population.queuedHumanUtterances}。人間発話合計: ${report.population.totalHumanUtterances}。`);
  lines.push(`束判定候補: ${report.population.themeCandidates}。対象期間: JST ${DATE_START}〜${DATE_END}。`);
  lines.push("");
  lines.push("| 直下JSONLの内訳 | 件数 |");
  lines.push("|---|---:|");
  lines.push(`| *.jsonl 総数 | ${report.population.directJsonlFileCount} |`);
  lines.push(`| 期間外で除外 | ${report.population.periodOutsideCount} |`);
  lines.push(`| 除外ID | ${report.population.excludedSessionIds.length}（${report.population.excludedSessionIds.join("、")}）|`);
  lines.push(`| 有効な人間発話0件で除外 | ${report.population.zeroHumanInputCount} |`);
  lines.push(`| 最初の人間発話日時が不明で除外 | ${report.population.unknownFirstHumanDateCount} |`);
  lines.push(`| 対象セッション内の期間外発話 | ${report.population.humanUtterancesOutsidePeriodCount} |`);
  lines.push(`| 対象 | ${report.population.targetSessions} |`);
  lines.push("");
  lines.push("人間発話を束判定から外した理由（優先順で重複なし）:");
  lines.push("");
  lines.push("| 理由 | 件数 |");
  lines.push("|---|---:|");
  for (const [reason, count] of Object.entries(report.population.themeCandidateExclusionsByReason)) {
    lines.push(`| ${reason} | ${count} |`);
  }
  lines.push("");
  lines.push("r2-k3との人間発話数比較（main＝通常user、queued＝割り込み入力）:");
  lines.push("");
  lines.push("| 段階 | main | queued | 合計 |");
  lines.push("|---|---:|---:|---:|");
  lines.push(`| r2-k3元集計 | ${report.population.r2Comparison.sourceMainHumanUtteranceCount} | ${report.population.r2Comparison.sourceQueuedHumanUtteranceCount} | ${report.population.r2Comparison.humanUtteranceCount} |`);
  lines.push(`| 現時点の同型抽出（dccb7da4除外） | ${report.population.r2Comparison.currentSourceMainHumanUtteranceCount} | ${report.population.r2Comparison.currentSourceQueuedHumanUtteranceCount} | ${report.population.r2Comparison.currentSourceHumanUtteranceCount} |`);
  lines.push(`| 今回の対象期間・ID条件適用後 | ${report.population.mainHumanUtterances} | ${report.population.queuedHumanUtterances} | ${report.population.totalHumanUtterances} |`);
  lines.push("");
  lines.push("| 今回の抽出から対象外にした理由 | main | queued | 合計 |");
  lines.push("|---|---:|---:|---:|");
  for (const [reason, counts] of Object.entries(report.population.r2Comparison.currentSelectionRemovalCounts)) {
    const label = {
      otherExcludedIds: "追加の指定除外ID（57b0207c）",
      periodOutsideSessions: "期間外セッション",
      inScopeSessionsOutsidePeriod: "対象セッション内の期間外発話",
      zeroHumanInputSessions: "有効な人間発話0件のセッション",
    }[reason];
    lines.push(`| ${label} | ${counts.main} | ${counts.queued} | ${counts.total} |`);
  }
  lines.push(`| 合計 | ${report.population.r2Comparison.currentSelectionRemovalMain} | ${report.population.r2Comparison.currentSelectionRemovalQueued} | ${report.population.r2Comparison.currentSelectionRemovalTotal} |`);
  lines.push("");
  lines.push(`r2-k3との比較: セッション ${report.population.r2Comparison.sessionCount}対${report.population.targetSessions}（差 ${report.population.r2Comparison.sessionDifference}）、人間発話 ${report.population.r2Comparison.humanUtteranceCount}対${report.population.totalHumanUtterances}（差 ${report.population.r2Comparison.humanUtteranceDifference}）。${report.population.r2Comparison.note}`);
  lines.push(`旧T1の人間発話合計1146件から今回は1136件（−10）。旧MDに抽出内訳が無いため差10件の個別帰属は再現不能。`);
  lines.push(`r2-k3元資料の束判定除外: 引継ぎ貼付 ${report.population.r2Comparison.sourceHandoffExclusionCount}件、スラッシュコマンド ${report.population.r2Comparison.sourceSlashExclusionCount}件、空・脚注貼付 ${report.population.r2Comparison.sourceEmptyExclusionCount}件。今回の束判定候補の除外表とは分類基準が異なり、元の人間発話数との差にそのまま当てはめない。`);
  if (report.population.targetSessions < 100 || report.population.targetSessions > 110) {
    lines.push(`対象セッション ${report.population.targetSessions}件は指定目安100〜110件の外。r2-k3は107本からdccb7da4を除いて106件。現行は${report.population.directJsonlFileCount}本（+${report.population.r2Comparison.currentDirectoryFileDifference}）から指定ID2件・期間外${report.population.periodOutsideCount}件・人間発話0件${report.population.zeroHumanInputCount}件を除いて98件。r2との差8件は件数上 +${report.population.r2Comparison.currentDirectoryFileDifference}−追加ID${additionalR2ExcludedIdCount}−期間外${report.population.periodOutsideCount}−人間発話0件${report.population.zeroHumanInputCount}。r2資料にdccb7da4以外のファイルID一覧がなく、各除外行との照合は不可。`);
  }
  lines.push("");
  lines.push("## S2・S3 集計");
  lines.push("");
  lines.push("| 集計 | 保存済み再発 | 他projectだけ | 注入題名の記憶数 | 注入後の再発 |");
  lines.push("|---|---:|---:|---:|---:|");
  for (const row of report.s2S3Summary) {
    lines.push(`| ${row.bundle} | ${row.storedAtRecurrenceCount} | ${row.otherProjectOnlyAtRecurrenceCount} | ${row.injectedTitleMemoryCount} | ${row.injectedThenRepeatedCount} |`);
  }
  lines.push("");
  lines.push(`B1の「注入題名に載った」: 旧キーワード一致 ${report.b1OldInjectedTitleCount}件 → 趣旨一致 ${report.b1InjectedTitleMemoryCount}件。新条件は使用上限・枯渇・復帰の規則、またはモデル名と役割分担・担当先・明示的な割当の同時一致。題名にCodex等があるだけでは数えない。B1趣旨一致記憶 ${report.b1CoverageAudit.total}件（可視 ${report.b1CoverageAudit.visible}、他projectだけ ${report.b1CoverageAudit.otherProjectOnly}）。全体の注入題名一致行は ${JSON.stringify(report.b1CoverageAudit.injectedTitleRowsByStore)}。`);
  lines.push("「注入題名に載った」は、束の趣旨一致記憶の題名が発話前の成功注入に現れた記憶行数。「注入されても再発」は、その後に起きた再発発話数。保存済みは記憶日時が再発より前の可視記憶だけ。別project記憶は見える数に含めない。");
  lines.push("");
  lines.push("## 汎用訂正判定");
  lines.push("");
  lines.push(`全人間発話: ${report.correctionLike.detectedCount}/${report.correctionLike.humanUtteranceCount}件を検出。B2〜B10の束発話再現率: ${report.correctionLike.b2ToB10RecallPercent ?? "未計測"}%。`);
  lines.push("判定は明示の訂正・否定指示・叱責語、または同一セッション直前5発話との文字3-gram重なり70%以上。");
  lines.push("");
  lines.push("| 束 | 検出 / 発話 | 再現率 |");
  lines.push("|---|---:|---:|");
  for (const row of report.correctionLike.byTheme) {
    lines.push(`| ${row.id} | ${row.detectedCount} / ${row.utteranceCount} | ${row.recallPercent ?? "未計測"}% |`);
    if (row.detectedCount === 0) lines.push(`| ${row.id} 未検出 | 訂正語・直前5発話との3-gram重なりで拾えない束 | |`);
  }
  lines.push("");
  lines.push("束の外で検出した発話から無作為抽出（引用30字以内、セッションID先頭8字）:");
  lines.push("");
  for (const sample of report.correctionLike.outsideThemeSamples) {
    lines.push(`- ${sample.session} 「${sample.quote}」`);
  }
  lines.push("");
  lines.push("一度目の「全文出して」のような普通の依頼は、訂正語も直前依頼との重なりも無ければ検出しない。");
  lines.push("");
  lines.push("## 束ごとの照合");
  lines.push("");
  for (const theme of report.themes) {
    const range = theme.referenceRange.join("–");
    const pass = theme.withinReferenceRange ? "範囲内" : "範囲外";
    const sampleLines = theme.sampleQuotes.map((sample) => `- ${sample.session} ${sample.date} 「${sample.quote}」`);
    lines.push(`### ${theme.id} ${theme.name}`);
    lines.push("");
    lines.push(`件数: ${theme.count}。r2-k3目安: ${theme.referenceCount}（許容 ${range}、${pass}）。再発: ${theme.recurrenceCount}（同一セッション ${theme.sameSessionRepeatCount}、別セッション ${theme.crossSessionRepeatCount}）。趣旨一致の保存済み ${theme.storedAtRecurrenceCount}、他projectだけ ${theme.otherProjectOnlyAtRecurrenceCount}、初回後保存 ${theme.savedSinceFirstCount}、注入題名の記憶 ${theme.injectedTitleMemoryCount}、注入後再発 ${theme.injectedThenRepeatedCount}、通し番号31以降 ${theme.ordinal31PlusCount}。訂正判定 ${theme.correctionLikeCount}/${theme.count}件。`);
    if (theme.rangeReason) lines.push(`範囲外理由: ${theme.rangeReason}`);
    lines.push(`無作為抽出引用（最大10件、各30字以内）:`);
    lines.push(...sampleLines);
    lines.push("");
    lines.push("趣旨一致の記憶（題名・本文を照合。visible＝firebase-kitから可視、other-project＝別projectのみ）:");
    lines.push("");
    lines.push("| 可視性 | ストア | project | 日付 | 題名 | ID | 照合箇所 |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const memory of theme.memoryCoverageRecords) {
      lines.push(`| ${memory.visibility} | ${memory.store} | ${memory.project} | ${memory.date} | ${memory.title} | ${memory.id} | ${memory.matchedBy} |`);
    }
    if (theme.memoryCoverageRecords.length === 0) lines.push("| 該当なし | | | | | | |");
    lines.push("");
  }
  lines.push("## 再発上限の参照値との違い");
  lines.push("");
  lines.push("| 束 | 束件数 | Σ(束件数−1) |");
  lines.push("|---|---:|---:|");
  for (const row of report.recurrenceUpperBound.byBundle) {
    lines.push(`| ${row.bundle} | ${row.count} | ${row.value} |`);
  }
  for (const row of report.recurrenceUpperBound.byGroup) {
    lines.push(`| ${row.bundle} | ${row.count} | ${row.value} |`);
  }
  lines.push("");
  lines.push(report.recurrenceUpperBound.note);
  lines.push("");
  lines.push("## S1 検出・保存");
  lines.push("");
  lines.push(`束発話中の割り込み: ${report.s1.queuedThemeUtterances}。束発話後に分析Stopあり: ${report.s1.themeUtterancesWithAnalyzeStop}。Stopなし: ${report.s1.themeUtterancesWithoutAnalyzeStop}。全対象Stop: ${report.s1.allStopCount}件、所要時間が取れた件 ${report.s1.allStop.count}、中央値 ${report.s1.allStop.medianMs}ms、p90 ${report.s1.allStop.p90Ms}ms、3000ms以上 ${report.s1.allStop.atLeast3000Ms}件。`);
  lines.push("");
  lines.push("再発直前までに初回後保存された記憶（束・ストア・category別、各束の最初の再発まで）:");
  lines.push("");
  lines.push("| 束 | 保存記憶行数（ストア / category） |");
  lines.push("|---|---|");
  for (const theme of report.themes) {
    lines.push(`| ${theme.id} | ${JSON.stringify(theme.firstRepeatSavedRowsByStoreAndCategory)} |`);
  }
  lines.push("");
  lines.push("## S2 保存から注入");
  lines.push("");
  lines.push(`再発前に趣旨一致の記憶が可視: ${report.s2.storedRepeatCount}件。別projectにだけ存在: ${report.s2.otherProjectOnlyRepeatCount}件。注入題名と一致した趣旨一致の記憶: ${report.s2.injectedTitleMemoryCount}行。注入本文も含まれた記憶: ${report.injectionOverview.uniqueBodyIncludedMemoryRows}行。`);
  lines.push("");
  lines.push("「保存済み」は記憶のtimestampが再発より前で、projectがfirebase-kit・unknown・空、またはscopeがgeneral・globalの記憶だけを数える。記憶一覧はタイトルと本文の趣旨条件を満たす行。再発後の保存は含めない。");
  lines.push("");
  lines.push("## S3 注入後の再発");
  lines.push("");
  lines.push(`注入後の再発: ${report.s3.injectedThenRepeated.length}件。各件の人間発話番号・累積KB・経過分はJSONの注入後再発欄に記録。`);
  lines.push("");
  lines.push("## S4 長会話");
  lines.push("");
  lines.push("| 対象 | 通し番号 1-10 | 11-30 | 31-100 | 101+ | <200KB | 200–500KB | 500KB–1MB | 1MB+ | 未計測 |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  lines.push(`| 全体 | ${report.s4.all.ordinal["1-10"] ?? 0} | ${report.s4.all.ordinal["11-30"] ?? 0} | ${report.s4.all.ordinal["31-100"] ?? 0} | ${report.s4.all.ordinal["101+"] ?? 0} | ${report.s4.all.context["<200KB"] ?? 0} | ${report.s4.all.context["200–500KB"] ?? 0} | ${report.s4.all.context["500KB–1MB"] ?? 0} | ${report.s4.all.context["1MB+"] ?? 0} | ${report.s4.all.context["未計測"] ?? 0} |`);
  for (const theme of report.themes) {
    const value = report.s4.byTheme[theme.id];
    lines.push(`| ${theme.id} | ${value.ordinal["1-10"] ?? 0} | ${value.ordinal["11-30"] ?? 0} | ${value.ordinal["31-100"] ?? 0} | ${value.ordinal["101+"] ?? 0} | ${value.context["<200KB"] ?? 0} | ${value.context["200–500KB"] ?? 0} | ${value.context["500KB–1MB"] ?? 0} | ${value.context["1MB+"] ?? 0} | ${value.context["未計測"] ?? 0} |`);
  }
  lines.push("");
  lines.push("### B8・B9 発話番号全件");
  lines.push("");
  lines.push("| 束 | セッション | 日付 | 通し番号 | 累積KB区分 | 累積KB | 開始から分 |");
  lines.push("|---|---|---|---:|---|---:|---:|");
  for (const themeId of ["B8", "B9"]) {
    const theme = report.themes.find((item) => item.id === themeId);
    for (const occurrence of theme.occurrences) {
      lines.push(`| ${themeId} | ${occurrence.session} | ${occurrence.dateJst} | ${occurrence.humanOrdinal} | ${transcriptContextBucket(occurrence.contextKB)} | ${occurrence.contextKB ?? "未計測"} | ${occurrence.elapsedMinutes ?? "未計測"} |`);
    }
  }
  lines.push("");
  lines.push(`累積KBは会話記録ファイル内で発話を含む行の直前までにあるbyte数を1024で割った値。${report.s4.all.context["未計測"] ?? 0}件は行開始byte offsetを取得できず未計測。通し番号と開始からの経過分は従来どおり。`);
  lines.push("");
  lines.push("## SessionStart注入の全体像");
  lines.push("");
  lines.push(`対象 ${report.injectionOverview.targetSessionCount}セッション。注入成功記録あり ${report.injectionOverview.sessionsWithSuccessfulInjectionRecord}。成功記録なし ${report.injectionOverview.sessionsWithNoSuccessfulRecord}。題名ゼロの成功記録 ${report.injectionOverview.sessionsWithZeroTitleOnSuccessfulRecord}。最新記録で注入ゼロ ${report.injectionOverview.sessionsWithZeroTitleOnLatestAttempt}。TypeError記録 ${report.injectionOverview.typeErrorAttemptCount}。`);
  lines.push(`題名数分布（セッション数）: ${JSON.stringify(report.injectionOverview.titleCountDistribution)}。題名一致した記憶行: ${JSON.stringify(report.injectionOverview.uniqueInjectedMemoryRowsByStore)}。中央のfirebase-kit向け記憶 ${report.injectionOverview.centralFirebaseKitMemoryRows}行中、注入題名に一度も載らない行 ${report.injectionOverview.centralFirebaseKitRowsNeverInjected}。`);
  lines.push("");
  lines.push("## 期間内の記憶保存件数");
  lines.push("");
  lines.push("| ストア | 合計 | 日別・category別件数 |");
  lines.push("|---|---:|---|");
  for (const [store, counts] of Object.entries(report.memorySaves)) {
    lines.push(`| ${store} | ${counts.total} | ${JSON.stringify(counts.byDayAndCategory)} |`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function buildReport(sessions, memoryRows, transcriptAudit, analysis) {
  const themeById = new Map(analysis.themes.map((theme) => [theme.id, theme]));
  const b1Theme = analysis.themes.filter((theme) => theme.id === "B1");
  const b2ToB10Themes = analysis.themes.filter((theme) => theme.id !== "B1");
  const repeatOccurrences = analysis.themes.flatMap((theme) => theme.occurrences.filter((occurrence) => occurrence.isRepeat));
  const allStops = sessions.flatMap((session) => session.stopEvents.map((event) => event.durationMs));
  const injectStats = countInjectionOverview(sessions, memoryRows);
  const memorySaves = buildMemorySaveCounts(memoryRows);
  const queuedThemeUtterances = analysis.themes.reduce((sum, theme) => sum + theme.queuedCount, 0);
  const themeUtterancesWithAnalyzeStop = analysis.themes.reduce((sum, theme) => sum + theme.stopObservedCount, 0);
  const themeUtteranceTotal = analysis.themes.reduce((sum, theme) => sum + theme.count, 0);

  const summarizeThemeGroup = (bundle, groupedThemes) => groupedThemes.reduce((sum, theme) => ({
    bundle,
    recurrenceCount: sum.recurrenceCount + theme.recurrenceCount,
    storedAtRecurrenceCount: sum.storedAtRecurrenceCount + theme.storedAtRecurrenceCount,
    otherProjectOnlyAtRecurrenceCount: sum.otherProjectOnlyAtRecurrenceCount + theme.otherProjectOnlyAtRecurrenceCount,
    injectedTitleMemoryCount: sum.injectedTitleMemoryCount + theme.injectedTitleMemoryCount,
    injectedThenRepeatedCount: sum.injectedThenRepeatedCount + theme.injectedAtRecurrenceCount,
    ordinal31PlusCount: sum.ordinal31PlusCount + theme.ordinal31PlusCount,
  }), {
    bundle,
    recurrenceCount: 0,
    storedAtRecurrenceCount: 0,
    otherProjectOnlyAtRecurrenceCount: 0,
    injectedTitleMemoryCount: 0,
    injectedThenRepeatedCount: 0,
    ordinal31PlusCount: 0,
  });
  const summaryTable = [
    summarizeThemeGroup("B1", b1Theme),
    summarizeThemeGroup("B2〜B10 合計", b2ToB10Themes),
    summarizeThemeGroup("全体", analysis.themes),
  ];
  const s2S3Summary = summaryTable;
  const stages = [
    { id: "S1", name: "再発時点で該当記憶が存在しない", count: analysis.stageCounts.S1 },
    { id: "S2", name: "記憶は存在するが題名が注入されていない", count: analysis.stageCounts.S2 },
    { id: "S3", name: "題名が注入されても再発", count: analysis.stageCounts.S3 },
  ];
  const largestStage = [...stages].sort((left, right) => right.count - left.count)[0];
  const conclusion = `漏れが最大の段は ${largestStage.id}（${largestStage.name}）で ${largestStage.count}件だった。`;

  const themes = analysis.themes.map((theme) => {
    const firstRepeat = theme.occurrences.find((occurrence) => occurrence.isRepeat);
    const repeatEvents = theme.occurrences.filter((occurrence) => occurrence.isRepeat);
    const stopStats = summarizeDurations(theme.stopDurationsMs);
    const sampleQuotes = countBundleSamples(theme);
    const rangeAudit = {
      B3: `無作為抽出${sampleQuotes.length}件は要約の分量・字数・形式・規則の趣旨内。長すぎる基準を問う言い換えを加えた。未一致の要約語＋規則語候補5件は一般的な要約依頼や原文・要約の画面操作で、束へ足すと趣旨が広がる。`,
      B4: `全${sampleQuotes.length}件を確認し、すべてDS準拠の指示または無断変更への指摘。未一致のデザイン語＋変更語候補12件はモデル・モック依頼、UI選択、HTML調査などで、DS外変更の指摘ではない。許容下限へ合わせる語は追加しない。`,
      B6: `無作為抽出${sampleQuotes.length}件は確認・裏取り・レビュー指示の趣旨内。目安14件の許容上限16件を2件超えるが、範囲へ合わせる語の削除はしない。`,
    }[theme.id];
    const rangeReason = !theme.withinReferenceRange
      ? theme.count < theme.referenceRange[0]
        ? `${theme.count}件。許容${theme.referenceRange[0]}〜${theme.referenceRange[1]}件。下限に${theme.referenceRange[0] - theme.count}件不足。${rangeAudit ?? `無作為抽出${sampleQuotes.length}件を確認。範囲へ合わせるための趣旨外語は追加しない。`}`
        : `${theme.count}件。許容${theme.referenceRange[0]}〜${theme.referenceRange[1]}件。上限を${theme.count - theme.referenceRange[1]}件超過。${rangeAudit ?? `無作為抽出${sampleQuotes.length}件を確認。範囲へ合わせるための趣旨外語は追加しない。`}`
      : null;
    return {
      id: theme.id,
      name: theme.name,
      referenceCount: theme.referenceCount,
      referenceRange: theme.referenceRange,
      count: theme.count,
      withinReferenceRange: theme.withinReferenceRange,
      rangeReason,
      recurrenceCount: theme.recurrenceCount,
      sameSessionRepeatCount: theme.sameSessionRepeatCount,
      crossSessionRepeatCount: theme.crossSessionRepeatCount,
      storedAtRecurrenceCount: theme.storedAtRecurrenceCount,
      savedSinceFirstCount: theme.savedSinceFirstCount,
      firstRepeatSavedRowsByStoreAndCategory: firstRepeat?.savedSinceFirstByStoreAndCategory ?? {},
      otherProjectOnlyAtRecurrenceCount: theme.otherProjectOnlyAtRecurrenceCount,
      injectedTitleMemoryCount: theme.injectedTitleMemoryCount,
      injectedAtRecurrenceCount: theme.injectedAtRecurrenceCount,
      injectedThenRepeatedCount: theme.injectedAtRecurrenceCount,
      injectedBodyRepeatCount: theme.injectedBodyRepeatCount,
      ordinal31PlusCount: theme.ordinal31PlusCount,
      queuedCount: theme.queuedCount,
      correctionLikeCount: theme.correctionLikeCount,
      correctionLikeRecall: theme.correctionLikeRecall,
      correctionLikeRecallPercent: theme.correctionLikeRecall === null
        ? null
        : Math.round(theme.correctionLikeRecall * 10000) / 100,
      memoryCoverageRecords: theme.memoryCoverageRecords.map((memory) => ({
        ...memory,
        title: Array.from(safeQuoteText(memory.title)).slice(0, 30).join(""),
      })),
      stop: { count: theme.stopCountAfter, durations: stopStats },
      sampleQuotes,
      occurrences: theme.occurrences.map(safeOccurrence),
      recurrenceOccurrences: repeatEvents.map(safeOccurrence),
    };
  });

  const totalBundleCounts = analysis.themes.reduce((sum, theme) => sum + theme.count, 0);
  const boundForThemes = (themeRows) => themeRows.reduce((sum, theme) => sum + Math.max(0, theme.count - 1), 0);
  const boundByBundle = analysis.themes.map((theme) => ({
    bundle: theme.id,
    count: theme.count,
    value: Math.max(0, theme.count - 1),
  }));
  const boundByGroup = [
    {
      bundle: "B1",
      count: b1Theme.reduce((sum, theme) => sum + theme.count, 0),
      value: boundForThemes(b1Theme),
    },
    {
      bundle: "B2〜B10 合計",
      count: b2ToB10Themes.reduce((sum, theme) => sum + theme.count, 0),
      value: boundForThemes(b2ToB10Themes),
    },
    {
      bundle: "全体",
      count: totalBundleCounts,
      value: boundForThemes(analysis.themes),
    },
  ];
  const repeatUpperBound = boundForThemes(analysis.themes);
  const r2UpperBound = 139;
  const targetSessionCount = sessions.length;
  const targetHumanCounts = countHumanInputTypes(sessions.flatMap((session) => session.humanInputs));
  const mainHumanUtterances = targetHumanCounts.main;
  const queuedHumanUtterances = targetHumanCounts.queued;
  const totalHumanUtterances = targetHumanCounts.total;
  const candidateAudit = { handoffPaste: 0, slashCommand: 0, over300Chars: 0, themeCandidate: 0 };
  const themeCandidateExclusionsByReason = {
    "引継ぎ貼付": 0,
    "スラッシュコマンド": 0,
    "300字超": 0,
    "束判定候補": 0,
  };
  for (const session of sessions) {
    for (const input of session.humanInputs) {
      if (isHandoffPaste(input.text)) candidateAudit.handoffPaste += 1;
      if (isSlashCommand(input.text)) candidateAudit.slashCommand += 1;
      if (Array.from(input.text).length > 300) candidateAudit.over300Chars += 1;
      if (Array.from(input.text).length <= 300 && !isHandoffPaste(input.text) && !isSlashCommand(input.text)) {
        candidateAudit.themeCandidate += 1;
      }
      if (isHandoffPaste(input.text)) {
        themeCandidateExclusionsByReason["引継ぎ貼付"] += 1;
      } else if (isSlashCommand(input.text)) {
        themeCandidateExclusionsByReason["スラッシュコマンド"] += 1;
      } else if (Array.from(input.text).length > 300) {
        themeCandidateExclusionsByReason["300字超"] += 1;
      } else {
        themeCandidateExclusionsByReason["束判定候補"] += 1;
      }
    }
  }

  const s4Buckets = (occurrences) => ({
    ordinal: countBuckets(occurrences, (item) => item.humanOrdinal, ordinalBucket),
    context: countBuckets(occurrences, (item) => item.contextKB, transcriptContextBucket),
  });
  const allRepeatEvents = repeatOccurrences.map(safeOccurrence);
  const correctionBundleInputs = new Map();
  for (const theme of b2ToB10Themes) {
    for (const occurrence of theme.occurrences) {
      const key = `${occurrence.sessionId}:${occurrence.order}`;
      correctionBundleInputs.set(key, (correctionBundleInputs.get(key) ?? false) || occurrence.correctionLike);
    }
  }
  const correctionDenominator = correctionBundleInputs.size;
  const correctionNumerator = [...correctionBundleInputs.values()].filter(Boolean).length;
  const correctionByTheme = b2ToB10Themes.map((theme) => ({
    id: theme.id,
    detectedCount: theme.correctionLikeCount,
    utteranceCount: theme.count,
    recall: theme.count === 0 ? null : theme.correctionLikeCount / theme.count,
    recallPercent: theme.count === 0 ? null : Math.round((theme.correctionLikeCount / theme.count) * 10000) / 100,
  }));
  const recurrenceUpperBound = {
    calculatedByPerThemeFormula: repeatUpperBound,
    sumOfThemeOccurrences: totalBundleCounts,
    themeCount: analysis.themes.length,
    referenceR2K3: r2UpperBound,
    byBundle: boundByBundle,
    byGroup: boundByGroup,
    note: `r2-k3の目安139件は、目安件数を使ったB2〜B10のΣ(束件数−1)。B1は部分扱いで除外。今回の実測式はB1 ${boundByGroup[0].value}件、B2〜B10 ${boundByGroup[1].value}件、全体 ${repeatUpperBound}件。`,
  };
  const b2ToB10RecallPercent = correctionDenominator === 0
    ? null
    : Math.round((correctionNumerator / correctionDenominator) * 10000) / 100;
  const currentB1Summary = summaryTable.find((row) => row.bundle === "B1");
  const currentB1Theme = analysis.themes.find((theme) => theme.id === "B1");
  const correctionOutsideThemeSamples = sampleCorrectionFalsePositives(analysis.correctionLikeOutsideThemeInputs);
  const r2ComparableTotal = transcriptAudit.r2ComparableMainHumanUtterances
    + transcriptAudit.r2ComparableQueuedHumanUtterances;
  const excludedOtherIdHumanCount = transcriptAudit.excludedSessionHumanInputCounts
    .filter((row) => row.id !== "dccb7da4")
    .reduce((sum, row) => sum + row.total, 0);
  const currentSelectionRemovalCounts = {
    otherExcludedIds: transcriptAudit.excludedSessionHumanInputCounts
      .filter((row) => row.id !== "dccb7da4")
      .reduce((sum, row) => ({
        main: sum.main + row.main,
        queued: sum.queued + row.queued,
        total: sum.total + row.total,
      }), { main: 0, queued: 0, total: 0 }),
    periodOutsideSessions: transcriptAudit.periodOutsideHumanInputCounts,
    inScopeSessionsOutsidePeriod: transcriptAudit.humanUtterancesOutsidePeriodCounts,
    zeroHumanInputSessions: { main: 0, queued: 0, total: 0 },
  };
  const currentSelectionRemovalTotal = Object.values(currentSelectionRemovalCounts)
    .reduce((sum, counts) => sum + counts.total, 0);
  const currentSelectionRemovalMain = Object.values(currentSelectionRemovalCounts)
    .reduce((sum, counts) => sum + counts.main, 0);
  const currentSelectionRemovalQueued = Object.values(currentSelectionRemovalCounts)
    .reduce((sum, counts) => sum + counts.queued, 0);
  const b1CoverageAudit = {
    total: currentB1Theme.memoryCoverageRecords.length,
    visible: currentB1Theme.memoryCoverageRecords.filter((row) => row.visibility === "visible").length,
    otherProjectOnly: currentB1Theme.memoryCoverageRecords.filter((row) => row.visibility === "other-project").length,
    injectedTitleRowsByStore: injectStats.uniqueInjectedMemoryRowsByStore,
  };
  const r2Comparison = {
    sessionCount: 106,
    sessionDifference: 106 - targetSessionCount,
    sourceDirectJsonlFileCount: 107,
    currentDirectoryFileDifference: transcriptAudit.directJsonlFileCount - 107,
    humanUtteranceCount: 1235,
    humanUtteranceDifference: 1235 - totalHumanUtterances,
    sourceMainHumanUtteranceCount: 1126,
    sourceQueuedHumanUtteranceCount: 109,
    currentSourceMainHumanUtteranceCount: transcriptAudit.r2ComparableMainHumanUtterances,
    currentSourceQueuedHumanUtteranceCount: transcriptAudit.r2ComparableQueuedHumanUtterances,
    currentSourceHumanUtteranceCount: r2ComparableTotal,
    currentSourceHumanUtteranceDifference: 1235 - r2ComparableTotal,
    currentSelectionRemovalCounts,
    currentSelectionRemovalTotal,
    currentSelectionRemovalMain,
    currentSelectionRemovalQueued,
    sourceHandoffExclusionCount: 65,
    sourceSlashExclusionCount: 32,
    sourceEmptyExclusionCount: 2,
    note: `r2-k3の1235件はtype=user 1126件＋queued_command 109件。現行直下JSONLは${transcriptAudit.directJsonlFileCount}本（r2-k3元107本比${transcriptAudit.directJsonlFileCount - 107}）。dccb7da4除外後の現行${transcriptAudit.directJsonlFileCount - 1}本を同じ抽出条件で再走査すると${r2ComparableTotal}件（main ${transcriptAudit.r2ComparableMainHumanUtterances}、queued ${transcriptAudit.r2ComparableQueuedHumanUtterances}）で、元集計との差${1235 - r2ComparableTotal}件は今回の期間・束判定除外の前から残る。今回の対象化でdccb7da4はr2-k3と同じく除外。追加で57b0207cなど指定ID ${excludedOtherIdHumanCount}件、期間外セッション${transcriptAudit.periodOutsideCount}件中の発話${transcriptAudit.periodOutsideHumanInputCount}件、対象セッション内の期間外発話${transcriptAudit.humanUtterancesOutsidePeriodCount}件を除き、${totalHumanUtterances}件。人間発話0件の${transcriptAudit.zeroHumanInputCount}セッションは0件を除外。束判定だけから引継ぎ貼付 ${themeCandidateExclusionsByReason["引継ぎ貼付"]}件、スラッシュ ${themeCandidateExclusionsByReason["スラッシュコマンド"]}件、300字超 ${themeCandidateExclusionsByReason["300字超"]}件を外す。これらは人間発話合計には適用しない。元集計との差${1235 - r2ComparableTotal}件を引継ぎ・コマンド等へ割り当てる根拠はない。`,
  };

  return {
    summaryTable,
    s2S3Summary,
    conclusion,
    b1OldInjectedTitleCount: 197,
    b1InjectedTitleMemoryCount: currentB1Summary.injectedTitleMemoryCount,
    b1CoverageAudit,
    metadata: {
      dateRangeJst: [DATE_START, DATE_END],
      sourceFileCount: transcriptAudit.directJsonlFileCount,
      targetSessionCount,
      sessionAudit: transcriptAudit,
      sourceDirectoriesRead: ["Claude projects直下のJSONL", "中央記憶DB", "ローカル記憶DB"],
      databaseAccess: "better-sqlite3 readonly:true、SELECTのみ",
      transcriptReadMode: "ファイルごと逐次読み、発話行より前のbyte offsetを記録",
      transcriptContextMethod: "発話を含むJSONL行の直前byte offsetを累積KBへ変換。token差は出力しない",
      r2Definition: "out-r2-k3.md 1.1・1.6。107本からdccb7da4を除き106本、通常user1126件＋queued109件=1235件。束判定除外は引継ぎ65件・スラッシュ32件・空等を人間発話合計と分ける",
      formulaConflict: recurrenceUpperBound.note,
    },
    population: {
      targetSessions: targetSessionCount,
      directJsonlFileCount: transcriptAudit.directJsonlFileCount,
      periodOutsideCount: transcriptAudit.periodOutsideCount,
      excludedSessionIds: transcriptAudit.excludedSessionIds,
      zeroHumanInputCount: transcriptAudit.zeroHumanInputCount,
      unknownFirstHumanDateCount: transcriptAudit.unknownFirstHumanDateCount,
      humanUtterancesOutsidePeriodCount: transcriptAudit.humanUtterancesOutsidePeriodCount,
      periodOutsideHumanInputCount: transcriptAudit.periodOutsideHumanInputCount,
      r2ComparableMainHumanUtterances: transcriptAudit.r2ComparableMainHumanUtterances,
      r2ComparableQueuedHumanUtterances: transcriptAudit.r2ComparableQueuedHumanUtterances,
      excludedSessionHumanInputCounts: transcriptAudit.excludedSessionHumanInputCounts,
      periodOutsideHumanInputCounts: transcriptAudit.periodOutsideHumanInputCounts,
      humanUtterancesOutsidePeriodCounts: transcriptAudit.humanUtterancesOutsidePeriodCounts,
      mainHumanUtterances,
      queuedHumanUtterances,
      totalHumanUtterances,
      themeCandidates: candidateAudit.themeCandidate,
      excludedFromThemeCandidates: candidateAudit,
      themeCandidateExclusionsByReason,
      r2CurrentSourceMainHumanUtterances: transcriptAudit.r2ComparableMainHumanUtterances,
      r2CurrentSourceQueuedHumanUtterances: transcriptAudit.r2ComparableQueuedHumanUtterances,
      r2Comparison,
      auditCounts: sessions.reduce((total, session) => {
        for (const [key, value] of Object.entries(session.auditCounts)) total[key] = (total[key] ?? 0) + value;
        return total;
      }, {}),
    },
    correctionLike: {
      detectedCount: analysis.correctionLikeCount,
      humanUtteranceCount: analysis.eligibleHumanCount,
      detectedPercent: analysis.eligibleHumanCount === 0
        ? null
        : Math.round((analysis.correctionLikeCount / analysis.eligibleHumanCount) * 10000) / 100,
      b2ToB10DetectedCount: correctionNumerator,
      b2ToB10UtteranceCount: correctionDenominator,
      b2ToB10RecallPercent,
      byTheme: correctionByTheme,
      outsideThemeSamples: correctionOutsideThemeSamples,
    },
    recurrenceUpperBound,
    stageCounts: analysis.stageCounts,
    stages,
    themes,
    s1: {
      queuedThemeUtterances,
      themeUtterancesWithAnalyzeStop,
      themeUtterancesWithoutAnalyzeStop: themeUtteranceTotal - themeUtterancesWithAnalyzeStop,
      allStop: summarizeDurations(allStops),
      allStopCount: allStops.length,
      repeatStopDurationsMs: repeatOccurrences.flatMap((occurrence) => occurrence.stopDurationsMs),
      repeatStopStats: summarizeDurations(repeatOccurrences.flatMap((occurrence) => occurrence.stopDurationsMs)),
    },
    s2: {
      storedRepeatCount: repeatOccurrences.filter((occurrence) => occurrence.storedAtRecurrence).length,
      otherProjectOnlyRepeatCount: repeatOccurrences.filter((occurrence) => occurrence.otherProjectOnlyAtRecurrence).length,
      injectedTitleMemoryCount: summaryTable.find((row) => row.bundle === "全体").injectedTitleMemoryCount,
      injectedRepeatCount: repeatOccurrences.filter((occurrence) => occurrence.injectedAtRecurrence).length,
      savedSinceFirstRepeatCount: repeatOccurrences.filter((occurrence) => occurrence.savedSinceFirst).length,
      repeatEvidenceByTheme: Object.fromEntries(analysis.themes.map((theme) => [
        theme.id,
        {
          storedRepeats: theme.storedAtRecurrenceCount,
          firstRepeatRowsSavedAfterFirstOccurrence: theme.occurrences.find((occurrence) => occurrence.isRepeat)
            ?.savedSinceFirstByStoreAndCategory ?? {},
        },
      ])),
    },
    s3: {
      injectedThenRepeated: repeatOccurrences.filter((occurrence) => occurrence.injectedAtRecurrence).map(safeOccurrence),
    },
    s4: {
      all: s4Buckets(repeatOccurrences),
      byTheme: Object.fromEntries(analysis.themes.map((theme) => [
        theme.id,
        s4Buckets(theme.occurrences.filter((occurrence) => occurrence.isRepeat)),
      ])),
      allRecurrences: allRepeatEvents,
      b8B9AllOccurrences: Object.fromEntries(["B8", "B9"].map((id) => [
        id,
        themeById.get(id).occurrences.map(safeOccurrence),
      ])),
    },
    injectionOverview: countInjectionOverview(sessions, memoryRows),
    memorySaves,
  };
}

async function main() {
  const transcriptResult = await readTranscriptSessions();
  const centralRows = readMemoryRows(join(ROOT, ".wasurenagusa/memory.db"), "central");
  const localRows = readMemoryRows(join(homedir(), "projects/firebase-kit/.wasurenagusa/memory.db"), "local");
  const memoryRows = [...centralRows, ...localRows];
  const analysis = buildOccurrenceMetrics(transcriptResult.sessions, memoryRows);
  const report = buildReport(transcriptResult.sessions, memoryRows, transcriptResult.audit, analysis);
  report.metadata.centralMemoryRowCount = centralRows.length;
  report.metadata.localMemoryRowCount = localRows.length;
  report.metadata.stopSummaryCount = report.s1.allStopCount;
  report.metadata.injectedBodyCount = report.injectionOverview.uniqueBodyIncludedMemoryRows;
  report.metadata.themeReferenceChecks = report.themes.map((theme) => ({
    id: theme.id,
    referenceCount: theme.referenceCount,
    actualCount: theme.count,
    acceptableRange: theme.referenceRange,
    withinRange: theme.withinReferenceRange,
    reason: theme.rangeReason,
  }));

  const markdown = buildMarkdown(report);
  const reportDirectory = join(ROOT, ".wasurenagusa/reports/replay");
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(join(reportDirectory, "baseline-funnel.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(join(reportDirectory, "baseline-funnel.md"), markdown, "utf8");

  const table = [
    "| 集計 | 再発 | 保存済み | 注入題名の記憶 | 注入後再発 | 番号31以降 |",
    "|---|---:|---:|---:|---:|---:|",
    ...report.summaryTable.map((row) => `| ${row.bundle} | ${row.recurrenceCount} | ${row.storedAtRecurrenceCount} | ${row.injectedTitleMemoryCount} | ${row.injectedThenRepeatedCount} | ${row.ordinal31PlusCount} |`),
  ];
  process.stdout.write(`${table.join("\n")}\n`);
}

await main();
