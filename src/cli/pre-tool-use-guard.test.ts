import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, unlinkSync, readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import Database from "better-sqlite3";
import {
  extractToolInputMessage,
  runPreToolUseGuard,
  type PreToolUseHookInput,
} from "./pre-tool-use-guard.js";
import type { ConsolidatedDont, ConsolidatedPrinciple } from "../types.js";
import type { BlockCounts } from "./guard.js";
import { MAX_BLOCK_COUNT, getBlockCountPath } from "./guard.js";
import { GUARDS_DDL } from "../storage/schema.js";
import { getKillSwitchPath } from "../guards/kill-switch.js";

function makePrinciple(overrides: Partial<ConsolidatedPrinciple> = {}): ConsolidatedPrinciple {
  return {
    theme: "テスト禁止語",
    rule: "❌ 禁止語を使う 💡 不適切 ✅ 別の表現を使う",
    positiveRule: "別の表現を使う",
    tags: ["test"],
    sourceCount: 3,
    sourceIds: ["t-1", "t-2", "t-3"],
    score: 15,
    maxIntensity: 5,
    guardPattern: "禁止ワード",
    guardMessage: "「禁止ワード」を使わず、別の表現にしてください。",
    ...overrides,
  };
}

function makeConsolidated(principles: ConsolidatedPrinciple[]): ConsolidatedDont {
  return {
    principles,
    consolidatedAt: "2026-05-02T12:00:00+09:00",
    sourceEntryCount: principles.length,
    version: 1,
  };
}

function makeHookInput(overrides: Partial<PreToolUseHookInput> = {}): PreToolUseHookInput {
  return {
    session_id: "test-session-1",
    transcript_path: "/tmp/transcript.json",
    cwd: "/tmp/myproject",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    ...overrides,
  };
}

describe("extractToolInputMessage", () => {
  it("tool_input を JSON.stringify した文字列を返す", () => {
    const input = makeHookInput({ tool_input: { command: "rm -rf /" } });
    const message = extractToolInputMessage(input);
    expect(message).toContain("rm -rf");
    expect(message).toContain("command");
  });

  it("tool_input が空オブジェクトでも例外を投げず空 JSON 文字列を返す", () => {
    const input = makeHookInput({ tool_input: {} });
    const message = extractToolInputMessage(input);
    expect(message).toBe("{}");
  });

  it("tool_input が undefined のときは空文字列を返す（fail-open）", () => {
    const input = makeHookInput({ tool_input: undefined });
    const message = extractToolInputMessage(input);
    expect(message).toBe("");
  });

  it("ネストオブジェクトの中身も全部 stringify される", () => {
    const input = makeHookInput({
      tool_name: "Edit",
      tool_input: { file_path: "/x", new_string: "border-left: 4px" },
    });
    const message = extractToolInputMessage(input);
    expect(message).toContain("border-left");
  });
});

