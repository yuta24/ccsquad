import type { AcceptanceCriterion } from "./types.js";

/**
 * reviewer メッセージ内のチェックリスト行から、各 AC の充足状態を抽出する。
 *
 * 対象フォーマット:
 *   - [x] 基準の説明: 補足
 *   - [ ] 基準の説明: 補足
 *
 * 返り値は { description, checked } の配列（メッセージに含まれるもののみ）。
 */
export interface ChecklistItem {
  description: string;
  checked: boolean;
}

const CHECKLIST_RE = /^[-*]\s+\[([ xX])\]\s+(.+)$/;

export function parseReviewerChecklist(message: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  for (const line of message.split("\n")) {
    const m = line.trim().match(CHECKLIST_RE);
    if (m) {
      const checked = m[1].toLowerCase() === "x";
      // "基準名: 補足テキスト" の形式の場合、コロン以前を description として採用
      const raw = m[2].trim();
      const colonIdx = raw.indexOf(":");
      const description = colonIdx > 0 ? raw.slice(0, colonIdx).trim() : raw;
      items.push({ checked, description });
    }
  }
  return items;
}

/**
 * AC 配列を reviewer のチェックリスト結果で更新する。
 *
 * マッチング戦略: チェックリストの description が AC の description を「含む」か、
 * AC の description がチェックリストの description を「含む」場合にマッチとみなす。
 * 大文字小文字を区別しない。
 *
 * done が true になることはあっても、一度 true になった done が false に戻ることはない
 * （reject 時に false に戻すと、以前のイテレーションで満たした AC が消えるため）。
 */
export function updateAcceptanceCriteria(
  criteria: AcceptanceCriterion[],
  message: string,
): AcceptanceCriterion[] {
  const checklist = parseReviewerChecklist(message);
  if (checklist.length === 0) return criteria;

  return criteria.map((ac) => {
    if (ac.done) return ac; // already fulfilled — never revert

    const match = checklist.find((item) => fuzzyMatch(ac.description, item.description));
    if (match && match.checked) {
      return { ...ac, done: true };
    }
    return ac;
  });
}

function fuzzyMatch(acDesc: string, checklistDesc: string): boolean {
  const a = normalize(acDesc);
  const b = normalize(checklistDesc);
  return a.includes(b) || b.includes(a);
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}
