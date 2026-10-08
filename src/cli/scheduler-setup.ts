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
import { accessSync, constants, existsSync, statSync } from "fs";
import { mkdir, readFile, writeFile, unlink, stat } from "fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "path";
import { homedir, platform } from "os";
import { fileURLToPath, pathToFileURL } from "url";

const PLIST_LABEL = "com.wasurenagusa.consolidate";
const PLIST_FILENAME = `${PLIST_LABEL}.plist`;
const ARCHIVE_PLIST_LABEL = "com.wasurenagusa.archive-transcripts";
const ARCHIVE_PLIST_FILENAME = `${ARCHIVE_PLIST_LABEL}.plist`;
const STRENGTH_PLIST_LABEL = "com.wasurenagusa.correction-strength";
const STRENGTH_PLIST_FILENAME = `${STRENGTH_PLIST_LABEL}.plist`;
const ABSTRACTION_PLIST_LABEL = "com.wasurenagusa.correction-abstraction";
const GRADUATION_PLIST_LABEL = "com.wasurenagusa.correction-graduation";
const GRADUATION_PLIST_FILENAME = "com.wasurenagusa.correction-graduation.plist";
const ABSTRACTION_PLIST_FILENAME = `${ABSTRACTION_PLIST_LABEL}.plist`;
const CRONTAB_MARKER = "# wasurenagusa-consolidate-all";
const STRENGTH_CRONTAB_MARKER = "# wasurenagusa-correction-strength";
const ABSTRACTION_CRONTAB_MARKER = "# wasurenagusa-correction-abstraction";
const GRADUATION_CRONTAB_MARKER = "# wasurenagusa-correction-graduation";

function log(message: string): void {
  process.stderr.write(message + "\n");
}

function getPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", PLIST_FILENAME);
}

function getArchivePlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", ARCHIVE_PLIST_FILENAME);
}

function getStrengthPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", STRENGTH_PLIST_FILENAME);
}

function getAbstractionPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", ABSTRACTION_PLIST_FILENAME);
}

function getGraduationPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", GRADUATION_PLIST_FILENAME);
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

function getPackageRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  return resolve(dirname(__filename), "..", "..");
}

function getArchiveTranscriptsPath(): string {
  return join(getPackageRoot(), "scripts", "maintenance", "archive-transcripts.mjs");
}

function getStrengthJobPath(): string {
  const __filename = fileURLToPath(import.meta.url);
  return join(dirname(__filename), "strength-job.js");
}

function getAbstractionJobPath(): string {
  const __filename = fileURLToPath(import.meta.url);
  return join(dirname(__filename), "abstract-principles.js");
}

function getGraduationJobPath(): string {
  const __filename = fileURLToPath(import.meta.url);
  return join(dirname(__filename), "graduation-export.js");
}

export function resolveCodexBinaryPath(env: NodeJS.ProcessEnv = process.env): string {
  const configuredPath = env.WASURENAGUSA_CODEX_BIN?.trim();
  if (configuredPath !== undefined && configuredPath !== "") {
    if (!isAbsolute(configuredPath)) throw new Error("WASURENAGUSA_CODEX_BIN must be an absolute executable path");
    try {
      if (!statSync(configuredPath).isFile()) throw new Error("not a file");
      accessSync(configuredPath, constants.X_OK);
      return configuredPath;
    } catch {
      throw new Error("WASURENAGUSA_CODEX_BIN is not an executable file");
    }
  }

  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = resolve(directory, "codex");
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error("codex executable was not found in PATH");
}

function getDefaultAbstractionQuotaCommand(): string {
  return resolve(getPackageRoot(), "..", "firebase-kit", ".claude", "hooks", "scripts", "codex-quota.py");
}

function getDefaultJevImportCommand(): string {
  const scriptPath = join(dirname(getDefaultAbstractionQuotaCommand()), "extract-jev-knowledge.py");
  return `python3 ${shellQuote(scriptPath)}`;
}

function getDefaultJevImportOutputPath(): string {
  return resolve(dirname(getDefaultAbstractionQuotaCommand()), "..", "jev-knowledge.graduated.json");
}

