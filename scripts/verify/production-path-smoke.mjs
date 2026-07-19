#!/usr/bin/env node
// 本番経路スモークテスト。
//
// 本番と同一の起動経路（dist/index.js＋stdio JSON-RPC）で新プロセスを立てて検証する。
// 対象DBに一時エントリを1件書き、検証後に削除する。
//
// 検査項目（4点）:
//   1. active横断検索: 件数とヒントの整合（件数>0ならmemory_get_detail誘導、件数0なら
//      「見つかりませんでした」を含む。件数0の環境ではヒント経路の回帰検出力は限定的）
//   2. project明示保存: memory_save のproject明示指定がDBのproject列に実際に反映されるか
//   3. project絞り込み検索: 保存したエントリにMCP経路（project絞り込み）で到達できるか
//   4. テストエントリの完全削除: 削除確認は「行が存在しないこと」（＝deleted_at IS NULLの
//      条件で行が見つからないこと）を成功とする
//
// 検査対象DBの解決はサーバ本体と同一の関数（dist/utils/projectRoot.js の findProjectRoot と
// dist/config.js の getMemoryPath・config.sqliteFile）を再利用する。決め打ちで導出すると
// サブディレクトリ指定時や MEMORY_DIR 環境変数設定時にサーバと別のDBを読んで偽FAILになる。
//
// サーバのstderrに "tag-enricher" を含む行が出たらWARNとして出力する（失敗にはしない。
// タグ拡張はfail-open設計のため、失敗してもフォールバックで処理継続する。ここではその
// 発生有無を可観測化するだけに留める）。
//
// 使い方:
//   node scripts/verify/production-path-smoke.mjs [対象プロジェクトのルートパス]
//   引数省略時は process.cwd() を対象にする。
//
// 終了コード: 全項目PASSで0、1つでもFAILまたは致命エラーで1。

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const SERVER_ENTRY = join(REPO_ROOT, "dist", "index.js");

// 版数の単一真実源（package.json）を実行時に読む。実起動したサーバの自己申告版数
// （MCP serverInfo.version と起動ログ）がこれと一致することを検査する。リテラルの
// 版数番号を焼き込まない（版数を上げれば検査側も自動追従する）。
const PKG_VERSION = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")).version;

if (!existsSync(SERVER_ENTRY)) {
  throw new Error(
    `サーバのビルド成果物が見つかりません: ${SERVER_ENTRY}（先に \`npm run build\` を実行してください）`,
  );
}

// サーバと同一のDB解決経路をビルド成果物から再利用する（自前で再実装しない）。
const { findProjectRoot } = await import(join(REPO_ROOT, "dist", "utils", "projectRoot.js"));
const { config, getMemoryPath } = await import(join(REPO_ROOT, "dist", "config.js"));

const targetProject = resolve(process.argv[2] || process.cwd());
const projectRoot = findProjectRoot(targetProject);
const DB_PATH = join(getMemoryPath(projectRoot), config.sqliteFile);

if (!existsSync(DB_PATH)) {
  throw new Error(`検証対象DBが見つかりません: ${DB_PATH}`);
}

console.error(`[production-path-smoke] 対象プロジェクト: ${targetProject}`);
console.error(`[production-path-smoke] 解決されたプロジェクトルート: ${projectRoot}`);
console.error(`[production-path-smoke] サーバ起動経路: node ${SERVER_ENTRY}`);
console.error(`[production-path-smoke] 検証対象DB: ${DB_PATH}`);

const proc = spawn("node", [SERVER_ENTRY], { cwd: targetProject, stdio: ["pipe", "pipe", "pipe"] });

const tagEnricherWarnings = [];
let startupVersionLog = null;
proc.stderr.on("data", (d) => {
  const text = d.toString();
  process.stderr.write("[server-err] " + text);
  for (const line of text.split("\n")) {
    if (line.includes("tag-enricher")) {
      tagEnricherWarnings.push(line.trim());
    }
    if (line.includes("wasurenagusa-mcp server started")) {
      startupVersionLog = line.trim();
    }
  }
});

