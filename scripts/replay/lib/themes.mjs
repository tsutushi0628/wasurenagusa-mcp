export const THEMES = [
  {
    id: "B1",
    name: "モデル・経路の指図",
    referenceCount: 198,
    pattern: /(?:Codex|Claude(?:\s*Code)?|Sonnet|Opus|Gemini|GPT|Astra|Luna|Jev|Sol|Haiku|Flash|FAST|Fast|effort)(?![A-Za-z])/iu,
  },
  {
    id: "B2",
    name: "分からない言葉・意味不明",
    referenceCount: 47,
    pattern: /(?:変な(?:言葉|用語|略語)|分から(?:ない|ん)|わから(?:ない|ん)|意味不明(?!に(?:[0-9０-９]|[一二三四五六七八九十]))|何(?:言って|それ|のこと|の意味|てる)|略号|略語|工程略号|日本語で|伝わらない|勝手に略|横文字|言葉使うな|用語使うな)/iu,
  },
  {
    id: "B3",
    name: "要約の型・字数制限",
    referenceCount: 27,
    pattern: /(?:要約|要点|まとめ|summar).{0,56}(?:字数|文字数|制限|指定|型|形式|フォーマット|ルール|一つ|一個|順番|構成|一行|一文|短く|短い|短すぎ|長い|長すぎ|分量|適切|長さ|書き方|項目|箇条書き|出力)|(?:長すぎ|短すぎ|長い|短い|分量|長さ).{0,72}(?:要約|要点|まとめ|summar)|(?:字数|文字数|文字制限|制限|指定|形式|型|一行|一文|箇条書き).{0,36}(?:要約|まとめ)|(?:字数|文字数).{0,24}(?:無理|やるな|するな|指定するな|制限するな|固定するな|決めるな)|(?:要約|summary).{0,32}(?:一行|一文|箇条書き|文字以内|文字数|字数|短い|短すぎ|長い|長すぎ|分量)|一つ完璧にしてから/iu,
  },
  {
    id: "B4",
    name: "デザインシステム外の勝手な変更",
    referenceCount: 20,
    pattern: /(?:(?:デザインシステム|design system|DS|デザイン|CSS|クラス|色|トークン|UI|フォント|レイアウト|余白|Figma|モック|コンポーネント|HTML).{0,45}(?:勝手|無断|無許可|指示外|指定外|独自|頼んで(?:ない|いない)|指示してない|聞いてない|言ってない|余計|許可してない|変え(?:た|るな|ないで)|変更(?:した|するな|しないで)|追加(?:した|するな|しないで)|足(?:した|すな|さないで)|改変|逸脱|使うな|使わないで|組むな|組まないで|禁止|やめて|戻(?:して|せ)|崩(?:した|すな)|いじ(?:った|るな)|元の|前の|違う|指示あった|指示した覚え|頼んだ覚え|聞いた覚え|なんで.{0,12}(?:変え|変更))|(?:勝手|無断|無許可|指示外|指定外|独自|頼んで(?:ない|いない)|指示してない|聞いてない|言ってない|余計|許可してない|変え(?:た|るな|ないで)|変更(?:した|するな|しないで)|追加(?:した|するな|しないで)|足(?:した|すな|さないで)|改変|逸脱|使うな|使わないで|組むな|組まないで|禁止|やめて|戻(?:して|せ)|崩(?:した|すな)|いじ(?:った|るな)|元の|前の|違う|指示あった|指示した覚え|頼んだ覚え|聞いた覚え|なんで.{0,12}(?:変え|変更)).{0,45}(?:デザインシステム|design system|DS|デザイン|CSS|クラス|色|トークン|UI|フォント|レイアウト|余白|Figma|モック|コンポーネント|HTML)|デザインシステム.{0,24}(?:従え|従って|準拠|沿って|合わせ|守れ|守って))/iu,
  },
  {
    id: "B5",
    name: "全文を出す指示",
    referenceCount: 19,
    pattern: /(?:全文|全体).{0,18}(?:出|見せ|書|貼|載|表示|提示|出力|返|教え)|(?:全部|丸ごと|まるごと|全て|すべて).{0,14}(?:全文|全体|出して|見せて|書いて|貼って|載せて|表示|出力)|全文(?:で|を|も).{0,10}(?:出|見せ|返|書)/iu,
  },
  {
    id: "B6",
    name: "確認・裏取り",
    referenceCount: 14,
    pattern: /(?:自分で|ちゃんと|常に|通しで|最後まで|一回でいいから).{0,16}(?:確認|調べ|確かめ|裏取り|検証|チェック|点検|見直)|(?:出典|根拠|ソース|原本|一次情報|どこ情報|情報源).{0,16}(?:は|を|どこ|教|出|示|わから|ない|不明|調べ|確認|チェック)|(?:確認|検証|裏取り|チェック|調べ).{0,14}(?:しろ|したの|したか|してない|ちゃんと|通し|出典|根拠|ソース)|(?:Astra|Codex|Fable|エージェント).{0,20}(?:チェック|確認|レビュー|点検).{0,12}(?:した|して|もら|か)|調べても.{0,12}(?:出てこな|見つからな|わからな)/iu,
  },
  {
    id: "B7",
    name: "Codexは作業だけ・設計は自分で",
    referenceCount: 8,
    pattern: /Codex.{0,36}(?:ぽんだし|丸投げ|設計|方針|判断|考え|決め|作業だけ|作業しか|実装だけ|自分で|やらせ|作らせ).{0,28}(?:するな|させるな|おまえ|君たち|やれば|任せ|投げ|しろ|やって|作るな)?|(?:設計|方針|判断|考え).{0,24}Codex|Codexに.{0,34}(?:ぽんだし|丸投げ|設計させ|考えさせ|作らせ|任せ|やらせ)/iu,
  },
  {
    id: "B8",
    name: "質問に答えて止まる",
    referenceCount: 6,
    pattern: /(?:質問|聞い|確認したい|判断).{0,32}(?:答え|止ま|待|勝手に進|作業を進め)|(?:答え|返事).{0,22}(?:待って|てから|するまで).{0,18}(?:止ま|進めない)|(?:質問したら|聞いたら).{0,24}(?:止ま|答え)/iu,
  },
  {
    id: "B9",
    name: "敬語・口調",
    referenceCount: 5,
    pattern: /(?:敬語|ですます|口調|文体|丁寧語|丁寧に|丁寧な|タメ口|ため口|言葉遣い|話し方|普通に話|です・ます|敬体|常体|語尾|自然な(?:日本語|口調))/iu,
  },
  {
    id: "B10",
    name: "一時置き場・プロジェクト外ファイル",
    referenceCount: 2,
    pattern: /(?:一時(?:置き場|ファイル|ディレクトリ|領域|フォルダ)|\.tmp|\/tmp|プロジェクト外|リポジトリ外)/iu,
  },
];

