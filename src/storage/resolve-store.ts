import { existsSync, realpathSync, readFileSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { parse } from "dotenv";

/**
 * MCPとhookの保存先を同じ規則で解決する。
 *
 * @param projectRoot project保存先の基準ディレクトリ
 * @param executableUrl 実行ファイルのURL
 * @param memoryDirEnv 起動時のMEMORY_DIR
 * @param homeDir ホームディレクトリ
 */
export function resolveHookStore(
  projectRoot: string,
  executableUrl: string,
  memoryDirEnv: string | undefined,
  homeDir: string = homedir(),
): string {
  let memoryDir = memoryDirEnv;

  if (memoryDir === undefined || memoryDir === "") {
    const packageRoot = findPackageRoot(fileURLToPath(executableUrl));
    memoryDir = readMemoryDir(join(packageRoot, ".env"));
  }

  if (memoryDir === undefined || memoryDir === "") {
    memoryDir = readMemoryDir(join(homeDir, ".wasurenagusa", ".env"));
  }

  if (memoryDir === undefined || memoryDir === "") {
    memoryDir = ".wasurenagusa";
  }

  if (isAbsolute(memoryDir)) {
    return resolve(memoryDir);
  }

  return resolve(projectRoot, memoryDir);
}

function readMemoryDir(envPath: string): string | undefined {
  if (!existsSync(envPath)) {
    return undefined;
  }

  return parse(readFileSync(envPath)).MEMORY_DIR;
}

function findPackageRoot(executablePath: string): string {
  const realExecutablePath = realpathSync(executablePath);
  let currentDirectory = dirname(realExecutablePath);

  while (true) {
    if (existsSync(join(currentDirectory, "package.json"))) {
      return currentDirectory;
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      throw new Error("Package root not found for executable URL");
    }

    currentDirectory = parentDirectory;
  }
}
