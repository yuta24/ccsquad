import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EntryStore, entryKey, MemoryEntry } from "../src/entry.js";

function tempStore(): { store: EntryStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ccsquad-entry-test-"));
  const store = new EntryStore(dir);
  store.ensureDir();
  return {
    store,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeEntry(title: string, entryType: string | undefined, body: string): MemoryEntry {
  const now = new Date().toISOString();
  return {
    title,
    frontmatter: {
      type: entryType,
      created_at: now,
      updated_at: now,
    },
    body,
  };
}

function makeEntryWithTime(
  title: string,
  entryType: string | undefined,
  body: string,
  createdAt: string,
): MemoryEntry {
  return {
    title,
    frontmatter: {
      type: entryType,
      created_at: createdAt,
      updated_at: createdAt,
    },
    body,
  };
}

describe("entry", () => {
  describe("test_save_and_load_without_type", () => {
    it("typeなしでsave/loadできる", () => {
      const { store, cleanup } = tempStore();
      try {
        const entry = makeEntry("認証方式", undefined, "JWTを採用した。");
        store.save(entry);

        const loaded = store.load("認証方式");
        expect(loaded.title).toBe("認証方式");
        expect(loaded.frontmatter.type).toBeUndefined();
        expect(loaded.body).toContain("JWTを採用した");
      } finally {
        cleanup();
      }
    });
  });

  describe("test_save_and_load_with_type", () => {
    it("typeありでsave/loadできる", () => {
      const { store, cleanup } = tempStore();
      try {
        const entry = makeEntry("JWT採用理由", "decision", "JWTを採用した。");
        store.save(entry);

        const loaded = store.load("decision/JWT採用理由");
        expect(loaded.title).toBe("JWT採用理由");
        expect(loaded.frontmatter.type).toBe("decision");
        expect(loaded.body).toContain("JWTを採用した");
      } finally {
        cleanup();
      }
    });
  });

  describe("test_key", () => {
    it("typeなしのkeyはtitleのみ", () => {
      const entry = makeEntry("認証方式", undefined, "");
      expect(entryKey(entry)).toBe("認証方式");
    });

    it("typeありのkeyはtype/title", () => {
      const entry = makeEntry("JWT採用理由", "decision", "");
      expect(entryKey(entry)).toBe("decision/JWT採用理由");
    });
  });

  describe("test_duplicate_title_error", () => {
    it("同じtitleで重複saveするとエラー", () => {
      const { store, cleanup } = tempStore();
      try {
        const entry = makeEntry("認証方式", undefined, "body1");
        store.save(entry);

        const entry2 = makeEntry("認証方式", undefined, "body2");
        expect(() => store.save(entry2)).toThrow();
      } finally {
        cleanup();
      }
    });
  });

  describe("test_forbidden_characters_in_title", () => {
    it("titleに / が含まれるとエラー", () => {
      const { store, cleanup } = tempStore();
      try {
        const entry = makeEntry("bad/name", undefined, "body");
        expect(() => store.save(entry)).toThrow();
      } finally {
        cleanup();
      }
    });

    it("titleに \\0 が含まれるとエラー", () => {
      const { store, cleanup } = tempStore();
      try {
        const entry = makeEntry("bad\0name", undefined, "body");
        expect(() => store.save(entry)).toThrow();
      } finally {
        cleanup();
      }
    });
  });

  describe("test_forbidden_characters_in_type", () => {
    it("typeに / が含まれるとエラー", () => {
      const { store, cleanup } = tempStore();
      try {
        const entry = makeEntry("title", "bad/type", "body");
        expect(() => store.save(entry)).toThrow();
      } finally {
        cleanup();
      }
    });
  });

  describe("test_empty_title_error", () => {
    it("空のtitleはエラー", () => {
      const { store, cleanup } = tempStore();
      try {
        const entry = makeEntry("", undefined, "body");
        expect(() => store.save(entry)).toThrow();
      } finally {
        cleanup();
      }
    });
  });

  describe("test_empty_body", () => {
    it("空bodyのエントリを保存/ロードできる", () => {
      const { store, cleanup } = tempStore();
      try {
        const entry = makeEntry("タイトルのみ", undefined, "");
        store.save(entry);

        const loaded = store.load("タイトルのみ");
        expect(loaded.title).toBe("タイトルのみ");
        expect(loaded.body).toBe("");
      } finally {
        cleanup();
      }
    });
  });

  describe("test_list_all_created_at_desc", () => {
    it("created_at降順でリストされる", () => {
      const { store, cleanup } = tempStore();
      try {
        const now = new Date();
        const old = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
        const mid = new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString();
        const nowStr = now.toISOString();

        store.save(makeEntryWithTime("古い", undefined, "old", old));
        store.save(makeEntryWithTime("中間", "note", "mid", mid));
        store.save(makeEntryWithTime("新しい", "decision", "new", nowStr));

        const entries = store.listAll();
        expect(entries.length).toBe(3);
        expect(entries[0].title).toBe("新しい");
        expect(entries[1].title).toBe("中間");
        expect(entries[2].title).toBe("古い");
      } finally {
        cleanup();
      }
    });
  });

  describe("test_delete_and_empty_dir_cleanup", () => {
    it("削除後に空のtypeディレクトリも削除される", () => {
      const { store, cleanup } = tempStore();
      const dir = (store as unknown as { baseDir: string }).baseDir;
      try {
        const entry = makeEntry("唯一のエントリ", "decision", "body");
        store.save(entry);

        const decisionDir = join(dir, "decision");
        expect(require("fs").existsSync(decisionDir)).toBe(true);

        store.delete("decision/唯一のエントリ");

        expect(require("fs").existsSync(join(dir, "decision/唯一のエントリ.md"))).toBe(false);
        expect(require("fs").existsSync(decisionDir)).toBe(false);
      } finally {
        cleanup();
      }
    });
  });

  describe("test_delete_preserves_nonempty_dir", () => {
    it("他エントリが残る場合はtypeディレクトリを削除しない", () => {
      const { store, cleanup } = tempStore();
      const dir = (store as unknown as { baseDir: string }).baseDir;
      try {
        store.save(makeEntry("エントリ1", "decision", "body1"));
        store.save(makeEntry("エントリ2", "decision", "body2"));

        store.delete("decision/エントリ1");

        expect(require("fs").existsSync(join(dir, "decision"))).toBe(true);
      } finally {
        cleanup();
      }
    });
  });

  describe("test_delete_not_found", () => {
    it("存在しないエントリの削除はエラー", () => {
      const { store, cleanup } = tempStore();
      try {
        expect(() => store.delete("存在しない")).toThrow();
      } finally {
        cleanup();
      }
    });
  });

  describe("test_search_title_match", () => {
    it("タイトルの部分一致で検索できる", () => {
      const { store, cleanup } = tempStore();
      try {
        store.save(makeEntry("認証方式", undefined, "詳細"));
        store.save(makeEntry("DB設計", undefined, "テーブル定義"));

        const results = store.search("認証");
        expect(results.length).toBe(1);
        expect(results[0].title).toBe("認証方式");
      } finally {
        cleanup();
      }
    });
  });

  describe("test_search_body_match", () => {
    it("本文の部分一致で検索できる", () => {
      const { store, cleanup } = tempStore();
      try {
        store.save(makeEntry("設計メモ", undefined, "JWTトークンを使う"));
        store.save(makeEntry("別のメモ", undefined, "セッション管理"));

        const results = store.search("JWT");
        expect(results.length).toBe(1);
        expect(results[0].title).toBe("設計メモ");
      } finally {
        cleanup();
      }
    });
  });

  describe("test_search_type_filter", () => {
    it("typeフィルタで絞り込める", () => {
      const { store, cleanup } = tempStore();
      try {
        store.save(makeEntry("認証", "decision", "JWT"));
        store.save(makeEntry("認証メモ", "note", "JWT関連"));

        const results = store.search("JWT", "decision");
        expect(results.length).toBe(1);
        expect(results[0].frontmatter.type).toBe("decision");
      } finally {
        cleanup();
      }
    });
  });

  describe("test_search_no_match", () => {
    it("マッチしない場合は空配列", () => {
      const { store, cleanup } = tempStore();
      try {
        store.save(makeEntry("認証方式", undefined, "JWT"));

        const results = store.search("GraphQL");
        expect(results).toHaveLength(0);
      } finally {
        cleanup();
      }
    });
  });

  describe("test_overwrite_updates_body", () => {
    it("overwriteで本文を更新できる", () => {
      const { store, cleanup } = tempStore();
      try {
        const entry = makeEntry("認証方式", undefined, "旧本文");
        store.save(entry);

        const updated: MemoryEntry = { ...entry, body: "新本文" };
        store.overwrite(updated);

        const loaded = store.load("認証方式");
        expect(loaded.body).toContain("新本文");
        expect(loaded.body).not.toContain("旧本文");
      } finally {
        cleanup();
      }
    });
  });

  describe("test_overwrite_with_type", () => {
    it("typeありのエントリをoverwriteできる", () => {
      const { store, cleanup } = tempStore();
      try {
        const entry = makeEntry("メモ", "note", "旧");
        store.save(entry);

        const updated: MemoryEntry = { ...entry, body: "新" };
        store.overwrite(updated);

        const loaded = store.load("note/メモ");
        expect(loaded.body).toContain("新");
      } finally {
        cleanup();
      }
    });
  });

  describe("test_search_case_insensitive", () => {
    it("大文字小文字を区別せずに検索できる", () => {
      const { store, cleanup } = tempStore();
      try {
        store.save(makeEntry("Auth Design", undefined, "Use JWT tokens"));

        const results = store.search("jwt");
        expect(results.length).toBe(1);
      } finally {
        cleanup();
      }
    });
  });
});
