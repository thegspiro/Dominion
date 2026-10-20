"""Buy rules for the simulator.

These thresholds are this app's own definitions of "Big Money" and "Big Money
with Smithy". They are reasonable and easy to read, not a published or
optimised standard, so results describe these rules only.
"""

from __future__ import annotations

from typing import Optional

from .engine import BuyContext, BuyRule

SMITHY_MIN_PROVINCES_LEFT = 5
SECOND_SMITHY_MIN_DECK = 16


def big_money(context: BuyContext) -> Optional[str]:
    coins = context.coins
    provinces_left = context.provinces_left
    if coins >= 8:
        return "province"
    if coins >= 6:
        return "duchy" if provinces_left <= 3 else "gold"
    if coins == 5:
        return "duchy" if provinces_left <= 5 else "silver"
    if coins >= 3:
        return "estate" if provinces_left <= 2 else "silver"
    if coins == 2 and provinces_left <= 2:
        return "estate"
    return None


def big_money_smithy(context: BuyContext) -> Optional[str]:
    if context.coins in (4, 5) and context.provinces_left >= SMITHY_MIN_PROVINCES_LEFT and context.supply["smithy"] > 0:
        smithies = context.owned.get("smithy", 0)
        if smithies == 0 or (smithies == 1 and context.deck_size >= SECOND_SMITHY_MIN_DECK):
            return "smithy"
    return big_money(context)


STRATEGIES: dict[str, tuple[str, str, BuyRule]] = {
    "big_money": (
        "Big Money",
        "Buys Province at $8, Gold at $6-7, Silver at $3-5. Takes Duchy and Estate only near the end.",
        big_money,
    ),
    "big_money_smithy": (
        "Big Money with Smithy",
        "Big Money, plus one Smithy at $4-5 early, and a second once the deck holds 16 or more cards.",
        big_money_smithy,
    ),
}
