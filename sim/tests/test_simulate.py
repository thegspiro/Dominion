import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.simulate import MAX_GAMES, UnknownStrategy, simulate

client = TestClient(app)


def test_same_seed_gives_same_result():
    assert simulate("big_money", "big_money_smithy", 200, 5) == simulate("big_money", "big_money_smithy", 200, 5)


def test_counts_add_up():
    result = simulate("big_money", "big_money_smithy", 300, 9)
    assert result["a"]["wins"] + result["b"]["wins"] + result["ties"] == 300
    assert result["a"]["win_rate"] + result["b"]["win_rate"] + result["tie_rate"] == pytest.approx(1)


def test_identical_strategies_are_roughly_even():
    result = simulate("big_money", "big_money", 1500, 11)
    assert abs(result["a"]["win_rate"] - result["b"]["win_rate"]) < 0.08


def test_smithy_beats_plain_big_money():
    result = simulate("big_money_smithy", "big_money", 1500, 11)
    assert result["a"]["win_rate"] > result["b"]["win_rate"] + 0.2
    assert result["a"]["average_turn_to_four_provinces"] < result["b"]["average_turn_to_four_provinces"]


def test_game_count_limits():
    with pytest.raises(ValueError):
        simulate("big_money", "big_money", 0, 1)
    with pytest.raises(ValueError):
        simulate("big_money", "big_money", MAX_GAMES + 1, 1)


def test_unknown_strategy_is_rejected():
    with pytest.raises(UnknownStrategy):
        simulate("witch_rush", "big_money", 10, 1)


def test_strategies_endpoint():
    body = client.get("/strategies").json()
    assert [s["id"] for s in body["strategies"]] == ["big_money", "big_money_smithy"]
    assert all(s["name"] and s["description"] for s in body["strategies"])


def test_odds_endpoint():
    body = client.get("/odds/opening").json()
    assert {h["coins"] for h in body["hands"]} == {2, 3, 4, 5}


def test_simulate_endpoint_returns_the_seed_used():
    response = client.post("/simulate", json={"a": "big_money", "b": "big_money_smithy", "games": 20, "seed": 3})
    assert response.status_code == 200
    assert response.json()["seed"] == 3
    again = client.post("/simulate", json={"a": "big_money", "b": "big_money_smithy", "games": 20, "seed": 3})
    assert again.json() == response.json()


def test_simulate_endpoint_picks_a_seed_when_none_given():
    response = client.post("/simulate", json={"a": "big_money", "b": "big_money", "games": 5})
    assert response.status_code == 200
    assert isinstance(response.json()["seed"], int)


@pytest.mark.parametrize(
    "payload",
    [
        {"a": "big_money", "b": "big_money", "games": 0},
        {"a": "big_money", "b": "big_money", "games": MAX_GAMES + 1},
        {"a": "big_money", "b": "big_money", "games": 5, "seed": -1},
        {"a": "big_money", "b": "big_money", "games": 5, "extra": 1},
        {"a": "big_money", "games": 5},
        {"a": "", "b": "big_money", "games": 5},
    ],
)
def test_simulate_endpoint_validates_input(payload):
    assert client.post("/simulate", json=payload).status_code == 422


def test_unknown_strategy_is_422():
    response = client.post("/simulate", json={"a": "witch_rush", "b": "big_money", "games": 5})
    assert response.status_code == 422