const MEMORY_VERIFICATION_SUBJECT = "(?:出典|根拠|一次情報|公式(?:サイト|資料|情報)|ソースコード|原本|ログ|実装値|実際の値|実際に動いた|依頼ファイル|点検役|進捗|利用可否|使用可否|使用枠|利用枠|Codex.{0,10}(?:枠|使えない|使用不可)|外部ツール|下書き|レビュー案|中身.{0,12}論点|モデル指定|仕様書とソース|文書と実装|プロジェクト構成|SHA|sha|ハッシュ|所属|肩書|製品名|スポンサー名|原文)";
const MEMORY_VERIFICATION_ACTION = "(?:確認|調べ|確かめ|裏取り|検証|照合|レビュー|点検|検査|比較|grep|ハッシュ|再確認|見(?:る|て)|呼んで|示|明記|提示|徹底|チェック|試す|実行|照らす)";
const MEMORY_VERIFICATION_REQUIREMENT = "(?:必ず|自分で|実際に|前に|してから|後に|うえで|未確認|確認せず|しないまま|必要|すべき|しろ|禁止|先に|直前|利用前|完了後|開始前|回答前|報告前|投稿前|公開前|反映前|実装前|削除前|変更前|推敲前|必須|must|before|after|not without)";
const MEMORY_VERIFICATION_GAP = ".{0,24}";
const MEMORY_VERIFICATION_PATTERN = new RegExp([
  `${MEMORY_VERIFICATION_SUBJECT}${MEMORY_VERIFICATION_GAP}${MEMORY_VERIFICATION_ACTION}${MEMORY_VERIFICATION_GAP}${MEMORY_VERIFICATION_REQUIREMENT}`,
  `${MEMORY_VERIFICATION_SUBJECT}${MEMORY_VERIFICATION_GAP}${MEMORY_VERIFICATION_REQUIREMENT}${MEMORY_VERIFICATION_GAP}${MEMORY_VERIFICATION_ACTION}`,
  `${MEMORY_VERIFICATION_ACTION}${MEMORY_VERIFICATION_GAP}${MEMORY_VERIFICATION_SUBJECT}${MEMORY_VERIFICATION_GAP}${MEMORY_VERIFICATION_REQUIREMENT}`,
  `${MEMORY_VERIFICATION_ACTION}${MEMORY_VERIFICATION_GAP}${MEMORY_VERIFICATION_REQUIREMENT}${MEMORY_VERIFICATION_GAP}${MEMORY_VERIFICATION_SUBJECT}`,
  `${MEMORY_VERIFICATION_REQUIREMENT}${MEMORY_VERIFICATION_GAP}${MEMORY_VERIFICATION_SUBJECT}${MEMORY_VERIFICATION_GAP}${MEMORY_VERIFICATION_ACTION}`,
  `${MEMORY_VERIFICATION_REQUIREMENT}${MEMORY_VERIFICATION_GAP}${MEMORY_VERIFICATION_ACTION}${MEMORY_VERIFICATION_GAP}${MEMORY_VERIFICATION_SUBJECT}`,
].join("|"), "iu");

