-- Free entry toggle for E-Sports tournaments
-- Database is selected via MYSQL_DATABASE in .env (run-sql.js).

SET @has_free_entry := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'esports_events'
    AND COLUMN_NAME = 'is_free_entry'
);

SET @add_free_entry_sql := IF(
  @has_free_entry = 0,
  'ALTER TABLE esports_events ADD COLUMN is_free_entry TINYINT(1) NOT NULL DEFAULT 0 AFTER entry_price_mwk',
  'SELECT 1'
);

PREPARE add_free_entry_stmt FROM @add_free_entry_sql;
EXECUTE add_free_entry_stmt;
DEALLOCATE PREPARE add_free_entry_stmt;

UPDATE esports_events SET is_free_entry = 1 WHERE entry_price_mwk = 0;
