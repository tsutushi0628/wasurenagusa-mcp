import { describe, expect, it } from "vitest";
import { isCorrectionLike, matchThemes, matchesMemoryCoverage } from "./themes.mjs";

describe("theme matching", () => {
  it("matches the ten requested synthetic themes", () => {
    const samples = [
      "Codexを使いまくって、実装を任せて",
      "S1ってなに？変な言葉を使うな",
      "要約に文字数の制限をつけるな",
      "デザイン変えるなよ、クラスでCSS組むな",
      "全文出して",
      "自分で確認しろ、出典は？",
      "Codexにぽんだしで設計させるな",
      "質問があったら答えて止まれ",
      "なんで敬語なの？",
      "一時置き場に置くな、プロジェクト外に作るな",
    ];

    expect(samples.map((text) => matchThemes(text).map((theme) => theme.id))).toEqual([
      expect.arrayContaining(["B1"]),
      expect.arrayContaining(["B2"]),
      expect.arrayContaining(["B3"]),
      expect.arrayContaining(["B4"]),
      expect.arrayContaining(["B5"]),
      expect.arrayContaining(["B6"]),
      expect.arrayContaining(["B7"]),
      expect.arrayContaining(["B8"]),
      expect.arrayContaining(["B9"]),
      expect.arrayContaining(["B10"]),
    ]);
  });

  it("matches summary-length paraphrases without treating unrelated UI work as design violations", () => {
    expect(matchThemes("要約が明らかに短い。原文にある程度追いつかせて").map((theme) => theme.id)).toContain("B3");
    expect(matchThemes("長すぎるって何をもって判断してる？むちゃくちゃな要求するから落ちてるんじゃないのか？要約の内容が違わなかったら").map((theme) => theme.id)).toContain("B3");
    expect(matchThemes("何で選択のデザイン変えた？そんな指示あった？").map((theme) => theme.id)).toContain("B4");
    expect(matchThemes("なのか？それとも選ぶのは本当にこのUIなのか？").map((theme) => theme.id)).not.toContain("B4");
    expect(matchThemes("みたいなHTMLを探して、新たに作って").map((theme) => theme.id)).not.toContain("B4");
  });

  it("marks corrections and repeated cautions without marking neutral instructions", () => {
    expect(isCorrectionLike("また同じ注意を言わせないで。違う、そうじゃない")).toBe(true);
    expect(isCorrectionLike("前も言ったけど、勝手に進めるな")).toBe(true);
    expect(isCorrectionLike("この画面に説明を追加して")).toBe(false);
    expect(isCorrectionLike("全文出して")).toBe(false);
  });

  it("recognizes a repeated request from the previous five utterances", () => {
    expect(isCorrectionLike("全文出して", [
      "別の件を調べて",
      "見出しを直して",
      "色を確認して",
      "この説明を短くして",
      "全文出して",
      "過去6件目の依頼",
    ])).toBe(true);
    expect(isCorrectionLike("全文出して", ["要約を直して", "画面を確認して"])).toBe(false);
  });

  it("uses narrow memory coverage rules instead of utterance keywords", () => {
    expect(matchesMemoryCoverage("B1", "Codexのheredoc禁止")).toBe(false);
    expect(matchesMemoryCoverage("B1", "役割分担: Codexは実装、Astraは設計を担当")).toBe(true);
    expect(matchesMemoryCoverage("B1", "Codex使用上限で停止し、枠が戻ったらCodexに戻す")).toBe(true);
    expect(matchesMemoryCoverage("B1", "Codex に表示まわりを実装させたら既存データ退行を受け入れ前に確認する")).toBe(false);
    expect(matchesMemoryCoverage("B1", "Codex task-fileにはレビュー観点見出しを必ず入れる")).toBe(false);
    expect(matchesMemoryCoverage("B1", "Codex経由のAstraが用意した案を確認せずHTML担当に反映させた")).toBe(false);
    expect(matchesMemoryCoverage("B1", "Codex経由のAstraが用意した下書きを確認しないままHTML担当に反映してしまった")).toBe(false);
    expect(matchesMemoryCoverage("B1", "大きな指示文・規範文書をhookで自動注入する設計は避け、CLAUDE.mdに直接書くか、必要になった時点でReadさせる運用にする")).toBe(false);
    expect(matchesMemoryCoverage("B1", "コード修正レビューはClaude側で終えず、Sol(Codex)レビューも通す")).toBe(true);
    expect(matchesMemoryCoverage("B1", "HTMLモック作成は必ずFableに担当させ、Codexには渡さない")).toBe(true);
    expect(matchesMemoryCoverage("B1", {
      title: "Codexのheredoc禁止",
      content: "設計は人間が行い、実装前に確認する。",
    })).toBe(false);
    expect(matchesMemoryCoverage("B4", "CSSが適用されない原因を調べる")).toBe(false);
    expect(matchesMemoryCoverage("B4", "デザインシステム外の色を勝手に追加しない")).toBe(true);
    expect(matchesMemoryCoverage("B6", "動作を確認したら記録する")).toBe(false);
    expect(matchesMemoryCoverage("B6", "一次情報と出典を必ず確認する")).toBe(true);
  });

  it("excludes memory rows whose shared words do not state the bundle rule", () => {
    expect(matchesMemoryCoverage("B2", "Smart Tag Retrieval機能の追加に伴い、README（英語・日本語）を更新した。")).toBe(false);
    expect(matchesMemoryCoverage("B3", "CycleTaskResult/CycleSummaryの型定義をSpecへ追記した。")).toBe(false);
    expect(matchesMemoryCoverage("B3", "LLMに書かせる文（分岐図の問い・結論、要約など）の長さを字数上限で指定・検査しない。")).toBe(true);
    expect(matchesMemoryCoverage("B4", "招聘文のReadブロックに design-system の tokens を Read する行を足す。")).toBe(false);
    expect(matchesMemoryCoverage("B4", "Codexへ委譲するtask-fileにはCSS等の相対パスを検証してから渡す。")).toBe(false);
    expect(matchesMemoryCoverage("B4", "外部向けレポートHTMLは独自CSSでなく必ずdesign-systemの部品で組むこと。")).toBe(true);
    expect(matchesMemoryCoverage("B5", "引用のリポストなど連鎖的に取得するAPI呼び出しは、全体のコスト上限を設定する。")).toBe(false);
    expect(matchesMemoryCoverage("B5", "全文を出して省略しない。")).toBe(true);
    expect(matchesMemoryCoverage("B5", "全文と一字ずつ突き合わせて違いを全部挙げ、同じ出力を点検する。")).toBe(false);
    expect(matchesMemoryCoverage("B5", "全応答の冒頭に8原則全文出力する。")).toBe(true);
    expect(matchesMemoryCoverage("B6", "応答前にCLAUDE.local.mdを確認し、指定された口調を守る。")).toBe(false);
    expect(matchesMemoryCoverage("B6", "ソースコードとSpecの整合性を検証し、CycleSummaryの型定義を追記した。")).toBe(false);
    expect(matchesMemoryCoverage("B6", {
      title: "口調ルール無視への怒り",
      content: "常にCLAUDE.local.mdを確認し、指定されたキャラクター設定と口調を厳守して対話する。",
    })).toBe(false);
    expect(matchesMemoryCoverage("B6", {
      title: "Specドキュメントとソースの同期",
      content: "wasurenagusa-mcpプロジェクトのソースコードとSpecドキュメントの整合性を検証。CycleSummaryの型定義を追記。主要ドキュメントが現行ソースと一致することを確認した。",
    })).toBe(false);
    expect(matchesMemoryCoverage("B6", "検査結果が0件でも依頼ファイルが空でないか、点検役が実際に動いたかを報告前に確認する。")).toBe(true);
    expect(matchesMemoryCoverage("B6", "登壇者の所属は公式サイトの一次情報で投稿前に裏取りする。")).toBe(true);
  });
});
