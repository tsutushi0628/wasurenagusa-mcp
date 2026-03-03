/**
 * zombie-reaper.ts
 *
 * MCP SDK の StdioServerTransport は親プロセスが死んでも process.exit() しないため、
 * claude バイナリやその子 MCP プロセスがゾンビとして残り続ける。
 *
 * このモジュールは4つの対策を提供する:
 * 1. stdin close 検知による自己終了（自分がゾンビにならない）
 * 2. 親プロセス生存確認ポーリング（stdin close 漏れのバックアップ）
 * 3. 30分ごとのゾンビプロセス掃除（孤児化したプロセスのみ対象）
 * 4. 終了時の兄弟MCPプロセス巻き添え終了（Serena等のリソース解放）
 *
 * ゾンビ判定ロジック（案E: 孤児限定kill）:
 * - PPID=1（孤児化した claude バイナリ）→ kill
 * - ↑の直接の子プロセス（MCP群）→ kill
 * - 同一 Plugin Host 配下のプロセスは一切触らない
 *
 * 兄弟MCP巻き添えロジック:
 * - 自分と同じ親（claude バイナリ）を持つ MCP プロセスを検出
 * - 自分自身と claude バイナリは除外
 * - stdin close / 親死亡時に SIGTERM を送る
 */

import { execSync } from "child_process";

const REAP_INTERVAL_MS = 30 * 60 * 1000; // 30分
const PARENT_CHECK_INTERVAL_MS = 10_000; // 10秒

/** kill対象のプロセスパターン */
const TARGET_PATTERNS = [
  "wasurenagusa-mcp",
  "serena start-mcp-server",
  "playwright-mcp",
  "spec-workflow-mcp",
  "native-binary/claude",
];

/** 兄弟kill対象のMCPパターン（claude バイナリは除外） */
const SIBLING_MCP_PATTERNS = [
  "serena start-mcp-server",
  "playwright-mcp",
  "spec-workflow-mcp",
];

export interface ProcessInfo {
  pid: number;
  ppid: number;
  command: string;
}

/**
 * ps コマンドでプロセス一覧を取得し、対象パターンにマッチするものを返す
 */
function findTargetProcesses(): ProcessInfo[] {
  try {
    const grepPattern = TARGET_PATTERNS.join("|");
    const output = execSync(
      `ps -eo pid,ppid,args 2>/dev/null | grep -E "${grepPattern}" | grep -v grep`,
      { encoding: "utf-8", timeout: 5000 }
    ).trim();

    if (!output) return [];

    return output
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        const parts = trimmed.split(/\s+/);
        return {
          pid: parseInt(parts[0]),
          ppid: parseInt(parts[1]),
          command: parts.slice(2).join(" "),
        };
      })
      .filter((p) => !isNaN(p.pid));
  } catch {
    return [];
  }
}

/**
 * 祖父（Plugin Host）の PID を取得する
 * wasurenagusa → claude binary → Plugin Host
 */
