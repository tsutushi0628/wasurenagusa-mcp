#!/usr/bin/env node
/**
 * wasurenagusa-scheduler
 * macOS launchd / Linux cron の設定を管理する。
 * Usage:
 *   wasurenagusa-scheduler install   - 深夜2時の自動統合をセットアップ
 *   wasurenagusa-scheduler uninstall - 自動統合を解除
 *   wasurenagusa-scheduler status    - 現在の状態を表示
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { mkdir, readFile, writeFile, unlink, stat } from "fs/promises";
import { dirname, join } from "path";
import { homedir, platform } from "os";
import { fileURLToPath } from "url";

const PLIST_LABEL = "com.wasurenagusa.consolidate";
const PLIST_FILENAME = `${PLIST_LABEL}.plist`;
const CRONTAB_MARKER = "# wasurenagusa-consolidate-all";

function log(message: string): void {
  process.stderr.write(message + "\n");
}

function getPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", PLIST_FILENAME);
}

function getLogDir(): string {
  return join(homedir(), ".wasurenagusa", "scheduler", "logs");
}

function getLogPath(): string {
  return join(getLogDir(), "consolidate-all.log");
}

function getConsolidateAllJsPath(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  return join(__dirname, "consolidate-all.js");
}

function buildPlistXml(nodePath: string, scriptPath: string, logPath: string): string {
  // 環境変数: 現在のPATHとAPIキーを引き継ぐ
  const envVars: Array<{ key: string; value: string }> = [];

  const pathValue = process.env.PATH;
  if (pathValue) {
    envVars.push({ key: "PATH", value: pathValue });
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    envVars.push({ key: "GEMINI_API_KEY", value: geminiKey });
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    envVars.push({ key: "OPENAI_API_KEY", value: openaiKey });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    envVars.push({ key: "ANTHROPIC_API_KEY", value: anthropicKey });
  }

  const envEntries = envVars
    .map((v) => `      <key>${v.key}</key>\n      <string>${v.value}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${scriptPath}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>2</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
</dict>
</plist>`;
}

// ============================
// macOS (launchd)
// ============================

async function installMacOS(): Promise<void> {
  const scriptPath = getConsolidateAllJsPath();
  if (!existsSync(scriptPath)) {
    log(`ERROR: consolidate-all.js not found at ${scriptPath}`);
    log("Run 'npm run build' first.");
    process.exit(1);
  }

  const nodePath = process.execPath;
  const logDir = getLogDir();
  const logPath = getLogPath();
  const plistPath = getPlistPath();

  // ログディレクトリ作成
  await mkdir(logDir, { recursive: true });

  // LaunchAgentsディレクトリ作成
  const launchAgentsDir = dirname(plistPath);
  await mkdir(launchAgentsDir, { recursive: true });

  // 既存plistがあればunload
  if (existsSync(plistPath)) {
    try {
      execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" });
    } catch {
      // unload失敗は無視（未登録の場合）
    }
  }

  // plist生成・書き込み
  const plistContent = buildPlistXml(nodePath, scriptPath, logPath);
  await writeFile(plistPath, plistContent, "utf-8");

  // launchctl load
  try {
    execSync(`launchctl load "${plistPath}"`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log(`WARNING: launchctl load failed: ${message}`);
    log(`Plist was written to ${plistPath}. You may need to load it manually.`);
    return;
  }

  log(`Installed: ${plistPath}`);
  log(`Schedule: Daily at 02:00`);
  log(`Log: ${logPath}`);
}

async function uninstallMacOS(): Promise<void> {
  const plistPath = getPlistPath();

  if (!existsSync(plistPath)) {
    log("Not installed (plist not found).");
    return;
  }

  try {
    execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" });
  } catch {
    // unload失敗は無視
  }

  await unlink(plistPath);
  log(`Uninstalled: removed ${plistPath}`);
}

async function statusMacOS(): Promise<void> {
  const plistPath = getPlistPath();

  if (!existsSync(plistPath)) {
    log("Status: NOT installed");
    return;
  }

  log("Status: INSTALLED");
  log(`Plist: ${plistPath}`);
  log("Schedule: Daily at 02:00");

  const logPath = getLogPath();
  if (existsSync(logPath)) {
    try {
      const logStat = await stat(logPath);
      const lastRun = logStat.mtime.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
      log(`Last log update: ${lastRun}`);
    } catch {
      // stat失敗はスキップ
    }
  } else {
    log("Last run: (no log file yet)");
  }
}

// ============================
// Linux (cron)
// ============================

function getCrontabEntry(): string {
  const nodePath = process.execPath;
  const scriptPath = getConsolidateAllJsPath();
  const logPath = getLogPath();
  return `0 2 * * * ${nodePath} ${scriptPath} >> ${logPath} 2>&1 ${CRONTAB_MARKER}`;
}

function getCurrentCrontab(): string {
  try {
    return execSync("crontab -l 2>/dev/null", { encoding: "utf-8" });
  } catch {
    return "";
  }
}

async function installLinux(): Promise<void> {
  const scriptPath = getConsolidateAllJsPath();
  if (!existsSync(scriptPath)) {
    log(`ERROR: consolidate-all.js not found at ${scriptPath}`);
    log("Run 'npm run build' first.");
    process.exit(1);
  }

  // ログディレクトリ作成
  const logDir = getLogDir();
  await mkdir(logDir, { recursive: true });

  const currentCrontab = getCurrentCrontab();

  // 既にインストール済みなら置換
  const lines = currentCrontab.split("\n");
  const filtered = lines.filter((line) => !line.includes(CRONTAB_MARKER));
  filtered.push(getCrontabEntry());

  // 末尾の空行を1つだけ残す
  const newCrontab = filtered.filter((line, i) => {
    if (i === filtered.length - 1 && line === "") return false;
    return true;
  }).join("\n") + "\n";

  execSync("crontab -", { input: newCrontab });

  log("Installed crontab entry.");
  log("Schedule: Daily at 02:00");
  log(`Log: ${getLogPath()}`);
}

async function uninstallLinux(): Promise<void> {
  const currentCrontab = getCurrentCrontab();

  if (!currentCrontab.includes(CRONTAB_MARKER)) {
    log("Not installed (crontab entry not found).");
    return;
  }

  const lines = currentCrontab.split("\n");
  const filtered = lines.filter((line) => !line.includes(CRONTAB_MARKER));
  const newCrontab = filtered.join("\n");

  execSync("crontab -", { input: newCrontab });
  log("Uninstalled: removed crontab entry.");
}

async function statusLinux(): Promise<void> {
  const currentCrontab = getCurrentCrontab();

  if (!currentCrontab.includes(CRONTAB_MARKER)) {
    log("Status: NOT installed");
    return;
  }

  log("Status: INSTALLED");
  log("Schedule: Daily at 02:00 (crontab)");

  const logPath = getLogPath();
  if (existsSync(logPath)) {
    try {
      const logStat = await stat(logPath);
      const lastRun = logStat.mtime.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
      log(`Last log update: ${lastRun}`);
    } catch {
      // stat失敗はスキップ
    }
  } else {
    log("Last run: (no log file yet)");
  }
}

// ============================
// Main
// ============================

async function main(): Promise<void> {
  const command = process.argv[2];

  if (!command) {
    log("Usage: wasurenagusa-scheduler <install|uninstall|status>");
    process.exit(1);
  }

  const os = platform();

  if (command === "install") {
    if (os === "darwin") {
      await installMacOS();
    } else {
      await installLinux();
    }
    return;
  }

  if (command === "uninstall") {
    if (os === "darwin") {
      await uninstallMacOS();
    } else {
      await uninstallLinux();
    }
    return;
  }

  if (command === "status") {
    if (os === "darwin") {
      await statusMacOS();
    } else {
      await statusLinux();
    }
    return;
  }

  log(`Unknown command: ${command}`);
  log("Usage: wasurenagusa-scheduler <install|uninstall|status>");
  process.exit(1);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  log(`Fatal: ${message}`);
  process.exit(1);
});
