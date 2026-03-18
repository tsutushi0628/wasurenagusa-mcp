import { describe, it, expect } from "vitest";
import { formatEntry } from "./formatter.js";
import { MemoryEntry } from "../types.js";

describe("formatEntry", () => {
  it("project/scopeなしのエントリは既存フォーマットと同一", () => {
    const entry: MemoryEntry = {
      id: "test-id-001",
      timestamp: "2026-02-06T16:00:00.000+09:00",
      category: "config",
      title: "テスト設定",
      content: "テスト内容です",
      tags: ["test", "config"],
    };

    const result = formatEntry(entry);

    expect(result).toContain("## テスト設定");
    expect(result).toContain("- **id**: test-id-001");
    expect(result).toContain("- **timestamp**: 2026-02-06T16:00:00.000+09:00");
    expect(result).toContain("- **category**: config");
    expect(result).toContain("- **tags**: test, config");
    expect(result).toContain("- **content**: テスト内容です");
    expect(result).not.toContain("- **project**:");
    expect(result).not.toContain("- **scope**:");
  });

  it("project/scopeありのエントリはメタデータ行に含まれる", () => {
    const entry: MemoryEntry = {
      id: "test-id-002",
      timestamp: "2026-02-06T16:00:00.000+09:00",
      category: "dont",
      title: "API間違い",
      content: "正しいURLはhttps://api.example.com",
      tags: ["API"],
      project: "yakusoku",
      scope: "backend",
    };

    const result = formatEntry(entry);

    expect(result).toContain("- **project**: yakusoku");
    expect(result).toContain("- **scope**: backend");
  });

  it("projectのみ、scopeなしのエントリ", () => {
    const entry: MemoryEntry = {
      id: "test-id-003",
      timestamp: "2026-02-06T16:00:00.000+09:00",
      category: "log",
      title: "実装完了",
      content: "認証機能を実装",
      tags: [],
      project: "myproject",
    };

    const result = formatEntry(entry);

    expect(result).toContain("- **project**: myproject");
    expect(result).not.toContain("- **scope**:");
  });

  it("scopeのみ、projectなしのエントリ", () => {
    const entry: MemoryEntry = {
      id: "test-id-004",
      timestamp: "2026-02-06T16:00:00.000+09:00",
      category: "decision",
      title: "React採用",
      content: "フロントはReactで統一",
      tags: [],
      scope: "frontend",
    };

    const result = formatEntry(entry);

    expect(result).not.toContain("- **project**:");
    expect(result).toContain("- **scope**: frontend");
  });

  it("intensity: 3 のエントリはintensity行が出力される", () => {
    const entry: MemoryEntry = {
      id: "test-id-imp-001",
      timestamp: "2026-02-06T16:00:00.000+09:00",
      category: "dont",
      title: "絶対禁止事項",
      content: "テスト内容です",
      tags: ["test"],
      intensity: 3,
    };

    const result = formatEntry(entry);
    expect(result).toContain("- **intensity**: 3");
  });

  it("intensity: undefined のエントリはintensity行が出力されない", () => {
    const entry: MemoryEntry = {
      id: "test-id-imp-002",
      timestamp: "2026-02-06T16:00:00.000+09:00",
      category: "dont",
      title: "未設定事項",
      content: "テスト内容です",
      tags: ["test"],
    };

    const result = formatEntry(entry);
    expect(result).not.toContain("- **intensity**:");
  });

  it("intensity はscopeの後、tagsの前に配置される", () => {
    const entry: MemoryEntry = {
      id: "test-id-imp-004",
      timestamp: "2026-02-06T16:00:00.000+09:00",
      category: "dont",
      title: "配置テスト",
      content: "テスト内容です",
      tags: ["test"],
      scope: "backend",
      intensity: 4,
    };

    const result = formatEntry(entry);
    const lines = result.split("\n");

    const scopeIndex = lines.findIndex(l => l.includes("- **scope**:"));
    const intensityIndex = lines.findIndex(l => l.includes("- **intensity**:"));
    const tagsIndex = lines.findIndex(l => l.includes("- **tags**:"));

    expect(scopeIndex).toBeLessThan(intensityIndex);
    expect(intensityIndex).toBeLessThan(tagsIndex);
  });

  it("project/scopeはcategory行の後に出力される", () => {
    const entry: MemoryEntry = {
      id: "test-id-005",
      timestamp: "2026-02-06T16:00:00.000+09:00",
      category: "config",
      title: "ポート設定",
      content: "ポート3000固定",
      tags: ["port"],
      project: "yakusoku",
      scope: "infra",
    };

    const result = formatEntry(entry);
    const lines = result.split("\n");

    const categoryIndex = lines.findIndex(l => l.includes("- **category**:"));
    const projectIndex = lines.findIndex(l => l.includes("- **project**:"));
    const scopeIndex = lines.findIndex(l => l.includes("- **scope**:"));
    const tagsIndex = lines.findIndex(l => l.includes("- **tags**:"));

    expect(categoryIndex).toBeLessThan(projectIndex);
    expect(projectIndex).toBeLessThan(scopeIndex);
    expect(scopeIndex).toBeLessThan(tagsIndex);
  });
});
