DROP TABLE IF EXISTS game_player_cards;

SET @has_column := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'games' AND column_name = 'cards_source'
);
SET @drop_column := IF(@has_column = 1, 'ALTER TABLE games DROP COLUMN cards_source', 'SELECT 1');
PREPARE drop_column FROM @drop_column;
EXECUTE drop_column;
DEALLOCATE PREPARE drop_column;