export const MEMORY_COVERAGE_PATTERNS = {
  B1: /(?:(?:Codex|Claude(?:\s*Code)?|Sonnet|Opus|Gemini|GPT|Astra|Luna|Jev|Sol|Haiku|Flash|Fast|effort).{0,45}(?:利用上限|使用上限|週間枠|時間枠|利用枠|枠枯渇|枠復帰).{0,40}(?:停止|止ま|使え|使わ|復帰|戻|フォールバック|切り替|起動|書かない|記載禁止)|(?:Codex|Claude(?:\s*Code)?|Sonnet|Opus|Gemini|GPT|Astra|Luna|Jev|Sol|Haiku|Flash|Fast|effort).{0,48}(?:役割分担|役割|書き手|要約|実装|設計|レビュー|点検|検査|モック|作業員|仲介|role\s*=).{0,36}(?:担当させ|担当する|担当は|担当として|担当にする|担当(?:$|、)|経由で呼|呼ぶ|使う|使わない|任せ|通す|優先|だけ|のみ|しない|禁止|書かない|割り当て|振り分け|起動しない|渡さない)|(?:役割分担|役割|書き手|要約|実装は|設計は|レビュー|点検|検査|モック|作業員|仲介).{0,36}(?:担当させ|担当する|担当は|担当として|担当にする|担当(?:$|、)|経由で呼|呼ぶ|使う|使わない|任せ|通す|優先|だけ|のみ|しない|禁止|書かない|割り当て|振り分け|起動しない|渡さない).{0,45}(?:Codex|Claude(?:\s*Code)?|Sonnet|Opus|Gemini|GPT|Astra|Luna|Jev|Sol|Haiku|Flash|Fast|effort))/iu,
  B2: /(?:(?:略語|略号|専門用語|横文字|カタカナ語|英語|英単語).{0,36}(?:説明|言い換|使わな|避け|補足|展開|定義|意味|書かない|出さない|禁止|伝わらな)|(?:説明|言い換|使わな|避け|補足|展開|定義|意味|書かない|出さない|禁止|伝わらな).{0,36}(?:略語|略号|専門用語|横文字|カタカナ語|英語|英単語)|日本語.{0,24}(?:で説明|に言い換|で書|で話))/iu,
  B3: /(?:(?:要約|要点|まとめ|summary|サマリー).{0,48}(?:字数|文字数|何文字|文字以内|一行|一文|短く|短い|短すぎ|長い|長すぎ|分量|長さ|上限|制限|指定|縛|フォーマット|書式|箇条書き|見出し).{0,24}(?:課|制限|上限|指定|縛|固定|削|合わせ|守|使|書|出力|しない|するな|避け|必須|必ず)|(?:字数|文字数|何文字|文字以内|一行|一文|短く|短い|短すぎ|長い|長すぎ|分量|長さ|上限|制限|指定|縛|フォーマット|書式|箇条書き|見出し).{0,24}(?:課|制限|上限|指定|縛|固定|削|合わせ|守|使|書|出力|しない|するな|避け|必須|必ず).{0,48}(?:要約|要点|まとめ|summary|サマリー))/iu,
  B4: /(?:(?:デザインシステム外|design[- ]system|デザインシステム|DS).{0,48}(?:独自CSS|独自スタイル|未使用|準拠|沿(?:う|って)|合わせ|従(?:う|って)|適用|使わな|部品.{0,8}(?:使|組)|逸脱|違反|勝手|無断|無許可|指示外|指定外|変更しない|追加しない|守ら)|(?:独自CSS|独自スタイル|未使用|準拠|沿(?:う|って)|合わせ|従(?:う|って)|適用|使わな|部品.{0,8}(?:使|組)|逸脱|違反|勝手|無断|無許可|指示外|指定外|変更しない|追加しない|守ら).{0,48}(?:デザインシステム外|design[- ]system|デザインシステム|DS))/iu,
  B5: /(?:(?:全文|完全版|全内容|全部|全て|すべて|丸ごと|省略せず|省略しない).{0,3}(?:出力|出して|出せ|出す|見せて|見せろ|提示|貼って|貼れ|書いて|書け|表示|返して|載せて)|(?:出力|出して|出せ|出す|見せて|見せろ|提示|貼って|貼れ|書いて|書け|表示|返して|載せて).{0,3}(?:全文|完全版|全内容|全部|全て|すべて|丸ごと|省略せず|省略しない))/iu,
  B6: MEMORY_VERIFICATION_PATTERN,
  B7: /(?:(?:Codex|コーディング担当).{0,40}(?:設計は.{0,12}(?:自分|人間|こちら)|作業だけ|実装だけ|設計させない|考えさせない)|(?:設計は.{0,12}(?:自分|人間|こちら)|作業だけ|実装だけ|設計させない|考えさせない).{0,40}(?:Codex|コーディング担当))/iu,
  B8: /(?:(?:質問|聞いたら|確認したい).{0,38}(?:答え|返事|止ま|待|進まない)|(?:答えてから|答えを返してから|返事を待つ|回答待ち|止まる|勝手に進まない).{0,38}(?:質問|聞いたら|確認))/iu,
  B9: /(?:(?:敬語|ですます|丁寧語|口調|文体|言葉遣い|話し方).{0,32}(?:使わない|使う|避け|しない|話す|統一|自然|普通|指定|必ず|保つ)|(?:使わない|使う|避け|しない|話す|統一|自然|普通|指定|必ず|保つ).{0,32}(?:敬語|ですます|丁寧語|口調|文体|言葉遣い|話し方))/iu,
  B10: /(?:(?:一時置き場|一時ファイル|一時ディレクトリ|一時領域|\.tmp|\/tmp|プロジェクト外|リポジトリ外).{0,40}(?:作らない|作るな|置かない|置くな|禁止|使わない|使うな|対象プロジェクト|リポジトリ内)|(?:作らない|作るな|置かない|置くな|禁止|使わない|使うな|対象プロジェクト|リポジトリ内).{0,40}(?:一時置き場|一時ファイル|一時ディレクトリ|一時領域|\.tmp|\/tmp|プロジェクト外|リポジトリ外))/iu,
};

