CREATE TABLE IF NOT EXISTS game_player_cards (
  game_id CHAR(36) NOT NULL,
  seat TINYINT UNSIGNED NOT NULL,
  pile_key VARCHAR(48) NOT NULL,
  count SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (game_id, seat, pile_key),
  CONSTRAINT fk_game_player_cards_game FOREIGN KEY (game_id) REFERENCES games (id) ON DELETE CASCADE,
  CONSTRAINT fk_game_player_cards_pile FOREIGN KEY (game_id, pile_key) REFERENCES game_piles (game_id, pile_key) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @has_column := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'games' AND column_name = 'cards_source'
);
SET @add_column := IF(
  @has_column = 0,
  'ALTER TABLE games ADD COLUMN cards_source ENUM(''tracked'', ''rebuilt'', ''none'') NOT NULL DEFAULT ''none''',
  'SELECT 1'
);
PREPARE add_column FROM @add_column;
EXECUTE add_column;
DEALLOCATE PREPARE add_column;

ALTER TABLE games ALTER COLUMN cards_source SET DEFAULT 'tracked';
