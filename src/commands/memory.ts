import { readFileSync } from "node:fs";
import { EntryStore, MemoryEntry, MemoryFrontmatter, entryKey } from "../entry.js";

// --- helpers ---

export function truncate(s: string, maxLen: number): string {
  if ([...s].length <= maxLen) {
    return s;
  }
  return [...s].slice(0, maxLen - 2).join("") + "..";
}

function formatTimestamp(isoString: string): string {
  return new Date(isoString).toISOString().slice(0, 16).replace("T", " ");
}

export function entryToJson(entry: MemoryEntry): {
  key: string;
  title: string;
  type?: string;
  body: string;
  created_at: string;
  updated_at: string;
} {
  const obj: {
    key: string;
    title: string;
    type?: string;
    body: string;
    created_at: string;
    updated_at: string;
  } = {
    key: entryKey(entry),
    title: entry.title,
    body: entry.body,
    created_at: entry.frontmatter.created_at,
    updated_at: entry.frontmatter.updated_at,
  };
  if (entry.frontmatter.type !== undefined) {
    obj.type = entry.frontmatter.type;
  }
  return obj;
}

export function resolveBody(bodyArg?: string, file?: string): string | undefined {
  // --file is highest priority
  if (file !== undefined) {
    return readFileSync(file, "utf-8");
  }
  // positional argument
  if (bodyArg !== undefined) {
    return bodyArg;
  }
  // stdin if not a TTY
  if (!process.stdin.isTTY) {
    const buf = readFileSync(0, "utf-8");
    if (buf.length > 0) {
      return buf;
    }
  }
  return undefined;
}

// --- commands ---

export function cmdAdd(
  store: EntryStore,
  title: string,
  entryType?: string,
  bodyArg?: string,
  file?: string,
): void {
  const body = resolveBody(bodyArg, file) ?? "";
  const now = new Date().toISOString();

  const fm: MemoryFrontmatter = {
    type: entryType,
    created_at: now,
    updated_at: now,
  };

  const entry: MemoryEntry = { title, frontmatter: fm, body };

  store.save(entry);
  console.log(`メモリエントリを作成しました: ${entryKey(entry)}`);
}

export function cmdList(
  store: EntryStore,
  entryType?: string,
  format: "text" | "json" = "text",
): void {
  let entries = store.listAll();

  if (entryType !== undefined) {
    entries = entries.filter((e) => e.frontmatter.type === entryType);
  }

  if (format === "json") {
    const output = entries.map((e) => entryToJson(e));
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // text format
  if (entries.length === 0) {
    console.log("メモリエントリはありません。");
    return;
  }

  console.log(
    `${"タイプ".padEnd(16)} ${"タイトル".padEnd(30)} ${"作成日時".padEnd(20)} ${"更新日時".padEnd(20)}`,
  );
  console.log("-".repeat(88));
  for (const entry of entries) {
    const fm = entry.frontmatter;
    console.log(
      `${(fm.type ?? "-").padEnd(16)} ${truncate(entry.title, 28).padEnd(30)} ${formatTimestamp(fm.created_at).padEnd(20)} ${formatTimestamp(fm.updated_at).padEnd(20)}`,
    );
  }
}

export function cmdShow(store: EntryStore, key: string, format: "text" | "json" = "text"): void {
  const entry = store.load(key);

  if (format === "json") {
    console.log(JSON.stringify(entryToJson(entry), null, 2));
    return;
  }

  // text format
  console.log(`タイトル: ${entry.title}`);
  if (entry.frontmatter.type !== undefined) {
    console.log(`タイプ: ${entry.frontmatter.type}`);
  }
  console.log(`キー: ${entryKey(entry)}`);
  console.log(`作成日時: ${entry.frontmatter.created_at}`);
  console.log(`更新日時: ${entry.frontmatter.updated_at}`);
  if (entry.body.length > 0) {
    console.log();
    process.stdout.write(entry.body);
  }
}

export function cmdEdit(
  store: EntryStore,
  key: string,
  newTitle?: string,
  newType?: string,
  noType?: boolean,
  bodyArg?: string,
  file?: string,
): void {
  const oldEntry = store.load(key);

  const title = newTitle ?? oldEntry.title;

  let entryType: string | undefined;
  if (noType) {
    entryType = undefined;
  } else if (newType !== undefined) {
    entryType = newType;
  } else {
    entryType = oldEntry.frontmatter.type;
  }

  const body = resolveBody(bodyArg, file) ?? oldEntry.body;

  const newEntry: MemoryEntry = {
    title,
    frontmatter: {
      type: entryType,
      created_at: oldEntry.frontmatter.created_at,
      updated_at: new Date().toISOString(),
    },
    body,
  };

  const oldKey = entryKey(oldEntry);
  const newKey = entryKey(newEntry);

  if (oldKey !== newKey) {
    store.save(newEntry);
    store.delete(oldKey);
  } else {
    store.overwrite(newEntry);
  }

  console.log(`メモリエントリを更新しました: ${newKey}`);
}

export function cmdDelete(store: EntryStore, key: string): void {
  store.delete(key);
  console.log(`メモリエントリを削除しました: ${key}`);
}

export function cmdSearch(
  store: EntryStore,
  query: string,
  entryType?: string,
  format: "text" | "json" = "text",
): void {
  const results = store.search(query, entryType);

  if (format === "json") {
    const output = results.map((e) => entryToJson(e));
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // text format
  if (results.length === 0) {
    console.log("該当するエントリはありません。");
    return;
  }

  console.log(
    `${"タイプ".padEnd(16)} ${"タイトル".padEnd(30)} ${"作成日時".padEnd(20)} ${"更新日時".padEnd(20)}`,
  );
  console.log("-".repeat(88));
  for (const entry of results) {
    const fm = entry.frontmatter;
    console.log(
      `${(fm.type ?? "-").padEnd(16)} ${truncate(entry.title, 28).padEnd(30)} ${formatTimestamp(fm.created_at).padEnd(20)} ${formatTimestamp(fm.updated_at).padEnd(20)}`,
    );
  }
}