describe("runPreToolUseGuard", () => {
  it("マッチするパターンがあれば block を返す", () => {
    const consolidated = makeConsolidated([makePrinciple()]);
    const blockCounts: BlockCounts = {};
    const input = makeHookInput({
      tool_input: { command: "echo これは禁止ワードを含む" },
    });

    const result = runPreToolUseGuard(input, blockCounts, consolidated);

    expect(result.action).toBe("block");
    expect(result.message).toContain("禁止ワード");
    expect(blockCounts["禁止ワード"]).toBe(1);
  });

  it("マッチしなければ pass を返す", () => {
    const consolidated = makeConsolidated([makePrinciple()]);
    const blockCounts: BlockCounts = {};
    const input = makeHookInput({
      tool_input: { command: "ls -la" },
    });

    const result = runPreToolUseGuard(input, blockCounts, consolidated);

    expect(result.action).toBe("pass");
  });

  it("同一パターン4回目（MAX_BLOCK_COUNT=3 超過）は警告 pass", () => {
    const consolidated = makeConsolidated([makePrinciple()]);
    const blockCounts: BlockCounts = { "禁止ワード": MAX_BLOCK_COUNT };
    const input = makeHookInput({
      tool_input: { command: "echo 禁止ワード" },
    });

    const result = runPreToolUseGuard(input, blockCounts, consolidated);

    expect(result.action).toBe("pass");
    expect(result.message).toContain("上限超過");
  });

  it("maxIntensity が全て < 5 のプロジェクトは pass を返す", () => {
    const consolidated = makeConsolidated([
      makePrinciple({ maxIntensity: 3, guardPattern: "禁止ワード" }),
      makePrinciple({ maxIntensity: 4, guardPattern: "禁止ワード" }),
    ]);
    const blockCounts: BlockCounts = {};
    const input = makeHookInput({
      tool_input: { command: "echo 禁止ワードを含む" },
    });

    const result = runPreToolUseGuard(input, blockCounts, consolidated);

    expect(result.action).toBe("pass");
  });

  it("Edit ツールの new_string にマッチしてもブロックする", () => {
    const consolidated = makeConsolidated([
      makePrinciple({ guardPattern: "border-left", theme: "デザインルール" }),
    ]);
    const blockCounts: BlockCounts = {};
    const input = makeHookInput({
      tool_name: "Edit",
      tool_input: { file_path: "/x.css", new_string: "border-left: 4px solid red" },
    });

    const result = runPreToolUseGuard(input, blockCounts, consolidated);

    expect(result.action).toBe("block");
  });

  it("consolidated が null の場合は pass を返す（fail-open）", () => {
    const blockCounts: BlockCounts = {};
    const input = makeHookInput();

    const result = runPreToolUseGuard(input, blockCounts, null);

    expect(result.action).toBe("pass");
  });

  it("tool_input が undefined のときは pass を返す", () => {
    const consolidated = makeConsolidated([makePrinciple()]);
    const blockCounts: BlockCounts = {};
    const input = makeHookInput({ tool_input: undefined });

    const result = runPreToolUseGuard(input, blockCounts, consolidated);

    expect(result.action).toBe("pass");
  });
});

/**
 * CLI 実機スモークテスト：dist/cli/pre-tool-use-guard.js を spawn して exit code を確認。
 * ビルド済みでないとスキップされる。
 *
 * タスク4.5で照合元が consolidated-dont.json から guards テーブルへ差し替わったため、
 * ここでは memory.db に guards 行を直接INSERTしてCLIへ渡す。既定は dry-run（タスク4.15）
 * のため、enforce系のテストは WASURENAGUSA_GUARD_MODE=enforce を明示する。
 */
