import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { handleMemoryUnarchive } from "./unarchive.js";
import {
  memoryUnarchiveTool,
  handleMemoryUnarchive as reExportedHandler,
} from "./index.js";
import { SQLiteStorage } from "../storage/index.js";
import { getMemoryPath, config } from "../config.js";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, mkdirSync, rmSync } from "fs";

// A2-unarchive の業務意図テスト。
// 観測はすべて「利用者に見える振る舞い」で書く:
//  - active retrieval に参加しているか  = 空クエリ検索（state='active' 限定）の結果に出るか
//  - 物理的に存在するか（deleted でない）= get_detail（active/archived 可・deleted 不可）に出るか
// この2軸の組み合わせで active / archived / deleted を判別する（内部 state 列を直接覗かない）。
describe("memory_unarchive ツール（archived→active 復元 / 復元候補の一覧）", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "wasurenagusa-unarchive-test-"));
    mkdirSync(getMemoryPath(projectRoot), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  // --- 観測ヘルパ（各フェーズで開いて即閉じる。ハンドラは自前の接続を開くので同時多重接続を避ける） ---

  function openStorage(): SQLiteStorage {
    const storage = new SQLiteStorage(
      join(getMemoryPath(projectRoot), config.sqliteFile),
    );
    storage.initialize();
    return storage;
  }

  // active retrieval に参加している記憶の id 集合（空クエリ＝active 全件・state='active' フィルタ経路）。
  function activeIds(): string[] {
    const storage = openStorage();
    try {
      return storage
        .search({ query: "", category: "all", limit: 1000 })
        .results.map((r) => r.id);
    } finally {
      storage.close();
    }
  }

  // 物理的に存在する（active/archived。deleted は含まれない）id 集合。
  function existingIds(ids: string[]): string[] {
    const storage = openStorage();
    try {
      return storage.getDetail({ ids }).entries.map((e) => e.id);
    } finally {
      storage.close();
    }
  }

  // active 記憶を title ごとに save し、archiveIdx の位置だけ忘却退避（archived）にする。
  // 返り値は保存順の id 配列。
  function seed(titles: string[], archiveIdx: number[]): string[] {
    const storage = openStorage();
    try {
      const ids = titles.map(
        (t) =>
          storage.save({ category: "log", title: t, content: `${t} の本文` }).id,
      );
      const toArchive = archiveIdx.map((i) => ids[i]);
      if (toArchive.length > 0) {
        storage.archiveMemories(toArchive);
      }
      return ids;
    } finally {
      storage.close();
    }
  }

  it("tools/index.js 経由で memory_unarchive のツール定義とハンドラが配線されている", () => {
    // MCP 登録（ListTools/switch）が参照する再エクスポート口を固定する。
    expect(memoryUnarchiveTool.name).toBe("memory_unarchive");
    expect(typeof reExportedHandler).toBe("function");
  });

  it("一覧モード（ids未指定）は archived の記憶だけを返し、active は含めない", () => {
    const [a, b, c] = seed(["archived-alpha", "archived-beta", "active-gamma"], [
      0, 1,
    ]);

    const res = JSON.parse(handleMemoryUnarchive({}, projectRoot));

    expect(res.mode).toBe("list");
    expect(res.count).toBe(2);
    const listedIds = res.archived.map((x: { id: string }) => x.id).sort();
    expect(listedIds).toEqual([a, b].sort());
    expect(listedIds).not.toContain(c);

    // 一覧は選定に足る情報（タイトル・カテゴリ）を伴う（発見導線として使える）。
    const alpha = res.archived.find((x: { id: string }) => x.id === a);
    expect(alpha.title).toBe("archived-alpha");
    expect(alpha.category).toBe("log");
  });

  it("一覧モードは記憶の状態を一切変えない（読み取り専用・fail-safe）", () => {
    const [a, b, c] = seed(["arch-a", "arch-b", "act-c"], [0, 1]);

    // 呼び出し前: a,b は active 集合に居ない（archived）、c だけ active。
    expect(activeIds()).toEqual([c]);

    handleMemoryUnarchive({}, projectRoot); // 一覧のみ（復元しない）

    // 呼び出し後も a,b は active に復帰していない（archived のまま）。かつ物理的には存在（deleted でない）。
    expect(activeIds()).toEqual([c]);
    expect(existingIds([a, b]).sort()).toEqual([a, b].sort());
  });

  it("復元モードは archived→active に戻し、復元後は active 検索に再浮上する", () => {
    const [a, b] = seed(["restore-me", "leave-me"], [0, 1]);

    // 復元前: どちらも active 集合に居ない（両方 archived）。
    expect(activeIds()).toEqual([]);

    const res = JSON.parse(handleMemoryUnarchive({ ids: [a] }, projectRoot));

    expect(res.mode).toBe("restore");
    expect(res.requested).toBe(1);
    expect(res.restored).toBe(1);
    expect(res.skipped).toBe(0);

    // 復元後: a は active 集合に再浮上。b は触れられず archived のまま（存在はする）。
    expect(activeIds()).toEqual([a]);
    expect(existingIds([b])).toEqual([b]);
    expect(activeIds()).not.toContain(b);
  });

  it("既に active / 存在しない id は復元0件として skipped に可視化し、対象を壊さない", () => {
    const [, act] = seed(["arch-x", "act-y"], [0]);

    const res = JSON.parse(
      handleMemoryUnarchive({ ids: [act, "no-such-id"] }, projectRoot),
    );

    // 沈黙の 0件成功にせず、差分を skipped で説明する。
    expect(res.restored).toBe(0);
    expect(res.skipped).toBe(2);
    // active 記憶は破壊されず active のまま。
    expect(activeIds()).toContain(act);
  });

  it("同一 archived id の二重復元は冪等（1回目 restored=1・2回目 restored=0）", () => {
    const [arch] = seed(["arch-idem"], [0]);

    const first = JSON.parse(handleMemoryUnarchive({ ids: [arch] }, projectRoot));
    expect(first.restored).toBe(1);
    expect(first.skipped).toBe(0);

    const second = JSON.parse(
      handleMemoryUnarchive({ ids: [arch] }, projectRoot),
    );
    expect(second.restored).toBe(0);
    expect(second.skipped).toBe(1);

    expect(activeIds()).toContain(arch);
  });

  it("複数 archived のうち ids 指定した1件だけ復元し、他の archived は巻き込まない", () => {
    const [a, b] = seed(["only-a", "keep-b"], [0, 1]);

    handleMemoryUnarchive({ ids: [a] }, projectRoot);

    expect(activeIds()).toEqual([a]); // a だけ active に戻る
    expect(existingIds([b])).toEqual([b]); // b は存在（archived のまま）
    expect(activeIds()).not.toContain(b); // b は active になっていない
  });

  it("重複 id 入力は一意化して計上する（requested は一意数・skipped を自己重複で水増ししない）", () => {
    const [arch] = seed(["arch-dup"], [0]);

    // 同一 archived id を3回渡す。復元対象は実質1件だが、重複排除前は 2件目以降が
    // 「もう active」で 0 changes になり、requested=3 / skipped=2 と自己重複で水増しされる。
    const res = JSON.parse(
      handleMemoryUnarchive({ ids: [arch, arch, arch] }, projectRoot),
    );

    // requested は一意 id 数で数える（重複入力で膨らませない）。
    expect(res.requested).toBe(1);
    expect(res.restored).toBe(1);
    // skipped は実際に復元できなかった対象だけ。自己重複を skipped に混ぜない。
    expect(res.skipped).toBe(0);

    // 実体は1件だけ復元され active に浮上している。
    expect(activeIds()).toEqual([arch]);
  });

  it("一覧モードは極端な limit（Infinity / 1e308）でも例外なく返し、上限へ縮退する", () => {
    seed(["arch-1", "arch-2", "arch-3"], [0, 1, 2]);

    // Infinity をそのまま LIMIT bind に渡すと SQLite が datatype mismatch を throw する。
    // ガードで上限へ縮退し、例外なく archived 全件（3件）を返すことを確認する。
    let res: { mode: string; count: number } | undefined;
    expect(() => {
      res = JSON.parse(
        handleMemoryUnarchive({ limit: Infinity }, projectRoot),
      );
    }).not.toThrow();
    expect(res?.mode).toBe("list");
    expect(res?.count).toBe(3);

    // 有限だが桁が極端な値（1e308）も安全側へ縮退し throw しない。
    expect(() =>
      handleMemoryUnarchive({ limit: 1e308 }, projectRoot),
    ).not.toThrow();
  });
});
