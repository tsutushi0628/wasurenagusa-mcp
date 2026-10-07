import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAbstractionPlistXml,
  buildArchivePlistXml,
  buildGraduationPlistXml,
  buildStrengthPlistXml,
  resolveCodexBinaryPath,
  writeAbstractionPlist,
} from "./scheduler-setup";

describe("会話記録アーカイブのlaunchd設定", () => {
  it("1日1回、プロジェクト内でarchiveスクリプトを実行する", () => {
    const plist = buildArchivePlistXml(
      "/usr/bin/node",
      "/project/scripts/maintenance/archive-transcripts.mjs",
      "/project/.wasurenagusa/scheduler/logs/archive-transcripts.log",
    );

    expect(plist).toContain("com.wasurenagusa.archive-transcripts");
    expect(plist).toContain("<integer>3</integer>");
    expect(plist).toContain("<key>Minute</key>\n    <integer>0</integer>");
    expect(plist).toContain("/project/scripts/maintenance/archive-transcripts.mjs");
    expect(plist).toContain("<string>--all</string>");
    expect(plist).toContain("<key>WorkingDirectory</key>\n  <string>/project</string>");
  });

  it("installerのcwdではなくarchive scriptのpackage rootをWorkingDirectoryにする", () => {
    const plist = buildArchivePlistXml(
      "/usr/bin/node",
      "/installed/package/scripts/maintenance/archive-transcripts.mjs",
      "/scheduler/archive-transcripts.log",
    );

    expect(plist).toContain("<key>WorkingDirectory</key>\n  <string>/installed/package</string>");
    expect(plist).not.toContain("/installer/cwd");
  });

  it("plistのパスに含むXML予約文字をescapeする", () => {
    const plist = buildArchivePlistXml(
      "/usr/bin/node",
      "/project/a&b/scripts/maintenance/archive-transcripts.mjs",
      "/tmp/archive.log",
    );
    expect(plist).toContain("/project/a&amp;b/scripts/maintenance/archive-transcripts.mjs");
    expect(plist).toContain("<string>/project/a&amp;b</string>");
  });

  it("強度ジョブを毎日04時にパッケージ内で実行する", () => {
    const plist = buildStrengthPlistXml(
      "/usr/bin/node",
      "/installed/package/dist/cli/strength-job.js",
      "/scheduler/strength-job.log",
    );

    expect(plist).toContain("com.wasurenagusa.correction-strength");
    expect(plist).toContain("/installed/package/dist/cli/strength-job.js");
    expect(plist).toContain("<key>ProgramArguments</key>\n  <array>\n    <string>/usr/bin/node</string>\n    <string>/installed/package/dist/cli/strength-job.js</string>\n  </array>");
    expect(plist).toContain("<key>Hour</key>\n    <integer>4</integer>");
    expect(plist).toContain("<key>Minute</key>\n    <integer>0</integer>");
    expect(plist).toContain("<key>WorkingDirectory</key>\n  <string>/installed/package</string>");
    expect(plist).not.toContain("WASURENAGUSA_STRENGTH");
  });

  it("抽象化ジョブに絶対パス・HOME・PATH・枠コマンドを渡して毎日05時に実行する", () => {
    const plist = buildAbstractionPlistXml(
      "/usr/bin/node",
      "/installed/package/dist/cli/abstract-principles.js",
      "/scheduler/abstraction.log",
      "/opt/codex/bin/codex",
      "/projects/firebase-kit/.claude/hooks/scripts/codex-quota.py",
      "/fixture/home",
      "/opt/codex/bin:/usr/bin",
    );

    expect(plist).toContain("com.wasurenagusa.correction-abstraction");
    expect(plist).toContain("/opt/codex/bin/codex");
    expect(plist).toContain("<key>ProgramArguments</key>\n  <array>\n    <string>/usr/bin/node</string>\n    <string>/installed/package/dist/cli/abstract-principles.js</string>\n  </array>");
    expect(plist).toContain("<key>Hour</key>\n    <integer>5</integer>");
    expect(plist).toContain("<key>WASURENAGUSA_CODEX_QUOTA_CMD</key>");
    expect(plist).toContain("/projects/firebase-kit/.claude/hooks/scripts/codex-quota.py");
    expect(plist).toContain("<key>HOME</key>\n    <string>/fixture/home</string>");
    expect(plist).toContain("<key>PATH</key>\n    <string>/opt/codex/bin:/usr/bin</string>");
    expect(plist).not.toContain("WASURENAGUSA_PRINCIPLES");
    expect(plist).not.toContain("WASURENAGUSA_CORRECTION_LOOP");
    expect(plist).not.toContain("auth.json");
  });

  it("卒業提案CLIを引数なしで毎日06時に起動する", () => {
    const plist = buildGraduationPlistXml(
      "/usr/bin/node",
      "/installed/package/dist/cli/graduation-export.js",
      "/scheduler/graduation-export.log",
    );

    expect(plist).toContain("com.wasurenagusa.correction-graduation");
    expect(plist).toContain(
      "<key>ProgramArguments</key>\n  <array>\n    <string>/usr/bin/node</string>\n    <string>/installed/package/dist/cli/graduation-export.js</string>\n  </array>",
    );
    expect(plist).toContain("<key>Hour</key>\n    <integer>6</integer>");
    expect(plist).toContain("<key>Minute</key>\n    <integer>0</integer>");
    expect(plist).not.toContain("WASURENAGUSA_GRADUATION");
  });

  it("既設plistを再設置すると、夜間切替を固定しない内容へ置き換える", async () => {
    const directory = mkdtempSync(join(tmpdir(), "scheduler-setup-test-"));
    const plistPath = join(directory, "abstraction.plist");
    writeFileSync(plistPath, "<key>WASURENAGUSA_PRINCIPLES</key><string>shadow</string>");

    try {
      await writeAbstractionPlist(plistPath, {
        nodePath: "/usr/bin/node",
        scriptPath: "/installed/package/dist/cli/abstract-principles.js",
        logPath: "/scheduler/abstraction.log",
        codexPath: "/opt/codex/bin/codex",
        quotaCommand: "/hooks/codex-quota.py",
        homePath: "/fixture/home",
        pathValue: "/opt/codex/bin:/usr/bin",
      });

      const installedPlist = readFileSync(plistPath, "utf8");
      expect(installedPlist).toContain("com.wasurenagusa.correction-abstraction");
      expect(installedPlist).not.toContain("WASURENAGUSA_PRINCIPLES");
      expect(installedPlist).not.toContain("WASURENAGUSA_CORRECTION_LOOP");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("Codex実行ファイルは絶対パスで解決し、見つからない設定を拒否する", () => {
    expect(resolveCodexBinaryPath({ WASURENAGUSA_CODEX_BIN: process.execPath })).toBe(process.execPath);
    expect(() => resolveCodexBinaryPath({ WASURENAGUSA_CODEX_BIN: "codex", PATH: "" })).toThrow();
    expect(() => resolveCodexBinaryPath({ WASURENAGUSA_CODEX_BIN: "/missing/codex", PATH: "" })).toThrow();
  });
});
