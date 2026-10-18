CREATE TABLE IF NOT EXISTS kingdoms (
  id CHAR(36) NOT NULL PRIMARY KEY,
  owner_user_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(60) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_kingdoms_owner_name (owner_user_id, name),
  CONSTRAINT fk_kingdoms_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS kingdom_cards (
  kingdom_id CHAR(36) NOT NULL,
  card_id CHAR(36) NOT NULL,
  position TINYINT UNSIGNED NOT NULL,
  PRIMARY KEY (kingdom_id, card_id),
  KEY idx_kingdom_cards_card (card_id),
  CONSTRAINT fk_kingdom_cards_kingdom FOREIGN KEY (kingdom_id) REFERENCES kingdoms (id) ON DELETE CASCADE,
  CONSTRAINT fk_kingdom_cards_card FOREIGN KEY (card_id) REFERENCES cards (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS card_preferences (
  owner_user_id BIGINT UNSIGNED NOT NULL,
  card_id CHAR(36) NOT NULL,
  preference ENUM('ban', 'require') NOT NULL,
  PRIMARY KEY (owner_user_id, card_id),
  KEY idx_card_preferences_pref (owner_user_id, preference),
  CONSTRAINT fk_card_preferences_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_card_preferences_card FOREIGN KEY (card_id) REFERENCES cards (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