function resolveAbstractionQuotaCommand(env: NodeJS.ProcessEnv = process.env): string {
  return env.WASURENAGUSA_CODEX_QUOTA_CMD?.trim() || getDefaultAbstractionQuotaCommand();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function buildArchivePlistXml(nodePath: string, scriptPath: string, logPath: string): string {
  const workingDirectory = resolve(dirname(scriptPath), "..", "..");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(ARCHIVE_PLIST_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(scriptPath)}</string>
    <string>--all</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(workingDirectory)}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
</dict>
</plist>`;
}

export function buildStrengthPlistXml(
  nodePath: string,
  scriptPath: string,
  logPath: string,
): string {
  const workingDirectory = resolve(dirname(scriptPath), "..", "..");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(STRENGTH_PLIST_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(scriptPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(workingDirectory)}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>4</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
</dict>
</plist>`;
}

export function buildGraduationPlistXml(
  nodePath: string,
  scriptPath: string,
  logPath: string,
  jevImportCommand = getDefaultJevImportCommand(),
  jevImportOutputPath = getDefaultJevImportOutputPath(),
): string {
  const workingDirectory = resolve(dirname(scriptPath), "..", "..");
  let pathValue = "";
  if (process.env.PATH !== undefined) pathValue = process.env.PATH;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    '  <string>' + escapeXml(GRADUATION_PLIST_LABEL) + '</string>',
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>' + escapeXml(nodePath) + '</string>',
    '    <string>' + escapeXml(scriptPath) + '</string>',
    '  </array>',
    '  <key>WorkingDirectory</key>',
    '  <string>' + escapeXml(workingDirectory) + '</string>',
    '  <key>StartCalendarInterval</key>',
    '  <dict>',
    '    <key>Hour</key>',
    '    <integer>6</integer>',
    '    <key>Minute</key>',
    '    <integer>0</integer>',
    '  </dict>',
    '  <key>StandardOutPath</key>',
    '  <string>' + escapeXml(logPath) + '</string>',
    '  <key>StandardErrorPath</key>',
    '  <string>' + escapeXml(logPath) + '</string>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PATH</key>',
    '    <string>' + escapeXml(pathValue) + '</string>',
    '    <key>WASURENAGUSA_JEV_IMPORT_CMD</key>',
    '    <string>' + escapeXml(jevImportCommand) + '</string>',
    '    <key>WASURENAGUSA_JEV_IMPORT_OUT</key>',
    '    <string>' + escapeXml(jevImportOutputPath) + '</string>',
    '  </dict>',
    '</dict>',
    '</plist>',
  ].join("\n");
}

