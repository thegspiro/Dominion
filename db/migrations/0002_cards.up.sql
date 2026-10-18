CREATE TABLE IF NOT EXISTS editions (
  id CHAR(36) NOT NULL PRIMARY KEY,
  name_en VARCHAR(80) NOT NULL,
  name_de VARCHAR(80) NOT NULL,
  release_date VARCHAR(16) NOT NULL,
  UNIQUE KEY uq_editions_name_en (name_en)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cards (
  id CHAR(36) NOT NULL PRIMARY KEY,
  name_en VARCHAR(64) NOT NULL,
  name_de VARCHAR(64) NOT NULL,
  price VARCHAR(8) NOT NULL,
  cost_coins SMALLINT UNSIGNED NULL,
  cost_potions TINYINT UNSIGNED NOT NULL DEFAULT 0,
  cost_debt SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  cost_variable TINYINT(1) NOT NULL DEFAULT 0,
  kingdom TINYINT(1) NOT NULL,
  KEY idx_cards_name_en (name_en),
  KEY idx_cards_cost_coins (cost_coins)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS card_types (
  card_id CHAR(36) NOT NULL,
  type VARCHAR(32) NOT NULL,
  PRIMARY KEY (card_id, type),
  KEY idx_card_types_type (type),
  CONSTRAINT fk_card_types_card FOREIGN KEY (card_id) REFERENCES cards (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS edition_cards (
  edition_id CHAR(36) NOT NULL,
  card_id CHAR(36) NOT NULL,
  PRIMARY KEY (edition_id, card_id),
  KEY idx_edition_cards_card (card_id),
  CONSTRAINT fk_edition_cards_edition FOREIGN KEY (edition_id) REFERENCES editions (id) ON DELETE CASCADE,
  CONSTRAINT fk_edition_cards_card FOREIGN KEY (card_id) REFERENCES cards (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
