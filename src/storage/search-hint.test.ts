import { describe, it, expect } from "vitest";
import { buildSearchHint } from "./search-hint.js";

describe("buildSearchHint", () => {
  it("該当件数が0件のときは「見つからない」旨を案内する", () => {
    expect(buildSearchHint(0)).toBe("該当するメモリが見つかりませんでした。");
  });

  it("該当件数が1件以上のときは memory_get_detail への誘導文言を返す", () => {
    expect(buildSearchHint(1)).toBe("詳細が必要なエントリのIDを memory_get_detail に渡してください。");
    expect(buildSearchHint(42)).toBe("詳細が必要なエントリのIDを memory_get_detail に渡してください。");
  });
});

describe("buildSearchHint - フォールバック段ラベル（タスク2.10: ヒットの経路可視化）", () => {
  it("フレーズ段でヒットした検索は、誘導文言の末尾に「フレーズ」段ラベルが付く", () => {
    expect(buildSearchHint(3, "phrase")).toBe(
      "詳細が必要なエントリのIDを memory_get_detail に渡してください。（フォールバック段: フレーズ）"
    );
  });

  it("AND段まで落ちてヒットした検索は「AND」段ラベルが付く（呼び手が緩い一致だと分かる）", () => {
    expect(buildSearchHint(1, "and")).toBe(
      "詳細が必要なエントリのIDを memory_get_detail に渡してください。（フォールバック段: AND）"
    );
  });

  it("OR段まで落ちてヒットした検索は「OR」段ラベルが付く（最も緩い一致であることが分かる）", () => {
    expect(buildSearchHint(5, "or")).toBe(
      "詳細が必要なエントリのIDを memory_get_detail に渡してください。（フォールバック段: OR）"
    );
  });

  it("段が発火していない検索（LIKE経路・ベクトルのみ等）はラベル無しの従来文言のまま", () => {
    expect(buildSearchHint(2, null)).toBe("詳細が必要なエントリのIDを memory_get_detail に渡してください。");
    expect(buildSearchHint(2, undefined)).toBe("詳細が必要なエントリのIDを memory_get_detail に渡してください。");
  });

  it("0件時は段を渡されてもラベルを付けない（0件＝どの段も発火していないため、見つからない案内を汚さない）", () => {
    expect(buildSearchHint(0, "or")).toBe("該当するメモリが見つかりませんでした。");
  });
});
