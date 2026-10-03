import { isCorrectionLike, matchThemes, matchesMemoryCoverage, THEMES } from "./themes.mjs";

const HANDOFF_MARKER = /(?:復帰ブロック|引継ぎ命令テキスト|引き継ぎ命令テキスト|引継ぎブロック|引き継ぎブロック|復帰用(?:ブロック|指示)|引継ぎ用(?:ブロック|指示)|handoff[- _]?text\.md|resume(?:\s|-)?block)/iu;
const SLASH_COMMAND = /^\/[a-z][a-z0-9-]*(?:\s|$)/iu;
const SYSTEM_REMINDER = /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder\s*>/giu;
const IDE_BLOCK = /<ide_[\w-]+\b[^>]*>[\s\S]*?<\/ide_[\w-]+\s*>/giu;
const IDE_EMPTY = /<ide_[\w-]+\b[^>]*\/?>/giu;

export function cleanHumanText(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(SYSTEM_REMINDER, " ")
    .replace(IDE_BLOCK, " ")
    .replace(IDE_EMPTY, " ")
    .replace(/[\t ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .trim();
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

export function extractHumanUtterance(event) {
  if (!event || event.isSidechain === true) return null;

  if (event.type === "user") {
    if (event.origin?.kind !== "human") return null;
    if (event.isMeta === true && event.promptSource === "system") return null;
    const text = cleanHumanText(textFromContent(event.message?.content));
    if (!text) return null;
    return { text, queued: false, sourceType: "user" };
  }

  if (event.type !== "attachment") return null;
  const attachment = event.attachment ?? {};
  if (attachment.type !== "queued_command" || attachment.commandMode !== "prompt") return null;
  const originKind = event.origin?.kind ?? attachment.origin?.kind;
  if (originKind !== "human") return null;
  const text = cleanHumanText(textFromContent(attachment.prompt));
  if (!text) return null;
  return { text, queued: true, sourceType: "queued_command" };
}

export function isSlashCommand(text) {
  const firstLine = text.split("\n", 1)[0].trim();
  return SLASH_COMMAND.test(firstLine);
}

export function isHandoffPaste(text) {
  return HANDOFF_MARKER.test(text);
}

export function isThemeCandidate(text) {
  return Array.from(text).length <= 300 && !isSlashCommand(text) && !isHandoffPaste(text);
}

export function countHumanInputTypes(inputs) {
  let main = 0;
  let queued = 0;
  for (const input of inputs) {
    if (input.queued) queued += 1;
    else main += 1;
  }
  return { main, queued, total: main + queued };
}

export function extractInjectedEntries(text) {
  if (typeof text !== "string") return [];
  const entries = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(?:[-*]\s*)?\[([^\]]+)\]\s+(.+?)\s+\(([^()]*)\)\s*$/u.exec(line);
    if (!match) continue;
    entries.push({
      category: match[1].trim(),
      title: match[2].trim(),
      id: match[3].trim(),
    });
  }
  return entries;
}

export function percentile(values, quantile) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (quantile === 0.5 && sorted.length % 2 === 0) {
    const upper = sorted.length / 2;
    return (sorted[upper - 1] + sorted[upper]) / 2;
  }
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)];
}

export function jstDate(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function numericTime(timestamp) {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : null;
}

function sortByOrder(left, right) {
  return left.order - right.order;
}

function groupRows(rows) {
  const counts = {};
  for (const row of rows) {
    const store = row.store ?? "unknown";
    const category = row.category ?? "unknown";
    if (!counts[store]) counts[store] = {};
    counts[store][category] = (counts[store][category] ?? 0) + 1;
  }
  return counts;
}

function availableBefore(row, at) {
  const rowTime = numericTime(row.timestamp);
  if (rowTime === null || at === null || rowTime >= at) return false;
  if (!row.deleted_at) return true;
  const deletedTime = numericTime(row.deleted_at);
  return deletedTime !== null && deletedTime > at;
}

function visibleInFirebaseKit(row) {
  const project = String(row.project ?? "").trim().toLocaleLowerCase();
  const scope = String(row.scope ?? "").trim().toLocaleLowerCase();
  return project === "firebase-kit"
    || project === ""
    || project === "unknown"
    || scope === "general"
    || scope === "global";
}

function injectionAtOrder(injectionEvents, order) {
  const prior = injectionEvents.filter((event) => event.order < order).sort(sortByOrder);
  const titles = new Set();
  const texts = [];
  for (const injection of prior) {
    for (const entry of injection.entries ?? []) titles.add(entry.title);
    if (typeof injection.text === "string") texts.push(injection.text);
  }
  return { titles, texts, events: prior };
}

function normalizeForBodyMatch(text) {
  return String(text ?? "").replace(/\s+/gu, " ").trim();
}

function countRowsBy(rows) {
  return groupRows(rows);
}

export function contextAtTranscriptOffset(byteOffset) {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
    return { contextByteOffset: null, contextKB: null };
  }
  return {
    contextByteOffset: byteOffset,
    contextKB: Math.round((byteOffset / 1024) * 100) / 100,
  };
}

