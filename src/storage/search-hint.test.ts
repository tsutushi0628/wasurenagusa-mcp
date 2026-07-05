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
