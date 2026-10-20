from fractions import Fraction

from app.odds import TOTAL_HANDS, opening_odds


def test_total_hands_is_ten_choose_five():
    assert TOTAL_HANDS == 252


def test_first_hand_odds_are_exact():
    odds = opening_odds()
    by_coins = {hand["coins"]: hand["ways"] for hand in odds["hands"]}
    assert by_coins == {5: 21, 4: 105, 3: 105, 2: 21}
    assert all(hand["of"] == 252 for hand in odds["hands"])


def test_first_hand_odds_sum_to_one():
    odds = opening_odds()
    assert sum(Fraction(hand["ways"], hand["of"]) for hand in odds["hands"]) == 1


def test_splits_cover_every_deal():
    splits = {split["label"]: split["ways"] for split in opening_odds()["splits"]}
    assert splits == {"3/4": 210, "2/5": 42}
    assert sum(splits.values()) == 252


def test_percentages_match_counts():
    odds = opening_odds()
    for row in odds["hands"] + odds["splits"]:
        assert abs(row["percent"] - 100 * row["ways"] / row["of"]) < 1e-9