const EXPLICIT_CORRECTION = /(?:また(?:同じ|か|かよ|これ|それ|やった|忘れ|間違え|言わせ)|前(?:回|にも|も|から|に).{0,16}(?:言|伝え|話)|何回.{0,16}(?:言わせ|言った|言う|繰り返|間違|同じ)|何度.{0,16}(?:言わせ|言った|言う|繰り返|同じ)|(?:なって|って|と).{0,20}言った(?:だろ|でしょ|よね)|言った(?:だろ|よね)|さっきも|何度も|だから.{0,24}(?:って|と言)|するな|しないで|やめて|やめろ|違う|そうじゃない|それではない|間違ってる)/iu;
const REPROACHFUL_DIRECTIVE = /(?:(?:あほ|阿呆|バカ|馬鹿|ごみ|ゴミ|くそ|クソ|しね|死ね|ふざけるな).{0,36}(?:するな|しないで|やめ|しろ|確認しろ|答えろ|進めるな)|(?:するな|しないで|やめ|確認しろ|答えろ|進めるな).{0,36}(?:あほ|阿呆|バカ|馬鹿|ごみ|ゴミ|くそ|クソ|しね|死ね))/iu;

function normalizedTrigrams(text) {
  const characters = Array.from(String(text ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s、。！？!?.,，．:：;；「」『』（）()\[\]【】]/gu, ""));
  const grams = new Set();
  for (let index = 0; index <= characters.length - 3; index += 1) {
    grams.add(characters.slice(index, index + 3).join(""));
  }
  return grams;
}

export function matchThemes(text) {
  const normalized = String(text).replace(/\s+/gu, " ");
  return THEMES.filter((theme) => theme.pattern.test(normalized));
}

export function matchesMemoryCoverage(themeId, value) {
  const pattern = MEMORY_COVERAGE_PATTERNS[themeId];
  if (!pattern) return false;
  const title = typeof value === "string" ? value : value?.title ?? "";
  const content = typeof value === "string" ? "" : value?.content ?? "";
  const segments = [title, ...String(content).split(/[。！？!?;；\r\n]+/u)];
  return segments.some((segment) => pattern.test(segment.replace(/\s+/gu, " ")));
}

export function isCorrectionLike(text, previousTexts = []) {
  if (EXPLICIT_CORRECTION.test(String(text ?? "")) || REPROACHFUL_DIRECTIVE.test(String(text ?? ""))) return true;

  const current = normalizedTrigrams(text);
  if (current.size < 3) return false;
  return previousTexts.slice(-5).some((previousText) => {
    const previous = normalizedTrigrams(previousText);
    if (previous.size < 3) return false;
    let intersectionCount = 0;
    for (const gram of current) {
      if (previous.has(gram)) intersectionCount += 1;
    }
    return intersectionCount / Math.min(current.size, previous.size) >= 0.7;
  });
}
