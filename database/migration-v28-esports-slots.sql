-- E-Sports tournament slot capacity (safe to re-run)
-- Database is selected via MYSQL_DATABASE in .env (run-sql.js).

SET @has_max_slots := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'esports_events'
    AND COLUMN_NAME = 'max_slots'
);

SET @add_max_slots_sql := IF(
  @has_max_slots = 0,
  'ALTER TABLE esports_events ADD COLUMN max_slots INT UNSIGNED NOT NULL DEFAULT 32 AFTER grand_prize_mwk',
  'SELECT 1'
);

PREPARE add_max_slots_stmt FROM @add_max_slots_sql;
EXECUTE add_max_slots_stmt;
DEALLOCATE PREPARE add_max_slots_stmt;
