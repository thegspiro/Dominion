"""Exact opening-hand odds for the standard starting deck (7 Copper, 3 Estate)."""

from math import comb

COPPERS = 7
ESTATES = 3
DECK_SIZE = COPPERS + ESTATES
HAND_SIZE = 5
TOTAL_HANDS = comb(DECK_SIZE, HAND_SIZE)


def opening_odds() -> dict:
    """Odds for the first five-card hand and for how the two opening hands split.

    The first hand holds c Coppers with probability C(7,c)*C(3,5-c)/C(10,5). The
    second hand is the other five cards, so it holds 7-c Coppers. Counts are
    returned as integers out of C(10,5) = 252 so no precision is lost.
    """
    ways = {
        coins: comb(COPPERS, coins) * comb(ESTATES, HAND_SIZE - coins)
        for coins in range(HAND_SIZE + 1)
        if 0 <= HAND_SIZE - coins <= ESTATES and coins <= COPPERS
    }
    hands = [
        {"coins": coins, "ways": count, "of": TOTAL_HANDS, "percent": 100 * count / TOTAL_HANDS}
        for coins, count in sorted(ways.items(), reverse=True)
    ]
    split_3_4 = ways.get(3, 0) + ways.get(4, 0)
    split_2_5 = ways.get(2, 0) + ways.get(5, 0)
    return {
        "hands": hands,
        "splits": [
            {"label": "3/4", "ways": split_3_4, "of": TOTAL_HANDS, "percent": 100 * split_3_4 / TOTAL_HANDS},
            {"label": "2/5", "ways": split_2_5, "of": TOTAL_HANDS, "percent": 100 * split_2_5 / TOTAL_HANDS},
        ],
    }
