-- Dynamic Grand Prize Allocation (DGPA) — starting/base prize vs live prize
-- Database is selected via MYSQL_DATABASE in .env (run-sql.js).

SET @has_base_prize := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'esports_events'
    AND COLUMN_NAME = 'base_grand_prize_mwk'
);

SET @add_base_prize_sql := IF(
  @has_base_prize = 0,
  'ALTER TABLE esports_events ADD COLUMN base_grand_prize_mwk INT UNSIGNED NOT NULL DEFAULT 0 AFTER grand_prize_mwk',
  'SELECT 1'
);

PREPARE add_base_prize_stmt FROM @add_base_prize_sql;
EXECUTE add_base_prize_stmt;
DEALLOCATE PREPARE add_base_prize_stmt;

UPDATE esports_events
SET base_grand_prize_mwk = grand_prize_mwk
WHERE base_grand_prize_mwk = 0 AND grand_prize_mwk > 0;
