/**
 * 既存5件の怒り記憶エントリに scenario / whyCore を追加する migration スクリプト。
 * storage.save({ replaceId, ... }) パスを使い、FTS5 同期トリガーも正常に動作する。
 * positiveAction は既存値があれば維持、なければ下記新値で上書き。
 *
 * Usage: npx ts-node --esm scripts/migrate-anger-3elements.ts [memoryDbPath]
 * Default memoryDbPath: ~/.wasurenagusa/memory.db
 */

import { SQLiteStorage } from "../src/storage/sqlite.js";
import { homedir } from "os";
import { join } from "path";
import { existsSync } from "fs";

const MIGRATIONS = [
  {
    id: "mow30vwu-731c",
    title: "データは完全形保存／表示は表示層で制御",
    scenario: "politician-checker パイプラインで公報原文先頭20字を切り捨てて格納（firstPromiseText.substring(0,20)）。今回が3度目の発生",
    whyCore: "データ層で切り詰めると後で完全形が必要な時に取り戻せず、再々々発は致命的。表示制約は表示層に委譲すべき",
    positiveActionFallback: "文字列・数値・日付・配列・LLM出力のいずれのデータも保存層では完全形を保持し、表示文字数制限はCSS truncation または display:none で表示層に委譲する",
  },
  {
    id: "monrvh07-a715",
    title: "テスト送信は実装上オーバーライドが効くパスのみ使う",
    scenario: "2026-05-02 resendTaskList を regenerate=true + channelOverride=テストチャンネル で叩いたが regenerate=true パスは channelOverride を無視する実装で CEO Hotline 本番チャンネルに誤投稿",
    whyCore: "同じエンドポイントでも regenerate フラグ等のサブパスで配信先決定ロジックが変わる。実装上のオーバーライドが効くか確認せず実行すると本番事故になる",
    positiveActionFallback: "テスト送信前に該当パスの送信先がどう決まるか実装行を読み、オーバーライドが実装上効くパス／モックSlack／ログ確認のみのいずれかを選ぶ。本番送信になる可能性が1%でもあれば実行しない",
  },
  {
    id: "mp00qm6e-eeaf",
    title: "改修前にGit履歴→現状差分→改修案を先出しして承認を得る",
    scenario: "politician-checker のプロンプト・スキーマ・実装改修を設計提示なしで独断実行、tmp/配下のファイルを AI主導で削除（または提案）した",
    whyCore: "過去リファクタの設計原則（スタンス除去・チェックポイント[]ベース・policy_review廃止）と矛盾する独断実装が繰り返され、チームの設計原則を破壊する。.gitignore除外もオーナー管理範囲",
    positiveActionFallback: "改修タスク受領時は着手前に過去Git履歴調査→現状との差分→改修案を文書で先出しし、オーナー承認を得てから実装。ファイル削除推奨は独断却下し、別の運用設計による代替案のみを提示する",
  },
  {
    id: "mox5uxcn-6160",
    title: "プロンプトは肯定形で書き、数値カウントはコード側で処理する",
    scenario: "politician-checkerのスロット分析・一貫性分析プロンプトで肯定形ルールの裏に否定形（しない・含めない・禁止）を混ぜ、20文字以下ならタイル型のような文字数閾値をLLMにカウントさせた",
    whyCore: "否定形は命令解釈精度を下げ、LLMはトークン単位処理なので文字数・個数・比率を正確に数えられず、数値閾値指示は動作を不安定にする",
    positiveActionFallback: "プロンプト改修時は『しない』『禁止』を新規追加せず既存の否定形を肯定形に書き換え、文字数や個数の判定はコード側でカウント・検証するか、few-shotと質的パターン名による定性的誘導に切り替える",
  },
  {
    id: "mowxnwnu-dfe4",
    title: "過去コミットのミスはコミット時系列・diffで判断してAI側の帰責で報告する",
    scenario: "AIがGit author=オーナー名のコミットを『オーナーの判断』と扱って、過去仕様判断の根拠としオーナーに帰責した",
    whyCore: "Git authorはコミット名義であり仕様判断者ではない。過去コミットは AI が起案・適用した経緯が大半で、ミスは AI 側のもの",
    positiveActionFallback: "過去コミットのミスは Git author を根拠にせず、コミット時系列・diff・当時のプロンプトで判断し、AI 側の帰責として報告する",
  },
];

function getDefaultDbPath(): string {
  const wasurenagusaDir = join(homedir(), ".wasurenagusa");
  return join(wasurenagusaDir, "memory.db");
}

function main(): void {
  const dbPath = process.argv[2] ?? getDefaultDbPath();
  const memoryPath = dbPath.replace(/\/memory\.db$/, "");

  if (!existsSync(dbPath)) {
    console.error(`DB not found: ${dbPath}`);
    process.exit(1);
  }

  const storage = new SQLiteStorage(dbPath);
  storage.initialize(memoryPath);

  let migratedCount = 0;
  let skippedCount = 0;

  for (const migration of MIGRATIONS) {
    const detail = storage.getDetail({ ids: [migration.id] });
    if (detail.entries.length === 0) {
      console.log(`SKIP (not found): ${migration.id}`);
      skippedCount++;
      continue;
    }

    const existing = detail.entries[0];
    const saveResult = storage.save({
      category: existing.category,
      title: migration.title,
      content: existing.content,
      tags: existing.tags,
      project: existing.project,
      scope: existing.scope,
      intensity: existing.intensity,
      knowledgeGap: existing.knowledgeGap,
      positiveAction: existing.positiveAction ?? migration.positiveActionFallback,
      scenario: migration.scenario,
      whyCore: migration.whyCore,
      replaceId: migration.id,
    });

    if (saveResult.success) {
      console.log(`OK: ${migration.id}`);
      console.log(`  title="${migration.title}"`);
      console.log(`  scenario="${migration.scenario.slice(0, 40)}..."`);
      console.log(`  whyCore="${migration.whyCore.slice(0, 40)}..."`);
      migratedCount++;
    } else {
      console.error(`FAIL: ${migration.id}`);
    }
  }

  storage.close();
  console.log(`\n完了: ${migratedCount}件migration, ${skippedCount}件スキップ`);
}

main();
