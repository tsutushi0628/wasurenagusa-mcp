import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { SQLiteStorage } from "../storage/index.js";
import { config, getMemoryPath } from "../config.js";
import { join } from "path";

export const memoryUnarchiveTool: Tool = {
  name: "memory_unarchive",
  description: `忘却（長期未参照）で archived に退避された記憶を active に戻す。
ids を省略して呼ぶと、復元候補（archived の記憶）の一覧を返す（復元せず読み取りのみ）。
ids を指定して呼ぶと、その id 群を archived → active に復元する（archived 以外の行には触れない）。
まず ids なしで一覧して対象を特定し、次に ids を指定して復元する2段運用を推奨。
※ memory_stash / memory_restore（一時退避テキストの復元）とは別系統。こちらは記憶本体の忘却退避の復元。`,
  inputSchema: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: { type: "string" },
        description: "復元する archived 記憶のID配列。省略すると復元せず一覧のみ返す。",
      },
      limit: {
        type: "number",
        description: "一覧モード時に返す最大件数。デフォルト100。",
      },
    },
    required: [],
  },
};

export function handleMemoryUnarchive(
  args: Record<string, unknown>,
  projectRoot: string,
): string {
  const memoryPath = getMemoryPath(projectRoot);
  const dbPath = join(memoryPath, config.sqliteFile);
  const storage = new SQLiteStorage(dbPath);

  try {
    storage.initialize();

    // string の非空要素だけを採る。ids が無い/配列でない/空 → 一覧モードへ落ちる（fail-safe）。
    const rawIds = args.ids;
    const filtered = Array.isArray(rawIds)
      ? (rawIds as unknown[]).filter(
          (x): x is string => typeof x === "string" && x.length > 0,
        )
      : [];
    // 同一 id の重複入力を一意化する。重複は restoreArchived で2件目以降が「もう active」の
    // 0 changes になり restored に乗らず、requested/skipped だけ自己重複で水増しされる。
    // requested/restored/skipped を一意 id 基準で整合させる（入力順は保持）。
    const ids = Array.from(new Set(filtered));

    // 一覧モード: ids未指定なら復元せず archived 候補を返す（誤爆で mass-restore しない安全設計）。
    if (ids.length === 0) {
      // 極端値（Infinity / 1e308 等）を LIMIT bind に渡すと SQLite が datatype mismatch を
      // throw する。上限 1000 に縮退し、負値・NaN は既定 100 へ落とす（安全側・fail-safe）。
      // Math.min が Infinity を 1000 に、Math.floor が小数を整数に丸める。
      const limit =
        typeof args.limit === "number" && args.limit > 0
          ? Math.min(Math.floor(args.limit), 1000)
          : 100;
      const archived = storage.listArchived(limit);
      return JSON.stringify(
        { mode: "list", count: archived.length, archived },
        null,
        2,
      );
    }

    // 復元モード: 指定 id を archived → active に戻す。restoreArchived は archived 行のみ更新（可逆）。
    const restored = storage.restoreArchived(ids);
    return JSON.stringify(
      { mode: "restore", requested: ids.length, restored, skipped: ids.length - restored },
      null,
      2,
    );
  } finally {
    storage.close();
  }
}
