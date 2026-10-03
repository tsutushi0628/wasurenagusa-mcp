import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { resolveHookStore } from "./resolve-store.js";

describe("resolveHookStore", () => {
  let fixtureRoot: string;
  let homeDir: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "wasurenagusa-store-test-"));
    homeDir = join(fixtureRoot, "home");
    mkdirSync(join(homeDir, ".wasurenagusa"), { recursive: true });
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("未設定ならprojectRoot直下の従来保存先を返す", () => {
    const projectRoot = join(fixtureRoot, "project");
    const packageRoot = join(fixtureRoot, "package");
    const executableUrl = createPackageExecutable(packageRoot);

    expect(resolveHookStore(projectRoot, executableUrl, undefined, homeDir)).toBe(
      join(projectRoot, ".wasurenagusa"),
    );
  });

  it("起動時環境変数をpackageとホームの.envより優先する", () => {
    const projectRoot = join(fixtureRoot, "project");
    const packageRoot = join(fixtureRoot, "package");
    const executableUrl = createPackageExecutable(packageRoot);
    writeFileSync(join(packageRoot, ".env"), "MEMORY_DIR=/central/store\n");
    writeFileSync(join(homeDir, ".wasurenagusa", ".env"), "MEMORY_DIR=/home/store\n");

    expect(resolveHookStore(projectRoot, executableUrl, "./project-store", homeDir)).toBe(
      join(projectRoot, "project-store"),
    );
  });

  it("環境の絶対値だけを中央保存先として採用する", () => {
    const projectRoot = join(fixtureRoot, "project");
    const packageRoot = join(fixtureRoot, "package");
    const executableUrl = createPackageExecutable(packageRoot);
    const centralStore = join(fixtureRoot, "central-store");

    expect(resolveHookStore(projectRoot, executableUrl, centralStore, homeDir)).toBe(centralStore);
  });

  it("package直下.envをホームの.envより優先する", () => {
    const projectRoot = join(fixtureRoot, "project");
    const packageRoot = join(fixtureRoot, "package");
    const executableUrl = createPackageExecutable(packageRoot);
    writeFileSync(join(packageRoot, ".env"), "MEMORY_DIR=package-store\n");
    writeFileSync(join(homeDir, ".wasurenagusa", ".env"), "MEMORY_DIR=home-store\n");

    expect(resolveHookStore(projectRoot, executableUrl, undefined, homeDir)).toBe(
      join(projectRoot, "package-store"),
    );
  });

  it("ホームの.envだけにある相対値をprojectRoot基準で解決する", () => {
    const projectRoot = join(fixtureRoot, "project");
    const packageRoot = join(fixtureRoot, "package");
    const executableUrl = createPackageExecutable(packageRoot);
    writeFileSync(join(homeDir, ".wasurenagusa", ".env"), "MEMORY_DIR=home-store\n");

    expect(resolveHookStore(projectRoot, executableUrl, undefined, homeDir)).toBe(
      join(projectRoot, "home-store"),
    );
  });

  it("ホームの.envにある絶対値をそのまま保存先にする", () => {
    const projectRoot = join(fixtureRoot, "project");
    const packageRoot = join(fixtureRoot, "package");
    const executableUrl = createPackageExecutable(packageRoot);
    const centralStore = join(fixtureRoot, "central-store");
    writeFileSync(join(homeDir, ".wasurenagusa", ".env"), `MEMORY_DIR="${centralStore}"\n`);

    expect(resolveHookStore(projectRoot, executableUrl, undefined, homeDir)).toBe(centralStore);
  });

  it("package直下.envのMEMORY_DIRだけをdotenvの引用・空白規則で読み、変数展開しない", () => {
    const projectRoot = join(fixtureRoot, "project");
    const packageRoot = join(fixtureRoot, "package");
    const executableUrl = createPackageExecutable(packageRoot);
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(projectRoot, ".env"), "MEMORY_DIR=project-env\n");
    writeFileSync(join(packageRoot, ".env"), "OTHER_KEY=ignored\nMEMORY_DIR=\"central store\"\n");

    expect(resolveHookStore(projectRoot, executableUrl, "", homeDir)).toBe(
      join(projectRoot, "central store"),
    );

    writeFileSync(join(packageRoot, ".env"), "ROOT_DIR=/central\nMEMORY_DIR=$ROOT_DIR/store\n");
    expect(resolveHookStore(projectRoot, executableUrl, undefined, homeDir)).toBe(
      join(projectRoot, "$ROOT_DIR/store"),
    );
  });

  it("package .envの絶対値を中央保存先にする", () => {
    const projectRoot = join(fixtureRoot, "project");
    const packageRoot = join(fixtureRoot, "package");
    const executableUrl = createPackageExecutable(packageRoot);
    const centralStore = join(fixtureRoot, "central-store");
    writeFileSync(join(packageRoot, ".env"), `MEMORY_DIR=\"${centralStore}\"\n`);

    expect(resolveHookStore(projectRoot, executableUrl, undefined, homeDir)).toBe(centralStore);
  });

  it("global node_modules内の実体をsymlink経由で起動してもprojectRootを使う", () => {
    const projectRoot = join(fixtureRoot, "project");
    const packageRoot = join(fixtureRoot, "global", "node_modules", "wasurenagusa-mcp");
    const realExecutableUrl = createPackageExecutable(packageRoot);
    const realExecutable = fileURLToPath(realExecutableUrl);
    const symlinkPath = join(fixtureRoot, "bin", "wasurenagusa-context.js");
    mkdirSync(dirname(symlinkPath), { recursive: true });
    symlinkSync(realExecutable, symlinkPath);

    const storePath = resolveHookStore(
      projectRoot,
      pathToFileURL(symlinkPath).href,
      undefined,
      homeDir,
    );

    expect(storePath).toBe(join(projectRoot, ".wasurenagusa"));
    expect(storePath).not.toContain("node_modules");
  });

  it("resolverがMEMORY_DIRをprocess.envへ追加しない", () => {
    const previousMemoryDir = process.env.MEMORY_DIR;
    const projectRoot = join(fixtureRoot, "project");
    const packageRoot = join(fixtureRoot, "package");
    const executableUrl = createPackageExecutable(packageRoot);
    writeFileSync(join(packageRoot, ".env"), "MEMORY_DIR=/central/store\n");
    delete process.env.MEMORY_DIR;

    try {
      resolveHookStore(projectRoot, executableUrl, undefined, homeDir);
      expect(process.env.MEMORY_DIR).toBeUndefined();
    } finally {
      if (previousMemoryDir === undefined) {
        delete process.env.MEMORY_DIR;
      } else {
        process.env.MEMORY_DIR = previousMemoryDir;
      }
    }
  });
});

function createPackageExecutable(packageRoot: string): string {
  const executablePath = join(packageRoot, "dist", "cli", "context.js");
  mkdirSync(dirname(executablePath), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), "{}\n");
  writeFileSync(executablePath, "");
  return pathToFileURL(executablePath).href;
}
