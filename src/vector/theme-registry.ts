import { SQLiteStorage } from "../storage/sqlite.js";

export class ThemeRegistry {
  private storage: SQLiteStorage;

  constructor(storage: SQLiteStorage) {
    this.storage = storage;
  }

  getThemes(): string[] {
    return this.storage.getThemes();
  }

  addThemes(themes: string[]): void {
    this.storage.addThemes(themes);
  }

  isNewTheme(theme: string): boolean {
    return this.storage.isNewTheme(theme);
  }
}
