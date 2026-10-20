import random

import pytest

from app.engine import COST, PROVINCE_TARGET, BuyContext, play_game, starting_supply
from app.strategies import STRATEGIES, big_money, big_money_smithy


def context(coins, provinces_left=8, smithies=0, deck_size=10, smithy_pile=10):
    supply = starting_supply()
    supply["province"] = provinces_left
    supply["smithy"] = smithy_pile
    return BuyContext(coins=coins, buys=1, supply=supply, owned={"smithy": smithies}, deck_size=deck_size, provinces_left=provinces_left)


def test_starting_supply_matches_two_player_rules():
    supply = starting_supply()
    assert supply["copper"] == 46
    assert (supply["estate"], supply["duchy"], supply["province"]) == (8, 8, 8)
    assert (supply["silver"], supply["gold"], supply["smithy"]) == (40, 30, 10)


@pytest.mark.parametrize(
    "coins,provinces_left,expected",
    [
        (8, 8, "province"),
        (11, 8, "province"),
        (7, 8, "gold"),
        (6, 8, "gold"),
        (6, 3, "duchy"),
        (5, 8, "silver"),
        (5, 5, "duchy"),
        (4, 8, "silver"),
        (3, 8, "silver"),
        (3, 2, "estate"),
        (2, 8, None),
        (2, 2, "estate"),
        (0, 8, None),
    ],
)
def test_big_money_choices(coins, provinces_left, expected):
    assert big_money(context(coins, provinces_left)) == expected


def test_smithy_bot_buys_first_smithy_at_four_or_five():
    assert big_money_smithy(context(4)) == "smithy"
    assert big_money_smithy(context(5)) == "smithy"
    assert big_money_smithy(context(3)) == "silver"


def test_smithy_bot_waits_for_a_bigger_deck_before_a_second():
    assert big_money_smithy(context(4, smithies=1, deck_size=12)) == "silver"
    assert big_money_smithy(context(4, smithies=1, deck_size=16)) == "smithy"
    assert big_money_smithy(context(4, smithies=2, deck_size=30)) == "silver"


def test_smithy_bot_stops_buying_smithy_late_and_when_pile_is_empty():
    assert big_money_smithy(context(5, provinces_left=4)) == "duchy"
    assert big_money_smithy(context(4, smithy_pile=0)) == "silver"


def test_strategy_rules_never_ask_for_something_unaffordable():
    for coins in range(0, 14):
        for provinces_left in range(0, 9):
            for rule in (big_money, big_money_smithy):
                choice = rule(context(coins, provinces_left))
                assert choice is None or COST[choice] <= coins


def test_game_is_deterministic_for_a_seed():
    rules = (big_money, big_money_smithy)
    first = play_game(rules, random.Random(7))
    second = play_game(rules, random.Random(7))
    assert first == second


def test_game_ends_by_province_pile_or_three_piles():
    for seed in range(40):
        result = play_game((big_money, big_money), random.Random(seed), first=seed % 2)
        assert sum(result.points) > 0
        assert abs(result.turns[0] - result.turns[1]) <= 1


def test_winner_matches_points_and_tie_break():
    for seed in range(200):
        result = play_game((big_money, big_money), random.Random(seed), first=seed % 2)
        if result.points[0] != result.points[1]:
            assert result.winner == (0 if result.points[0] > result.points[1] else 1)
        elif result.turns[0] != result.turns[1]:
            assert result.winner == (0 if result.turns[0] < result.turns[1] else 1)
        else:
            assert result.winner is None


def test_four_province_turn_is_recorded_only_when_reached():
    for seed in range(60):
        result = play_game((big_money, big_money), random.Random(seed))
        for seat in (0, 1):
            turn = result.reached_target_turn[seat]
            if turn is not None:
                assert 1 <= turn <= result.turns[seat]
                assert result.points[seat] >= 6 * PROVINCE_TARGET


def test_unaffordable_choice_is_rejected():
    def greedy(_context):
        return "province"

    with pytest.raises(ValueError):
        play_game((greedy, big_money), random.Random(1))


def test_unknown_card_is_rejected():
    def odd(_context):
        return "witch"

    with pytest.raises(ValueError):
        play_game((odd, big_money), random.Random(1))


def test_first_must_be_a_seat():
    with pytest.raises(ValueError):
        play_game((big_money, big_money), random.Random(1), first=2)


def test_registry_has_both_strategies():
    assert set(STRATEGIES) == {"big_money", "big_money_smithy"}