export function transcriptContextBucket(contextKB) {
  if (!Number.isFinite(contextKB)) return "未計測";
  if (contextKB < 200) return "<200KB";
  if (contextKB < 500) return "200–500KB";
  if (contextKB < 1024) return "500KB–1MB";
  return "1MB+";
}

export function buildOccurrenceMetrics(sessions, memoryRows, themes = THEMES) {
  const preparedSessions = sessions.map((session, sessionIndex) => {
    const humanInputs = session.humanInputs
      .map((input) => ({ ...input, text: cleanHumanText(input.text) }))
      .filter((input) => input.text)
      .sort(sortByOrder);
    const stopEvents = [...session.stopEvents].sort(sortByOrder);
    const injectionEvents = [...session.injectionEvents].sort(sortByOrder);
    const startMs = numericTime(session.startAt);
    const inputs = humanInputs.map((input, index) => {
      const nextInput = humanInputs[index + 1];
      const followupStops = stopEvents.filter((stop) =>
        stop.order > input.order && (!nextInput || stop.order < nextInput.order),
      );
      const injection = injectionAtOrder(injectionEvents, input.order);
      const timestampMs = numericTime(input.timestamp);
      const candidate = isThemeCandidate(input.text);
      const priorTexts = humanInputs.slice(Math.max(0, index - 5), index).map((previous) => previous.text);
      const context = contextAtTranscriptOffset(input.transcriptByteOffset);
      return {
        ...input,
        sessionIndex,
        ordinal: index + 1,
        candidate,
        dateJst: jstDate(input.timestamp),
        elapsedMinutes: startMs === null || timestampMs === null
          ? null
          : Math.round(((timestampMs - startMs) / 60000) * 100) / 100,
        contextByteOffset: context.contextByteOffset,
        contextKB: context.contextKB,
        correctionLike: isCorrectionLike(input.text, priorTexts),
        stopEventsAfter: followupStops,
        injectionTitles: injection.titles,
        injectionTexts: injection.texts,
        injections: injection.events,
        timestampMs,
      };
    });
    return { ...session, sessionIndex, humanInputs: inputs };
  });

  const memoryMatches = new Map(themes.map((theme) => [
    theme.id,
    memoryRows.filter((row) => matchesMemoryCoverage(theme.id, row)),
  ]));
  const occurrencesByTheme = new Map(themes.map((theme) => [theme.id, []]));
  const injectedMemoryIdsByTheme = new Map(themes.map((theme) => [theme.id, new Set()]));
  const correctionLikeOutsideThemeInputs = [];
  let eligibleHumanCount = 0;
  let themeCandidateCount = 0;
  let correctionLikeCount = 0;
  const themeInputIds = new Set();
  const correctionLikeThemeInputIds = new Set();

  for (const session of preparedSessions) {
    for (const input of session.humanInputs) {
      eligibleHumanCount += 1;
      if (input.correctionLike) correctionLikeCount += 1;
      const matchedThemes = input.candidate
        ? matchThemes(input.text).filter((item) => themes.some((configured) => configured.id === item.id))
        : [];
      if (input.candidate) themeCandidateCount += 1;
      if (input.correctionLike && matchedThemes.length === 0) {
        correctionLikeOutsideThemeInputs.push({
          sessionId: session.sessionId,
          order: input.order,
          dateJst: input.dateJst,
          quoteSource: input.text,
        });
      }
      for (const theme of matchedThemes) {
        const eventId = `${session.sessionId}:${input.order}`;
        themeInputIds.add(eventId);
        if (input.correctionLike) correctionLikeThemeInputIds.add(eventId);
        for (const row of memoryMatches.get(theme.id)) {
          if (!visibleInFirebaseKit(row)) continue;
          const rowId = `${row.store ?? "unknown"}:${row.id ?? ""}`;
          const appearedInPriorInjection = input.injections.some((injection) => {
            const injectionTime = numericTime(injection.timestamp);
            return availableBefore(row, injectionTime)
              && injectionTime < input.timestampMs
              && (injection.entries ?? []).some((entry) => entry.title === row.title);
          });
          if (appearedInPriorInjection) injectedMemoryIdsByTheme.get(theme.id).add(rowId);
        }
        occurrencesByTheme.get(theme.id).push({
          themeId: theme.id,
          name: theme.name,
          sessionId: session.sessionId,
          timestamp: input.timestamp,
          dateJst: input.dateJst,
          order: input.order,
          humanOrdinal: input.ordinal,
          queued: input.queued,
          elapsedMinutes: input.elapsedMinutes,
          contextByteOffset: input.contextByteOffset,
          contextKB: input.contextKB,
          correctionLike: input.correctionLike,
          quoteSource: input.text,
          stopDurationsMs: input.stopEventsAfter.map((stop) => stop.durationMs),
          stopCountAfter: input.stopEventsAfter.length,
          injectionTitles: input.injectionTitles,
          injectionTexts: input.injectionTexts,
          injections: input.injections,
          sessionIndex: session.sessionIndex,
          timestampMs: input.timestampMs,
        });
      }
    }
  }

  const themeResults = themes.map((theme) => {
    const occurrences = occurrencesByTheme.get(theme.id).sort((left, right) =>
      left.timestampMs - right.timestampMs || left.sessionIndex - right.sessionIndex || left.order - right.order,
    );
    const matchingMemories = memoryMatches.get(theme.id);
    let firstOccurrence = null;
    let previousOccurrence = null;

    for (let index = 0; index < occurrences.length; index += 1) {
      const occurrence = occurrences[index];
      const isRepeat = index > 0;
      if (!firstOccurrence) firstOccurrence = occurrence;
      occurrence.recurrenceIndex = index + 1;
      occurrence.isRepeat = isRepeat;
      occurrence.previousSessionId = previousOccurrence?.sessionId ?? null;
      occurrence.sessionRepeatType = !isRepeat
        ? null
        : previousOccurrence.sessionId === occurrence.sessionId ? "same-session" : "cross-session";

      const visibleMemories = isRepeat
        ? matchingMemories.filter((row) => visibleInFirebaseKit(row) && availableBefore(row, occurrence.timestampMs))
        : [];
      const otherProjectMemories = isRepeat
        ? matchingMemories.filter((row) => !visibleInFirebaseKit(row) && availableBefore(row, occurrence.timestampMs))
        : [];
      const savedSinceFirst = isRepeat
        ? visibleMemories.filter((row) => {
          const rowTime = numericTime(row.timestamp);
          return rowTime !== null && firstOccurrence.timestampMs !== null && occurrence.timestampMs !== null
            && rowTime > firstOccurrence.timestampMs && rowTime < occurrence.timestampMs;
        })
        : [];
      const injectedMemories = visibleMemories.filter((row) => occurrence.injections.some((injection) => {
        const injectionTime = numericTime(injection.timestamp);
        return availableBefore(row, injectionTime)
          && injectionTime < occurrence.timestampMs
          && (injection.entries ?? []).some((entry) => entry.title === row.title);
      }));
      const injectedBodyMemories = injectedMemories.filter((row) => {
        const body = normalizeForBodyMatch(row.content);
        if (!body) return false;
        return occurrence.injectionTexts.some((text) => normalizeForBodyMatch(text).includes(body));
      });
      occurrence.storedAtRecurrence = isRepeat && visibleMemories.length > 0;
      occurrence.otherProjectOnlyAtRecurrence = isRepeat
        && visibleMemories.length === 0
        && otherProjectMemories.length > 0;
      occurrence.injectedAtRecurrence = isRepeat && injectedMemories.length > 0;
      occurrence.savedSinceFirst = isRepeat && savedSinceFirst.length > 0;
      occurrence.leakStage = !isRepeat
        ? null
        : !occurrence.storedAtRecurrence ? "S1" : !occurrence.injectedAtRecurrence ? "S2" : "S3";
      occurrence.storedMemoryRowsByStoreAndCategory = countRowsBy(visibleMemories);
      occurrence.savedSinceFirstByStoreAndCategory = countRowsBy(savedSinceFirst);
      occurrence.injectedMemoryRowsByStoreAndCategory = countRowsBy(injectedMemories);
      occurrence.injectedBodyMemoryRowsByStoreAndCategory = countRowsBy(injectedBodyMemories);
      occurrence.injectionTitleCount = occurrence.injectionTitles.size;
      delete occurrence.injections;
      delete occurrence.injectionTitles;
      delete occurrence.injectionTexts;
      delete occurrence.timestampMs;
      delete occurrence.sessionIndex;
      previousOccurrence = occurrence;
    }

    const repeats = occurrences.filter((occurrence) => occurrence.isRepeat);
    return {
      id: theme.id,
      name: theme.name,
      referenceCount: theme.referenceCount,
      referenceRange: [Math.ceil(theme.referenceCount * 0.8), Math.floor(theme.referenceCount * 1.2)],
      count: occurrences.length,
      withinReferenceRange: occurrences.length >= Math.ceil(theme.referenceCount * 0.8)
        && occurrences.length <= Math.floor(theme.referenceCount * 1.2),
      recurrenceCount: repeats.length,
      sameSessionRepeatCount: repeats.filter((occurrence) => occurrence.sessionRepeatType === "same-session").length,
      crossSessionRepeatCount: repeats.filter((occurrence) => occurrence.sessionRepeatType === "cross-session").length,
      storedAtRecurrenceCount: repeats.filter((occurrence) => occurrence.storedAtRecurrence).length,
      savedSinceFirstCount: repeats.filter((occurrence) => occurrence.savedSinceFirst).length,
      otherProjectOnlyAtRecurrenceCount: repeats.filter((occurrence) => occurrence.otherProjectOnlyAtRecurrence).length,
      injectedAtRecurrenceCount: repeats.filter((occurrence) => occurrence.injectedAtRecurrence).length,
      injectedTitleMemoryCount: injectedMemoryIdsByTheme.get(theme.id).size,
      injectedBodyRepeatCount: repeats.filter((occurrence) => occurrence.injectedBodyMemoryRowsByStoreAndCategory.central
        || occurrence.injectedBodyMemoryRowsByStoreAndCategory.local).length,
      ordinal31PlusCount: repeats.filter((occurrence) => occurrence.humanOrdinal >= 31).length,
      queuedCount: occurrences.filter((occurrence) => occurrence.queued).length,
      correctionLikeCount: occurrences.filter((occurrence) => occurrence.correctionLike).length,
      correctionLikeRecall: occurrences.length === 0
        ? null
        : occurrences.filter((occurrence) => occurrence.correctionLike).length / occurrences.length,
      memoryCoverageRecords: matchingMemories.map((row) => ({
        store: row.store ?? "unknown",
        project: row.project === null || row.project === undefined || String(row.project).trim() === ""
          ? "(空)"
          : String(row.project),
        date: jstDate(row.timestamp) ?? "未計測",
        title: Array.from(String(row.title ?? "")).slice(0, 30).join(""),
        id: String(row.id ?? "").slice(0, 8),
        visibility: visibleInFirebaseKit(row) ? "visible" : "other-project",
        matchedBy: matchesMemoryCoverage(theme.id, row.title) && matchesMemoryCoverage(theme.id, row.content)
          ? "題名・本文"
          : matchesMemoryCoverage(theme.id, row.title) ? "題名" : "本文",
      })).sort((left, right) => left.store.localeCompare(right.store)
        || left.project.localeCompare(right.project)
        || left.date.localeCompare(right.date)
        || left.title.localeCompare(right.title)
        || left.id.localeCompare(right.id)),
      stopObservedCount: occurrences.filter((occurrence) => occurrence.stopCountAfter > 0).length,
      stopCountAfter: occurrences.reduce((sum, occurrence) => sum + occurrence.stopCountAfter, 0),
      repeatStopCountAfter: repeats.reduce((sum, occurrence) => sum + occurrence.stopCountAfter, 0),
      stopDurationsMs: occurrences.flatMap((occurrence) => occurrence.stopDurationsMs),
      occurrences,
    };
  });

  const stageCounts = { S1: 0, S2: 0, S3: 0 };
  for (const theme of themeResults) {
    for (const occurrence of theme.occurrences) {
      if (occurrence.leakStage) stageCounts[occurrence.leakStage] += 1;
    }
  }

  return {
    eligibleHumanCount,
    themeCandidateCount,
    correctionLikeCount,
    uniqueThemeInputCount: themeInputIds.size,
    correctionLikeThemeInputCount: correctionLikeThemeInputIds.size,
    correctionLikeRecall: themeInputIds.size === 0 ? null : correctionLikeThemeInputIds.size / themeInputIds.size,
    correctionLikeOutsideThemeInputs,
    stageCounts,
    themes: themeResults,
  };
}
