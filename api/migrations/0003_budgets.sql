-- Monthly budgets per category, shared across an account's devices: JSON { categoryId: amount }.
ALTER TABLE users ADD COLUMN budgets TEXT;
ALTER TABLE users ADD COLUMN budgets_updated_at INTEGER NOT NULL DEFAULT 0;