export function buildAbstractionPlistXml(
  nodePath: string,
  scriptPath: string,
  logPath: string,
  codexPath: string,
  quotaCommand: string,
  homePath: string,
  pathValue: string,
): string {
  const workingDirectory = resolve(dirname(scriptPath), "..", "..");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(ABSTRACTION_PLIST_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(scriptPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(workingDirectory)}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>5</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${escapeXml(homePath)}</string>
    <key>PATH</key>
    <string>${escapeXml(pathValue)}</string>
    <key>WASURENAGUSA_CODEX_BIN</key>
    <string>${escapeXml(codexPath)}</string>
    <key>WASURENAGUSA_CODEX_QUOTA_CMD</key>
    <string>${escapeXml(quotaCommand)}</string>
  </dict>
</dict>
</plist>`;
}

export async function writeAbstractionPlist(
  plistPath: string,
  input: {
    nodePath: string;
    scriptPath: string;
    logPath: string;
    codexPath: string;
    quotaCommand: string;
    homePath: string;
    pathValue: string;
  },
): Promise<void> {
  await writeFile(plistPath, buildAbstractionPlistXml(
    input.nodePath,
    input.scriptPath,
    input.logPath,
    input.codexPath,
    input.quotaCommand,
    input.homePath,
    input.pathValue,
  ), "utf-8");
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
  const archiveScriptPath = getArchiveTranscriptsPath();
  if (!existsSync(archiveScriptPath)) {
    log(`ERROR: archive-transcripts.mjs not found at ${archiveScriptPath}`);
    process.exit(1);
  }
  const strengthScriptPath = getStrengthJobPath();
  if (!existsSync(strengthScriptPath)) {
    log(`ERROR: strength-job.js not found at ${strengthScriptPath}`);
    process.exit(1);
  }
  const abstractionScriptPath = getAbstractionJobPath();
  if (!existsSync(abstractionScriptPath)) {
    log(`ERROR: abstract-principles.js not found at ${abstractionScriptPath}`);
    process.exit(1);
  }
  const graduationScriptPath = getGraduationJobPath();
  if (!existsSync(graduationScriptPath)) {
    log("ERROR: graduation-export.js not found at " + graduationScriptPath);
    process.exit(1);
  }
  const codexPath = resolveCodexBinaryPath();
  const quotaCommand = resolveAbstractionQuotaCommand();

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
  }

  const archivePlistPath = getArchivePlistPath();
  const archiveLogPath = join(logDir, "archive-transcripts.log");
  if (existsSync(archivePlistPath)) {
    try {
      execSync(`launchctl unload "${archivePlistPath}"`, { stdio: "ignore" });
    } catch {
    }
  }
  const archivePlistContent = buildArchivePlistXml(
    nodePath,
    archiveScriptPath,
    archiveLogPath,
  );
  await writeFile(archivePlistPath, archivePlistContent, "utf-8");
  try {
    execSync(`launchctl load "${archivePlistPath}"`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log(`WARNING: launchctl load failed: ${message}`);
    log(`Plist was written to ${archivePlistPath}. You may need to load it manually.`);
  }

  const strengthPlistPath = getStrengthPlistPath();
  const strengthLogPath = join(logDir, "strength-job.log");
  if (existsSync(strengthPlistPath)) {
    try {
      execSync(`launchctl unload "${strengthPlistPath}"`, { stdio: "ignore" });
    } catch {
    }
  }
  const strengthPlistContent = buildStrengthPlistXml(nodePath, strengthScriptPath, strengthLogPath);
  await writeFile(strengthPlistPath, strengthPlistContent, "utf-8");
  try {
    execSync(`launchctl load "${strengthPlistPath}"`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log(`WARNING: launchctl load failed: ${message}`);
    log(`Plist was written to ${strengthPlistPath}. You may need to load it manually.`);
  }

  const graduationPlistPath = getGraduationPlistPath();
  const graduationLogPath = join(logDir, "graduation-export.log");
  if (existsSync(graduationPlistPath)) {
    try {
      execSync("launchctl unload \"" + graduationPlistPath + "\"", { stdio: "ignore" });
    } catch {
    }
  }
  const graduationPlistContent = buildGraduationPlistXml(
    nodePath,
    graduationScriptPath,
    graduationLogPath,
  );
  await writeFile(graduationPlistPath, graduationPlistContent, "utf-8");
  try {
    execSync("launchctl load \"" + graduationPlistPath + "\"");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log("WARNING: launchctl load failed: " + message);
    log("Plist was written to " + graduationPlistPath + ". You may need to load it manually.");
  }
  log("Installed graduation job: " + graduationPlistPath);
  log("Graduation schedule: Daily at 06:00");

  const abstractionPlistPath = getAbstractionPlistPath();
  const abstractionLogPath = join(logDir, "abstract-principles.log");
  if (existsSync(abstractionPlistPath)) {
    try {
      execSync(`launchctl unload "${abstractionPlistPath}"`, { stdio: "ignore" });
    } catch {
    }
  }
  await writeAbstractionPlist(abstractionPlistPath, {
    nodePath,
    scriptPath: abstractionScriptPath,
    logPath: abstractionLogPath,
    codexPath,
    quotaCommand,
    homePath: homedir(),
    pathValue: process.env.PATH ?? "",
  });
  try {
    execSync(`launchctl load "${abstractionPlistPath}"`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log(`WARNING: launchctl load failed: ${message}`);
    log(`Plist was written to ${abstractionPlistPath}. You may need to load it manually.`);
  }

  log(`Installed: ${plistPath}`);
  log(`Schedule: Daily at 02:00`);
  log(`Installed archive job: ${archivePlistPath}`);
  log(`Archive schedule: Daily at 03:00`);
  log(`Installed strength job: ${strengthPlistPath}`);
  log(`Strength schedule: Daily at 04:00`);
  log(`Installed abstraction job: ${abstractionPlistPath}`);
  log(`Abstraction schedule: Daily at 05:00`);
  log(`Log: ${logPath}`);
}

async function uninstallMacOS(): Promise<void> {
  const plistPaths = [
    getPlistPath(),
    getArchivePlistPath(),
    getStrengthPlistPath(),
    getAbstractionPlistPath(),
    getGraduationPlistPath(),
  ];
  if (!plistPaths.some((plistPath) => existsSync(plistPath))) {
    log("Not installed (plist not found).");
    return;
  }

  for (const plistPath of plistPaths) {
    if (!existsSync(plistPath)) {
      continue;
    }
    try {
      execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" });
    } catch {
    }
    await unlink(plistPath);
    log(`Uninstalled: removed ${plistPath}`);
  }
}

async function statusMacOS(): Promise<void> {
  const plistPath = getPlistPath();
  const archivePlistPath = getArchivePlistPath();
  const strengthPlistPath = getStrengthPlistPath();
  const abstractionPlistPath = getAbstractionPlistPath();
  const graduationPlistPath = getGraduationPlistPath();
  for (const [label, path] of [
    ["consolidate", plistPath],
    ["archive-transcripts", archivePlistPath],
    ["correction-strength", strengthPlistPath],
    ["correction-abstraction", abstractionPlistPath],
    ["correction-graduation", graduationPlistPath],
  ] as const) {
    log(`${label} status: ${existsSync(path) ? `INSTALLED (${path})` : "NOT installed"}`);
  }

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

function getStrengthCrontabEntry(): string {
  const nodePath = process.execPath;
  const scriptPath = getStrengthJobPath();
  const logPath = join(getLogDir(), "strength-job.log");
  return `0 4 * * * ${nodePath} ${scriptPath} >> ${logPath} 2>&1 ${STRENGTH_CRONTAB_MARKER}`;
}

function getAbstractionCrontabEntry(
  codexPath: string,
  quotaCommand: string,
): string {
  const nodePath = process.execPath;
  const scriptPath = getAbstractionJobPath();
  const logPath = join(getLogDir(), "abstract-principles.log");
  const pathValue = process.env.PATH ?? "";
  return `0 5 * * * HOME=${shellQuote(homedir())} PATH=${shellQuote(pathValue)} WASURENAGUSA_CODEX_BIN=${shellQuote(codexPath)} WASURENAGUSA_CODEX_QUOTA_CMD=${shellQuote(quotaCommand)} ${shellQuote(nodePath)} ${shellQuote(scriptPath)} >> ${shellQuote(logPath)} 2>&1 ${ABSTRACTION_CRONTAB_MARKER}`;
}

function getGraduationCrontabEntry(): string {
  const nodePath = process.execPath;
  const scriptPath = getGraduationJobPath();
  const logPath = join(getLogDir(), "graduation-export.log");
  const jevImportCommand = getDefaultJevImportCommand();
  const jevImportOutputPath = getDefaultJevImportOutputPath();
  let pathValue = "";
  if (process.env.PATH !== undefined) pathValue = process.env.PATH;
  return "0 6 * * * PATH=" + shellQuote(pathValue) +
    " WASURENAGUSA_JEV_IMPORT_CMD=" + shellQuote(jevImportCommand) +
    " WASURENAGUSA_JEV_IMPORT_OUT=" + shellQuote(jevImportOutputPath) +
    " " + shellQuote(nodePath) + " " + shellQuote(scriptPath) + " >> " + shellQuote(logPath) +
    " 2>&1 " + GRADUATION_CRONTAB_MARKER;
}

function getCurrentCrontab(): string {
  try {
    return execSync("crontab -l 2>/dev/null", { encoding: "utf-8" });
  } catch {
    return "";
  }
}

async function installLinux(): Promise<void> {
  const graduationScriptPath = getGraduationJobPath();
  if (!existsSync(graduationScriptPath)) {
    log("ERROR: graduation-export.js not found at " + graduationScriptPath);
    process.exit(1);
  }
  const scriptPath = getConsolidateAllJsPath();
  if (!existsSync(scriptPath)) {
    log(`ERROR: consolidate-all.js not found at ${scriptPath}`);
    log("Run 'npm run build' first.");
    process.exit(1);
  }
  const strengthScriptPath = getStrengthJobPath();
  if (!existsSync(strengthScriptPath)) {
    log(`ERROR: strength-job.js not found at ${strengthScriptPath}`);
    process.exit(1);
  }
  const abstractionScriptPath = getAbstractionJobPath();
  if (!existsSync(abstractionScriptPath)) {
    log(`ERROR: abstract-principles.js not found at ${abstractionScriptPath}`);
    process.exit(1);
  }
  const codexPath = resolveCodexBinaryPath();
  const quotaCommand = resolveAbstractionQuotaCommand();

  // ログディレクトリ作成
  const logDir = getLogDir();
  await mkdir(logDir, { recursive: true });

  const currentCrontab = getCurrentCrontab();

  // 既にインストール済みなら置換
  const lines = currentCrontab.split("\n");
  const filtered = lines.filter((line) => !line.includes(CRONTAB_MARKER)
    && !line.includes(STRENGTH_CRONTAB_MARKER) && !line.includes(ABSTRACTION_CRONTAB_MARKER)
    && !line.includes(GRADUATION_CRONTAB_MARKER));
  filtered.push(getCrontabEntry());
  filtered.push(getStrengthCrontabEntry());
  filtered.push(getAbstractionCrontabEntry(codexPath, quotaCommand));
  filtered.push(getGraduationCrontabEntry());

  // 末尾の空行を1つだけ残す
  const newCrontab = filtered.filter((line, i) => {
    if (i === filtered.length - 1 && line === "") return false;
    return true;
  }).join("\n") + "\n";

  execSync("crontab -", { input: newCrontab });

  log("Installed crontab entry.");
  log("Schedule: Daily at 02:00");
  log("Strength schedule: Daily at 04:00");
  log("Abstraction schedule: Daily at 05:00");
  log("Graduation schedule: Daily at 06:00");
  log(`Log: ${getLogPath()}`);
}

async function uninstallLinux(): Promise<void> {
  const currentCrontab = getCurrentCrontab();

  if (!currentCrontab.includes(CRONTAB_MARKER) && !currentCrontab.includes(STRENGTH_CRONTAB_MARKER)
    && !currentCrontab.includes(ABSTRACTION_CRONTAB_MARKER)
    && !currentCrontab.includes(GRADUATION_CRONTAB_MARKER)) {
    log("Not installed (crontab entry not found).");
    return;
  }

  const lines = currentCrontab.split("\n");
  const filtered = lines.filter((line) => !line.includes(CRONTAB_MARKER)
    && !line.includes(STRENGTH_CRONTAB_MARKER) && !line.includes(ABSTRACTION_CRONTAB_MARKER)
    && !line.includes(GRADUATION_CRONTAB_MARKER));
  const newCrontab = filtered.join("\n");

  execSync("crontab -", { input: newCrontab });
  log("Uninstalled: removed crontab entry.");
}

async function statusLinux(): Promise<void> {
  const currentCrontab = getCurrentCrontab();
  const consolidateInstalled = currentCrontab.includes(CRONTAB_MARKER);
  const strengthInstalled = currentCrontab.includes(STRENGTH_CRONTAB_MARKER);
  const abstractionInstalled = currentCrontab.includes(ABSTRACTION_CRONTAB_MARKER);
  const graduationInstalled = currentCrontab.includes(GRADUATION_CRONTAB_MARKER);

  if (!consolidateInstalled && !strengthInstalled && !abstractionInstalled && !graduationInstalled) {
    log("Status: NOT installed");
    return;
  }

  log(`consolidate status: ${consolidateInstalled ? "INSTALLED" : "NOT installed"}`);
  log(`correction-strength status: ${strengthInstalled ? "INSTALLED" : "NOT installed"}`);
  log(`correction-abstraction status: ${abstractionInstalled ? "INSTALLED" : "NOT installed"}`);
  if (consolidateInstalled) log("Schedule: Daily at 02:00 (crontab)");
  if (strengthInstalled) log("Strength schedule: Daily at 04:00 (crontab)");
  log("correction-graduation status: " + (graduationInstalled ? "INSTALLED" : "NOT installed"));
  if (abstractionInstalled) log("Abstraction schedule: Daily at 05:00 (crontab)");
  if (graduationInstalled) log("Graduation schedule: Daily at 06:00 (crontab)");

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

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    log(`Fatal: ${message}`);
    process.exit(1);
  });
}
