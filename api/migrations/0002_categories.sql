-- Each account's own categories: JSON [{ id: 'c_…', label, emoji, words: [...] }].
ALTER TABLE users ADD COLUMN categories TEXT;
ALTER TABLE users ADD COLUMN categories_updated_at INTEGER NOT NULL DEFAULT 0;