function getPluginHostPid(): number | null {
  try {
    const myParentPid = process.ppid;
    const output = execSync(`ps -o ppid= -p ${myParentPid}`, {
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
    const pid = parseInt(output);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * 指定PIDが特定の Plugin Host の配下にあるかチェック（最大4段階まで祖先を辿る）
 */
function isUnderPluginHost(
  pid: number,
  pluginHostPid: number
): boolean {
  let current = pid;
  for (let i = 0; i < 4; i++) {
    try {
      const ppid = parseInt(
        execSync(`ps -o ppid= -p ${current}`, {
          encoding: "utf-8",
          timeout: 1000,
        }).trim()
      );
      if (ppid === pluginHostPid) return true;
      if (ppid <= 1) return false;
      current = ppid;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * プロセスリストからkill対象PIDを選定する（純粋関数・テスト用にexport）
 *
 * Phase 1: PPID=1 の claude バイナリを特定
 * Phase 2: ↑の直接の子プロセス（MCP群）を特定
 * Phase 3: 自分の Plugin Host 配下は絶対除外
 */
export function selectKillTargets(
  allTargets: ProcessInfo[],
  pluginHostPid: number,
  isUnderMyPluginHost: (pid: number) => boolean
): number[] {
  const toKill: number[] = [];

  // Phase 1: 孤児化した claude バイナリ（PPID=1）を特定
  const orphanClaudes = new Set<number>();
  for (const p of allTargets) {
    if (p.ppid === 1 && p.command.includes("native-binary/claude")) {
      orphanClaudes.add(p.pid);
      toKill.push(p.pid);
    }
  }

  // Phase 2: 孤児 claude の子プロセス（MCP群）を特定
  for (const p of allTargets) {
    if (orphanClaudes.has(p.ppid)) {
      toKill.push(p.pid);
    }
  }

  // Phase 3: 自分の Plugin Host 配下は絶対除外（二重安全チェック）
  return toKill.filter((pid) => !isUnderMyPluginHost(pid));
}

/**
 * 自分と同じ親を持つ兄弟MCPプロセスを選定する（純粋関数・テスト用にexport）
 *
 * 自分の終了時に、同じ claude セッション配下の Serena 等を道連れにする。
 * - 自分自身（process.pid）は除外
 * - claude バイナリは除外（セッション管理はVSCode側の責務）
 */
export function selectSiblingTargets(
  allTargets: ProcessInfo[],
  myPid: number,
  myParentPid: number
): number[] {
  return allTargets
    .filter((p) => {
      if (p.pid === myPid) return false;
      if (p.ppid !== myParentPid) return false;
      return SIBLING_MCP_PATTERNS.some((pattern) =>
        p.command.includes(pattern)
      );
    })
    .map((p) => p.pid);
}

/**
 * 兄弟MCPプロセスにSIGTERMを送る（自分の終了時に呼ぶ）
 */
function killSiblingMcps(): void {
  try {
    const allTargets = findTargetProcesses();
    const siblings = selectSiblingTargets(
      allTargets,
      process.pid,
      process.ppid
    );

    for (const pid of siblings) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // プロセスが既に終了していても無視
      }
    }

    if (siblings.length > 0) {
      console.error(
        `[zombie-reaper] killed ${siblings.length} sibling MCP(s) on exit`
      );
    }
  } catch {
    // 終了時のベストエフォート。失敗しても自分の終了は阻害しない
  }
}

/**
 * ゾンビプロセスを検出してkillする
 */
function reap(): { killed: number; errors: number } {
  const pluginHostPid = getPluginHostPid();
  if (pluginHostPid === null) return { killed: 0, errors: 0 };

  const allTargets = findTargetProcesses();
  if (allTargets.length === 0) return { killed: 0, errors: 0 };

  const safeToKill = selectKillTargets(
    allTargets,
    pluginHostPid,
    (pid) => isUnderPluginHost(pid, pluginHostPid)
  );

  let killed = 0;
  let errors = 0;

  for (const pid of safeToKill) {
    try {
      process.kill(pid, "SIGTERM");
      killed++;
    } catch {
      errors++;
    }
  }

  return { killed, errors };
}

/**
 * stdin が閉じたら自分も終了する（自分がゾンビにならないための対策）
 */
function setupStdinWatcher(): void {
  process.stdin.on("end", () => {
    console.error("[zombie-reaper] stdin closed, killing siblings and exiting");
    killSiblingMcps();
    process.exit(0);
  });

  process.stdin.on("close", () => {
    console.error("[zombie-reaper] stdin closed, killing siblings and exiting");
    killSiblingMcps();
    process.exit(0);
  });
}

/**
 * 親プロセスの生存を定期確認する（stdin close 漏れのバックアップ）
 * kill(pid, 0) はシグナルを送らず生存確認だけ行う
 */
function setupParentWatcher(): void {
  const parentPid = process.ppid;

  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      console.error(
        `[zombie-reaper] parent ${parentPid} is dead, killing siblings and exiting`
      );
      killSiblingMcps();
      process.exit(0);
    }
  }, PARENT_CHECK_INTERVAL_MS);

  timer.unref();
}

/**
 * ゾンビリーパーを起動する
 * - stdin close 時の自己終了を設定
 * - 親プロセス生存確認ポーリングを設定
 * - 起動時に一度掃除 + 30分ごとにゾンビプロセスを掃除
 */
export function startZombieReaper(): void {
  // 自分がゾンビにならない対策（二重）
  setupStdinWatcher();
  setupParentWatcher();

  // 起動時に一度掃除
  try {
    const result = reap();
    if (result.killed > 0) {
      console.error(
        `[zombie-reaper] startup cleanup: killed ${result.killed} zombie processes`
      );
    }
  } catch (err) {
    console.error("[zombie-reaper] startup cleanup failed:", err);
  }

  // 30分ごとに定期掃除
  const timer = setInterval(() => {
    try {
      const result = reap();
      if (result.killed > 0) {
        console.error(
          `[zombie-reaper] killed ${result.killed} zombie processes`
        );
      }
    } catch (err) {
      console.error("[zombie-reaper] reap failed:", err);
    }
  }, REAP_INTERVAL_MS);

  timer.unref();

  console.error("[zombie-reaper] started (interval: 30min)");
}
