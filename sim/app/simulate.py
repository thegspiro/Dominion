"""Runs many games between two buy rules and summarises the outcome."""

from __future__ import annotations

import random
from typing import Optional

from .engine import play_game
from .strategies import STRATEGIES

MAX_GAMES = 5000


class UnknownStrategy(ValueError):
    pass


def _rule(strategy_id: str):
    if strategy_id not in STRATEGIES:
        raise UnknownStrategy(strategy_id)
    return STRATEGIES[strategy_id][2]


def _average(values: list[int]) -> Optional[float]:
    return sum(values) / len(values) if values else None


def simulate(a: str, b: str, games: int, seed: int) -> dict:
    """Plays `games` games. Seats alternate who goes first so neither side keeps the first-turn edge."""
    if not 1 <= games <= MAX_GAMES:
        raise ValueError(f"games must be between 1 and {MAX_GAMES}")
    rules = (_rule(a), _rule(b))
    master = random.Random(seed)
    wins = [0, 0]
    ties = 0
    rounds: list[int] = []
    reached: list[list[int]] = [[], []]
    for index in range(games):
        first = index % 2
        result = play_game(rules, random.Random(master.getrandbits(64)), first=first)
        if result.winner is None:
            ties += 1
        else:
            wins[result.winner] += 1
        rounds.append(max(result.turns))
        for seat in (0, 1):
            turn = result.reached_target_turn[seat]
            if turn is not None:
                reached[seat].append(turn)

    def side(seat: int, strategy_id: str) -> dict:
        return {
            "strategy": strategy_id,
            "wins": wins[seat],
            "win_rate": wins[seat] / games,
            "games_reaching_four_provinces": len(reached[seat]),
            "average_turn_to_four_provinces": _average(reached[seat]),
        }

    return {
        "games": games,
        "seed": seed,
        "a": side(0, a),
        "b": side(1, b),
        "ties": ties,
        "tie_rate": ties / games,
        "average_turns_per_player": _average(rounds),
    }
