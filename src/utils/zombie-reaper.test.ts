import { describe, it, expect } from "vitest";
import { selectKillTargets, ProcessInfo } from "./zombie-reaper.js";

/**
 * プロセスツリーのテスト用ヘルパー
 * parentMap: pid → ppid のマッピングで祖先チェックをシミュレート
 */
function makePluginHostChecker(
  parentMap: Record<number, number>,
  pluginHostPid: number
) {
  return (pid: number): boolean => {
    let current = pid;
    for (let i = 0; i < 4; i++) {
      const ppid = parentMap[current];
      if (ppid === undefined) return false;
      if (ppid === pluginHostPid) return true;
      if (ppid <= 1) return false;
      current = ppid;
    }
    return false;
  };
}

describe("zombie-reaper", () => {
  describe("selectKillTargets", () => {
    // ===== シナリオ1: 孤児claudeとその子MCPをkillする =====
    it("PPID=1の孤児claudeとその子MCPをkill対象にする", () => {
      const PLUGIN_HOST = 89556;
      const processes: ProcessInfo[] = [
        // 孤児claude（PPID=1）
        { pid: 75650, ppid: 1, command: "/path/native-binary/claude --args" },
        // 孤児claudeの子MCP群
        { pid: 75660, ppid: 75650, command: "node wasurenagusa-mcp" },
        { pid: 75662, ppid: 75650, command: "python serena start-mcp-server" },
        { pid: 75693, ppid: 75650, command: "node playwright-mcp" },
        // 現セッション（触らない）
        { pid: 6147, ppid: PLUGIN_HOST, command: "/path/native-binary/claude --args" },
        { pid: 6157, ppid: 6147, command: "node wasurenagusa-mcp" },
      ];

      // 孤児はPlugin Host配下にいない
      const parentMap: Record<number, number> = {
        75650: 1,
        75660: 75650,
        75662: 75650,
        75693: 75650,
        6147: PLUGIN_HOST,
        6157: 6147,
      };

      const result = selectKillTargets(
        processes,
        PLUGIN_HOST,
        makePluginHostChecker(parentMap, PLUGIN_HOST)
      );

      expect(result).toContain(75650); // 孤児claude
      expect(result).toContain(75660); // 子MCP
      expect(result).toContain(75662); // 子MCP
      expect(result).toContain(75693); // 子MCP
      expect(result).not.toContain(6147); // 現セッション
      expect(result).not.toContain(6157); // 現セッション
    });

    // ===== シナリオ2: 現セッションのサブエージェントを絶対に殺さない =====
    it("同一Plugin Host配下のサブエージェントは触らない", () => {
      const PLUGIN_HOST = 89556;
      const processes: ProcessInfo[] = [
        // メインセッション
        { pid: 6147, ppid: PLUGIN_HOST, command: "/path/native-binary/claude --main" },
        { pid: 6157, ppid: 6147, command: "node wasurenagusa-mcp" },
        { pid: 6158, ppid: 6147, command: "python serena start-mcp-server" },
        // サブエージェント1（4時間走ってる）
        { pid: 7000, ppid: PLUGIN_HOST, command: "/path/native-binary/claude --resume uuid1" },
        { pid: 7001, ppid: 7000, command: "node wasurenagusa-mcp" },
        { pid: 7002, ppid: 7000, command: "python serena start-mcp-server" },
        // サブエージェント2
        { pid: 8000, ppid: PLUGIN_HOST, command: "/path/native-binary/claude --resume uuid2" },
        { pid: 8001, ppid: 8000, command: "node wasurenagusa-mcp" },
      ];

      const parentMap: Record<number, number> = {
        6147: PLUGIN_HOST,
        6157: 6147,
        6158: 6147,
        7000: PLUGIN_HOST,
        7001: 7000,
        7002: 7000,
        8000: PLUGIN_HOST,
        8001: 8000,
      };

      const result = selectKillTargets(
        processes,
        PLUGIN_HOST,
        makePluginHostChecker(parentMap, PLUGIN_HOST)
      );

      // 全プロセスが同一Plugin Host配下 → kill対象ゼロ
      expect(result).toHaveLength(0);
    });

    // ===== シナリオ3: 複数VSCodeウィンドウの安全性 =====
    it("別のVSCodeウィンドウのプロセスを殺さない", () => {
      const MY_PLUGIN_HOST = 89556;
      const OTHER_PLUGIN_HOST = 50000;
      const processes: ProcessInfo[] = [
        // 自分のウィンドウ
        { pid: 6147, ppid: MY_PLUGIN_HOST, command: "/path/native-binary/claude --main" },
        { pid: 6157, ppid: 6147, command: "node wasurenagusa-mcp" },
        // 別ウィンドウのメインセッション（PPIDが別のPlugin Host）
        { pid: 50100, ppid: OTHER_PLUGIN_HOST, command: "/path/native-binary/claude --main" },
        { pid: 50101, ppid: 50100, command: "node wasurenagusa-mcp" },
      ];

      const parentMap: Record<number, number> = {
        6147: MY_PLUGIN_HOST,
        6157: 6147,
        50100: OTHER_PLUGIN_HOST,
        50101: 50100,
      };

      const result = selectKillTargets(
        processes,
        MY_PLUGIN_HOST,
        makePluginHostChecker(parentMap, MY_PLUGIN_HOST)
      );

      // 別ウィンドウのプロセスはPPID=1ではないのでkill対象にならない
      expect(result).not.toContain(50100);
      expect(result).not.toContain(50101);
      expect(result).toHaveLength(0);
    });

    // ===== シナリオ4: 孤児claudeの子MCPも確実にkillする =====
    it("孤児claudeの子MCPはPPID=1でなくてもkill対象になる", () => {
      const PLUGIN_HOST = 89556;
      const processes: ProcessInfo[] = [
        // 孤児claude（PPID=1）
        { pid: 75650, ppid: 1, command: "/path/native-binary/claude --args" },
        // 子MCP（PPIDは75650、1ではない）
        { pid: 75660, ppid: 75650, command: "node wasurenagusa-mcp" },
        { pid: 75662, ppid: 75650, command: "python serena start-mcp-server" },
      ];

      const parentMap: Record<number, number> = {
        75650: 1,
        75660: 75650,
        75662: 75650,
      };

      const result = selectKillTargets(
        processes,
        PLUGIN_HOST,
        makePluginHostChecker(parentMap, PLUGIN_HOST)
      );

      expect(result).toContain(75660);
      expect(result).toContain(75662);
    });

    // ===== シナリオ5: 会話切替時に旧セッションは殺さない =====
    it("旧メインセッション（同一Plugin Host配下）は触らない", () => {
      const PLUGIN_HOST = 89556;
      const processes: ProcessInfo[] = [
        // 旧メインセッション（まだ生きてる）
        { pid: 91542, ppid: PLUGIN_HOST, command: "/path/native-binary/claude --old-main" },
        { pid: 91561, ppid: 91542, command: "node wasurenagusa-mcp" },
        // 旧サブエージェント
        { pid: 89739, ppid: PLUGIN_HOST, command: "/path/native-binary/claude --resume old-uuid" },
        { pid: 90690, ppid: 89739, command: "node wasurenagusa-mcp" },
        // 現メインセッション
        { pid: 6147, ppid: PLUGIN_HOST, command: "/path/native-binary/claude --new-main" },
        { pid: 6157, ppid: 6147, command: "node wasurenagusa-mcp" },
      ];

      const parentMap: Record<number, number> = {
        91542: PLUGIN_HOST,
        91561: 91542,
        89739: PLUGIN_HOST,
        90690: 89739,
        6147: PLUGIN_HOST,
        6157: 6147,
      };

      const result = selectKillTargets(
        processes,
        PLUGIN_HOST,
        makePluginHostChecker(parentMap, PLUGIN_HOST)
      );

      // 全部同一Plugin Host配下 → kill対象ゼロ
      expect(result).toHaveLength(0);
    });

    // ===== シナリオ6: プロセスリストが空の場合 =====
    it("プロセスリストが空ならkill対象ゼロ", () => {
      const result = selectKillTargets([], 89556, () => false);
      expect(result).toHaveLength(0);
    });

    // ===== シナリオ7: PPID=1だがclaude以外のプロセスは無視 =====
    it("PPID=1でもclaudeバイナリでなければ無視する", () => {
      const PLUGIN_HOST = 89556;
      const processes: ProcessInfo[] = [
        // PPID=1だがclaude以外（例: 直接起動されたMCP）
        { pid: 99999, ppid: 1, command: "node wasurenagusa-mcp" },
        { pid: 99998, ppid: 1, command: "python serena start-mcp-server" },
      ];

      const result = selectKillTargets(
        processes,
        PLUGIN_HOST,
        () => false
      );

      // claude バイナリではないのでPhase1で引っかからない
      // 孤児claudeの子でもないのでPhase2でも引っかからない
      expect(result).toHaveLength(0);
    });

    // ===== シナリオ8: 孤児MCP（親claudeが既に死んでPIDが消えた場合）=====
    it("親claudeが完全に消えた孤児MCPはPPID=1になるがclaudeではないので対象外", () => {
      const PLUGIN_HOST = 89556;
      const processes: ProcessInfo[] = [
        // 親claudeはもう消えてMCPだけPPID=1で残ってる
        { pid: 88888, ppid: 1, command: "node wasurenagusa-mcp" },
      ];

      const result = selectKillTargets(
        processes,
        PLUGIN_HOST,
        () => false
      );

      // Phase1はclaude限定、Phase2は孤児claudeの子限定 → 対象外
      // これはstdin close + 親プロセス監視で自己終了させる想定
      expect(result).toHaveLength(0);
    });

    // ===== シナリオ9: 混合ケース（孤児 + 現行 + 別ウィンドウ）=====
    it("孤児だけを正確にkillし、現行と別ウィンドウは触らない", () => {
      const MY_PLUGIN_HOST = 89556;
      const processes: ProcessInfo[] = [
        // 孤児（kill対象）
        { pid: 75650, ppid: 1, command: "/path/native-binary/claude --orphan" },
        { pid: 75660, ppid: 75650, command: "node wasurenagusa-mcp" },
        { pid: 75662, ppid: 75650, command: "python serena start-mcp-server" },
        { pid: 75693, ppid: 75650, command: "node playwright-mcp" },
        { pid: 75700, ppid: 75650, command: "node spec-workflow-mcp" },
        // 現行セッション（触らない）
        { pid: 6147, ppid: MY_PLUGIN_HOST, command: "/path/native-binary/claude --main" },
        { pid: 6157, ppid: 6147, command: "node wasurenagusa-mcp" },
        // サブエージェント（触らない）
        { pid: 7000, ppid: MY_PLUGIN_HOST, command: "/path/native-binary/claude --resume uuid" },
        { pid: 7001, ppid: 7000, command: "node wasurenagusa-mcp" },
        // 別ウィンドウ（触らない）
        { pid: 50100, ppid: 50000, command: "/path/native-binary/claude --other-window" },
        { pid: 50101, ppid: 50100, command: "node wasurenagusa-mcp" },
      ];

      const parentMap: Record<number, number> = {
        75650: 1,
        75660: 75650,
        75662: 75650,
        75693: 75650,
        75700: 75650,
        6147: MY_PLUGIN_HOST,
        6157: 6147,
        7000: MY_PLUGIN_HOST,
        7001: 7000,
        50100: 50000,
        50101: 50100,
      };

      const result = selectKillTargets(
        processes,
        MY_PLUGIN_HOST,
        makePluginHostChecker(parentMap, MY_PLUGIN_HOST)
      );

      // 孤児だけがkill対象
      expect(result).toContain(75650);
      expect(result).toContain(75660);
      expect(result).toContain(75662);
      expect(result).toContain(75693);
      expect(result).toContain(75700);
      expect(result).toHaveLength(5);

      // 現行・サブ・別ウィンドウは除外
      expect(result).not.toContain(6147);
      expect(result).not.toContain(6157);
      expect(result).not.toContain(7000);
      expect(result).not.toContain(7001);
      expect(result).not.toContain(50100);
      expect(result).not.toContain(50101);
    });
  });
});