let buf = "";
const pending = new Map();
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let seq = 0;
function rpc(method, params, timeoutMs = 120000) {
  const id = ++seq;
  const p = new Promise((res, reject) => {
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      res(msg);
    });
  });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return p;
}
function notify(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}
function toolText(res) {
  return res?.result?.content?.map((c) => c.text).join("\n") ?? "";
}
function parseToolJson(res) {
  try {
    return JSON.parse(toolText(res));
  } catch {
    return null;
  }
}

const results = [];
function report(name, pass, evidence) {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} | ${name} | ${evidence}`);
}

let fatalError = false;
let savedEntryId = null;

try {
  const initResp = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "production-path-smoke", version: "0.0.1" },
  });
  notify("notifications/initialized", {});

  // 検査0a: MCP initialize ハンドシェイクの serverInfo.version が package.json と一致するか。
  // クライアントが受け取る自己申告版数（主バグ面）を dist の実パス解決を通して検証する唯一の砦。
  // Server コンストラクタ（旧ハードコード版数）が単一真実源を消費している配線を保証する。
  const reportedVersion = initResp?.result?.serverInfo?.version ?? null;
  report(
    "検査0a: MCP serverInfo.version が package.json と一致する",
    reportedVersion === PKG_VERSION,
    `serverInfo.version=${reportedVersion} (期待: ${PKG_VERSION})`,
  );

  // 検査1: active横断検索の「件数とヒントの整合」。
  // 件数>0ならヒントは memory_get_detail への誘導、件数0なら「見つかりませんでした」を
  // 含むこと（「基点0件・マージ後あり」で誘導文言が固定表示される回帰の検出）。
  const a = await rpc("tools/call", {
    name: "memory_search",
    arguments: {
      query: "wasurenagusa検索と帰属の欠陥根治の引継ぎ。サーバ再起動後の実機発効確認、検証ガード再有効化、アーカイブサルベージ、backfill保留の扱い",
      project: "active",
      limit: 7,
    },
  });
  const aJson = parseToolJson(a);
  const aCount = aJson?.results?.length ?? 0;
  const aHint = aJson?.hint ?? "";
  const aConsistent =
    aCount > 0 ? aHint.includes("memory_get_detail") : aHint.includes("見つかりませんでした");
  if (aCount === 0) {
    console.log("INFO | 検査1: 横断検索ヒット0件の環境のため、ヒント整合の回帰検出力は限定的");
  }
  report(
    "検査1: active横断検索の件数とヒントの整合",
    aConsistent,
    `results=${aCount}, hint="${aHint}"`,
  );

  // 検査2: memory_save のproject明示指定が実際にDBのproject列へ反映されるか。
  const title = "本番経路スモークテスト用一時エントリ";
  const b = await rpc("tools/call", {
    name: "memory_save",
    arguments: {
      category: "log",
      title,
      content: "production-path-smoke.mjs 実行時の検証用一時エントリ。検証後に削除する。",
      tags: ["verification-temp"],
      project: "wasurenagusa-mcp",
    },
  });
  const bText = toolText(b);

  const db = new Database(DB_PATH, { readonly: true });
  const row = db
    .prepare("SELECT id, project, title FROM memories WHERE title = ? AND deleted_at IS NULL ORDER BY created_at DESC")
    .get(title);
  db.close();
  savedEntryId = row?.id ?? null;
  report(
    "検査2: project明示保存がDBのproject列に反映される",
    row?.project === "wasurenagusa-mcp",
    row ? `id=${row.id}, project=${row.project}` : `行なし; save応答=${bText.slice(0, 200)}`,
  );

  // 検査3: project絞り込み検索（MCP経路）で保存したエントリに到達できるか。
  const c = await rpc("tools/call", {
    name: "memory_search",
    arguments: { query: title, project: "wasurenagusa-mcp", limit: 5 },
  });
  const cJson = parseToolJson(c);
  const ids = (cJson?.results ?? []).map((r) => r.id);
  report(
    "検査3: project絞り込み検索でMCP経路から到達できる",
    savedEntryId !== null && ids.includes(savedEntryId),
    `hit ids=${ids.join(",")} (期待: ${savedEntryId})`,
  );
} catch (e) {
  console.error("ERROR:", e.message);
  fatalError = true;
} finally {
  // 検査4（後片付け兼用）: テストエントリの完全削除。途中の検査で例外が出てもここは
  // 必ず通るため、テストエントリが本番DBに残留しない（ベストエフォート）。
  if (savedEntryId) {
    try {
      const d = await rpc("tools/call", { name: "memory_delete", arguments: { ids: [savedEntryId] } }, 15000);
      console.log(`cleanup | ${toolText(d).slice(0, 150).replace(/\n/g, " ")}`);
    } catch (cleanupError) {
      console.log(
        `WARN | 後片付けのmemory_delete呼び出しに失敗（${cleanupError.message}）。` +
          `対象DBにテストエントリ id=${savedEntryId} が残留している可能性があります。` +
          `手動削除手順: MCPツール memory_delete に ids=["${savedEntryId}"] を渡すか、` +
          `対象DB（${DB_PATH}）で該当idの行を確認して削除してください。`,
      );
    }
    try {
      const db2 = new Database(DB_PATH, { readonly: true });
      const stillActive = db2
        .prepare("SELECT id FROM memories WHERE id = ? AND deleted_at IS NULL")
        .get(savedEntryId);
      db2.close();
      report(
        "検査4: テストエントリの完全削除",
        stillActive === undefined,
        stillActive === undefined
          ? `id=${savedEntryId} は生存行として存在しない`
          : `id=${savedEntryId} がまだ生存行として存在する`,
      );
    } catch (verifyError) {
      report("検査4: テストエントリの完全削除", false, `削除確認クエリに失敗: ${verifyError.message}`);
    }
  }
  proc.kill();
}

// 検査0b: dist 実起動の stderr 起動ログが package.json の版数を名乗るか（起動ログ配線の検証）。
// serverInfo（検査0a）とは独立した2つ目の自己申告点で、ログ行だけ直し忘れる／逆の配線ミスを捕まえる。
// 全 RPC 往復を経た後に評価するため、起動ログは既に stderr へ flush 済み。
report(
  "検査0b: 起動ログの版数が package.json と一致する",
  startupVersionLog !== null && startupVersionLog.includes(`(v${PKG_VERSION})`),
  startupVersionLog !== null
    ? `起動ログ="${startupVersionLog}" (期待: (v${PKG_VERSION}))`
    : `起動ログ（"wasurenagusa-mcp server started"）が stderr に観測されなかった`,
);

if (tagEnricherWarnings.length > 0) {
  console.log(`\n== WARN: tag-enricher関連のエラー行が${tagEnricherWarnings.length}件検出されました（fail-openのため失敗扱いにはしていません） ==`);
  for (const line of tagEnricherWarnings) {
    console.log(`WARN | ${line}`);
  }
} else {
  console.log(`\n== tag-enricher関連のエラー行は検出されませんでした ==`);
}

// 終了コードの決定はここに一元化する（catch側では致命フラグだけ立てる）。
const failedChecks = results.filter((r) => !r.pass);
const failedNames = failedChecks.map((r) => r.name);
const summarySuffix = failedChecks.length > 0 ? ` / FAIL: ${failedNames.join(", ")}` : "";
const fatalSuffix = fatalError ? " / 致命エラーあり（上記ERROR行参照）" : "";
console.log(`\n== 結果: ${results.length - failedChecks.length}/${results.length} PASS${summarySuffix}${fatalSuffix} ==`);
process.exitCode = fatalError || failedChecks.length > 0 ? 1 : 0;
