# tests/fixtures/mini-store/

機構検証専用の合成日本語ミニストア（design.md「合成日本語ミニfixture」、タスク0.11）。

## ラベル（必読）

**ゲートロジックとプロパティテストとスキーマ移行の機構検証専用。recallやトークナイザ実効の品質主張には使わない。**

- 用途: `scripts/gates/` 配下のゲートスクリプトのロジック検証（PASS/FAILの判定が正しいこと）、
  PT-01/02/03/05（プロパティテスト、Phase 1以降で追加）、スキーマ移行がクリーンクローンと
  CIで実行できることの確認。
- 禁止: recall・トークナイザ実効・自己検索性（PT-04）等の「検索や統合の品質」を主張する
  検証には使わない。品質測定はローカル実データ層（環境変数 `WASURENAGUSA_EVAL_DIR` が指す
  ディレクトリ、Git外）に限定する。本fixtureの結果を根拠に「検索精度が◯%」等の主張をしない。

## 内容

- `build-mini-store.ts`: 合成日本語データで満たされたSQLiteストアを新規構築するヘルパー。
  実装コードの `save`/`softDelete`/`upsertVector` をそのまま使うため、本番と同じスキーマ・
  トリガー経由でデータが作られる。
- 内容は完全な合成データであり、実在の人物・組織・秘密値を含まない。プロジェクト名も
  実在プロジェクトと無関係な架空名（`sample-webapp` 等）のみを使う。
- 生成物はテスト実行時に一時ディレクトリへ書き出す想定で、本ディレクトリ自体には
  生成済みDBやログをコミットしない（`build-mini-store.ts` を呼び出すたびに新規構築する）。

## 使い方

```ts
import { buildMiniStore } from "./build-mini-store.js";

const result = buildMiniStore("/tmp/xxxx/.wasurenagusa", {
  count: 1000, // G0の前提アサート（memories総件数1,000件以上）のPASS経路を確認する場合
  seedGuardPattern: true, // guard-gen-stopped検査用のconsolidated-dont.jsonを同梱
});
```
