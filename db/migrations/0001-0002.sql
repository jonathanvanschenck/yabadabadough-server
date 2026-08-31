-- Migration 1 -> 2: add funds.description -- free-form prose describing what
-- the fund is for and the intentions behind it (NULL = none). Keep in sync
-- with the column in _schema.sql (which fresh databases get directly).

ALTER TABLE funds ADD COLUMN description TEXT;

PRAGMA user_version = 2;
