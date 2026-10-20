"""A minimal two-player Dominion race used to compare buy rules.

Only the cards named in CARDS exist here. Smithy is the only action: it draws
three cards and is terminal (one action per turn). Every other rule follows the
base game: five-card hands, reshuffle when the deck runs out, buys limited by
coins, and the game ends at the end of the turn in which the Province pile is
empty or three piles are empty. The player with more victory points wins; on a
tie the player with fewer turns wins, and equal turns share the win.
"""

from __future__ import annotations

import random
from collections import Counter
from dataclasses import dataclass, field
from typing import Callable, Optional

COST = {"copper": 0, "silver": 3, "gold": 6, "estate": 2, "duchy": 5, "province": 8, "smithy": 4}
COINS = {"copper": 1, "silver": 2, "gold": 3}
VICTORY_POINTS = {"estate": 1, "duchy": 3, "province": 6}
CARDS = tuple(COST)
HAND_SIZE = 5
SMITHY_DRAW = 3
STARTING_COPPER = 7
STARTING_ESTATE = 3
EMPTY_PILES_TO_END = 3
PROVINCE_TARGET = 4
MAX_TURNS_PER_PLAYER = 200


def starting_supply() -> dict[str, int]:
    """Two-player supply after each player has taken their starting cards."""
    return {
        "copper": 60 - 2 * STARTING_COPPER,
        "silver": 40,
        "gold": 30,
        "estate": 8,
        "duchy": 8,
        "province": 8,
        "smithy": 10,
    }


@dataclass
class BuyContext:
    """What a buy rule may look at. Counts are copies, so a rule cannot change the game."""

    coins: int
    buys: int
    supply: dict[str, int]
    owned: dict[str, int]
    deck_size: int
    provinces_left: int


BuyRule = Callable[[BuyContext], Optional[str]]


@dataclass
class Player:
    rule: BuyRule
    rng: random.Random
    deck: list[str] = field(default_factory=list)
    discard: list[str] = field(default_factory=list)
    hand: list[str] = field(default_factory=list)
    turns: int = 0
    reached_target_turn: Optional[int] = None

    def owned(self) -> Counter:
        return Counter(self.deck) + Counter(self.discard) + Counter(self.hand)

    def draw(self, count: int) -> None:
        for _ in range(count):
            if not self.deck:
                if not self.discard:
                    return
                self.deck, self.discard = self.discard, []
                self.rng.shuffle(self.deck)
            self.hand.append(self.deck.pop())

    def victory_points(self) -> int:
        owned = self.owned()
        return sum(owned[name] * points for name, points in VICTORY_POINTS.items())


@dataclass
class GameResult:
    winner: Optional[int]
    points: tuple[int, int]
    turns: tuple[int, int]
    reached_target_turn: tuple[Optional[int], Optional[int]]


def _new_player(rule: BuyRule, rng: random.Random) -> Player:
    player = Player(rule=rule, rng=rng)
    player.deck = ["copper"] * STARTING_COPPER + ["estate"] * STARTING_ESTATE
    rng.shuffle(player.deck)
    player.draw(HAND_SIZE)
    return player


def _play_turn(player: Player, supply: dict[str, int]) -> None:
    player.turns += 1
    played: list[str] = []
    if "smithy" in player.hand:
        player.hand.remove("smithy")
        played.append("smithy")
        player.draw(SMITHY_DRAW)

    coins = sum(COINS.get(card, 0) for card in player.hand)
    owned = player.owned()
    owned.update(played)
    context = BuyContext(
        coins=coins,
        buys=1,
        supply=dict(supply),
        owned=dict(owned),
        deck_size=sum(owned.values()),
        provinces_left=supply["province"],
    )
    choice = player.rule(context)
    if choice is not None:
        if choice not in COST:
            raise ValueError(f"unknown card {choice!r}")
        if COST[choice] > coins:
            raise ValueError(f"cannot afford {choice} with {coins}")
        if supply[choice] > 0:
            supply[choice] -= 1
            player.discard.append(choice)

    player.discard.extend(player.hand)
    player.discard.extend(played)
    player.hand = []
    player.draw(HAND_SIZE)

    if player.reached_target_turn is None and player.owned()["province"] >= PROVINCE_TARGET:
        player.reached_target_turn = player.turns


def _game_over(supply: dict[str, int]) -> bool:
    empty = sum(1 for count in supply.values() if count == 0)
    return supply["province"] == 0 or empty >= EMPTY_PILES_TO_END


def play_game(rules: tuple[BuyRule, BuyRule], rng: random.Random, first: int = 0) -> GameResult:
    """Plays one game. `first` is the seat (0 or 1) that takes the first turn."""
    if first not in (0, 1):
        raise ValueError("first must be 0 or 1")
    players = (_new_player(rules[0], random.Random(rng.getrandbits(64))), _new_player(rules[1], random.Random(rng.getrandbits(64))))
    supply = starting_supply()
    seat = first
    while not _game_over(supply):
        if players[seat].turns >= MAX_TURNS_PER_PLAYER:
            raise RuntimeError("game did not end")
        _play_turn(players[seat], supply)
        seat = 1 - seat

    points = (players[0].victory_points(), players[1].victory_points())
    turns = (players[0].turns, players[1].turns)
    winner: Optional[int]
    if points[0] != points[1]:
        winner = 0 if points[0] > points[1] else 1
    elif turns[0] != turns[1]:
        winner = 0 if turns[0] < turns[1] else 1
    else:
        winner = None
    return GameResult(
        winner=winner,
        points=points,
        turns=turns,
        reached_target_turn=(players[0].reached_target_turn, players[1].reached_target_turn),
    )
