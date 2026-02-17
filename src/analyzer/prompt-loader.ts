import { readFile } from "fs/promises";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = resolve(__dirname, "../../prompts");

export async function loadPrompt(filename: string): Promise<string> {
  const filePath = resolve(PROMPTS_DIR, filename);
  return await readFile(filePath, "utf-8");
}