describe("pre-tool-use-guard CLI (integration)", () => {
  let tmpDir: string;
  let projectRoot: string;
  let memoryPath: string;
  const cliPath = resolve(__dirname, "../../dist/cli/pre-tool-use-guard.js");

  function insertActiveGuard(id: string, pattern: string): void {
    const db = new Database(join(memoryPath, "memory.db"));
    db.exec(GUARDS_DDL);
    db.prepare(
      `INSERT INTO guards (id, pattern, source_incident_id, approved_at, expires_at, state, created_at)
       VALUES (?, ?, ?, datetime('now'), '2099-01-01T00:00:00.000Z', 'active', datetime('now'))`,
    ).run(id, pattern, "incident-smoke");
    db.close();
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-pre-guard-test-"));
    projectRoot = join(tmpDir, "myproject");
    memoryPath = join(projectRoot, ".wasurenagusa");
    mkdirSync(memoryPath, { recursive: true });
    // .git を作成して findProjectRoot が projectRoot を返すようにする
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    // 過去実行で残った blockCounts を消す（state-leak 防止）
    for (const sid of ["smoke-1", "smoke-2", "smoke-3"]) {
      const p = getBlockCountPath(sid);
      if (existsSync(p)) {
        try {
          unlinkSync(p);
        } catch {
          // 削除失敗は無視
        }
      }
    }
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    for (const sid of ["smoke-1", "smoke-2", "smoke-3"]) {
      const p = getBlockCountPath(sid);
      if (existsSync(p)) {
        try {
          unlinkSync(p);
        } catch {
          // 削除失敗は無視
        }
      }
    }
  });

  it("ビルド成果物が存在すれば、マッチしないコマンドで exit 0 を返す", () => {
    if (!existsSync(cliPath)) {
      // ビルド前: スキップ
      return;
    }
    insertActiveGuard("g-smoke-1", "border-left");

    const hookInput: PreToolUseHookInput = {
      session_id: "smoke-1",
      transcript_path: "/tmp/x",
      cwd: projectRoot,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    };
    const proc = spawnSync("node", [cliPath], {
      input: JSON.stringify(hookInput),
      encoding: "utf-8",
      env: { ...process.env, WASURENAGUSA_GUARD_MODE: "enforce" },
    });
    expect(proc.status).toBe(0);
  });

  it("ビルド成果物が存在すれば、enforceモードでマッチするコマンドは exit 2 を返す", () => {
    if (!existsSync(cliPath)) {
      return;
    }
    insertActiveGuard("g-smoke-2", "border-left");

    const hookInput: PreToolUseHookInput = {
      session_id: "smoke-2",
      transcript_path: "/tmp/x",
      cwd: projectRoot,
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { new_string: "border-left: 4px" },
    };
    const proc = spawnSync("node", [cliPath], {
      input: JSON.stringify(hookInput),
      encoding: "utf-8",
      env: { ...process.env, WASURENAGUSA_GUARD_MODE: "enforce" },
    });
    expect(proc.status).toBe(2);
    expect(proc.stderr).toContain("g-smoke-2");

    // 可観測性カウンタ（タスク0.9、R-M1）: process.exit(2)前にguard_block_countの
    // 書き込みが完了していること（実サブプロセスでの検証。fire-and-forgetだと
    // プロセス終了が先行し書き込みが欠落しうるため、await済みであることをここで担保する）
    const logsDir = join(memoryPath, "logs");
    expect(existsSync(logsDir)).toBe(true);
    const counterFiles = readdirSync(logsDir).filter(f => f.startsWith("counters-"));
    expect(counterFiles.length).toBeGreaterThanOrEqual(1);
    const allLines = counterFiles.flatMap(f => readFileSync(join(logsDir, f), "utf-8").trim().split("\n"));
    const blockEntry = allLines.map(l => JSON.parse(l)).find(e => e.metric === "guard_block_count");
    expect(blockEntry).toBeDefined();
    expect(blockEntry.value).toBe(1);
  });

  it("ビルド成果物が存在すれば、既定(dry-run)モードではマッチするコマンドでも exit 0 を返す（本配線未実施）", () => {
    if (!existsSync(cliPath)) {
      return;
    }
    insertActiveGuard("g-smoke-3", "border-left");

    const hookInput: PreToolUseHookInput = {
      session_id: "smoke-3",
      transcript_path: "/tmp/x",
      cwd: projectRoot,
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { new_string: "border-left: 4px" },
    };
    const proc = spawnSync("node", [cliPath], {
      input: JSON.stringify(hookInput),
      encoding: "utf-8",
    });
    expect(proc.status).toBe(0);
  });

  it("ビルド成果物が存在すれば、guardsテーブルが0件（fail-safe）でも exit 0 を返す", () => {
    if (!existsSync(cliPath)) {
      return;
    }
    const hookInput: PreToolUseHookInput = {
      session_id: "smoke-4",
      transcript_path: "/tmp/x",
      cwd: projectRoot,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "echo anything" },
    };
    const proc = spawnSync("node", [cliPath], {
      input: JSON.stringify(hookInput),
      encoding: "utf-8",
      env: { ...process.env, WASURENAGUSA_GUARD_MODE: "enforce" },
    });
    expect(proc.status).toBe(0);
  });

  it("ビルド成果物が存在すれば、キルスイッチ(guards.kill)存在時は enforce でも exit 0 を返す", () => {
    if (!existsSync(cliPath)) {
      return;
    }
    insertActiveGuard("g-smoke-5", "border-left");
    writeFileSync(getKillSwitchPath(memoryPath), "");

    const hookInput: PreToolUseHookInput = {
      session_id: "smoke-5",
      transcript_path: "/tmp/x",
      cwd: projectRoot,
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { new_string: "border-left: 4px" },
    };
    const proc = spawnSync("node", [cliPath], {
      input: JSON.stringify(hookInput),
      encoding: "utf-8",
      env: { ...process.env, WASURENAGUSA_GUARD_MODE: "enforce" },
    });
    expect(proc.status).toBe(0);
  });

  it("ビルド成果物が存在すれば、壊れた JSON を流しても exit 0 を返す（fail-open）", () => {
    if (!existsSync(cliPath)) {
      return;
    }
    const proc = spawnSync("node", [cliPath], {
      input: "not a json",
      encoding: "utf-8",
    });
    expect(proc.status).toBe(0);
  });
});
