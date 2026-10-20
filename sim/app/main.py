import logging
import secrets
import time
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .odds import opening_odds
from .simulate import MAX_GAMES, UnknownStrategy, simulate
from .strategies import STRATEGIES

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("sim")

MAX_SEED = 2**32 - 1

app = FastAPI(title="Dominion simulation service")


class SimulateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    a: str = Field(min_length=1, max_length=64)
    b: str = Field(min_length=1, max_length=64)
    games: int = Field(ge=1, le=MAX_GAMES)
    seed: Optional[int] = Field(default=None, ge=0, le=MAX_SEED)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/strategies")
def strategies() -> dict:
    return {
        "strategies": [
            {"id": strategy_id, "name": name, "description": description}
            for strategy_id, (name, description, _rule) in STRATEGIES.items()
        ]
    }


@app.get("/odds/opening")
def odds() -> dict:
    return opening_odds()


@app.post("/simulate")
def run_simulation(request: SimulateRequest) -> dict:
    seed = request.seed if request.seed is not None else secrets.randbelow(MAX_SEED + 1)
    started = time.monotonic()
    try:
        result = simulate(request.a, request.b, request.games, seed)
    except UnknownStrategy as err:
        raise HTTPException(status_code=422, detail=f"unknown strategy: {err}") from err
    logger.info(
        "simulated a=%s b=%s games=%d seed=%d in %.2fs",
        request.a,
        request.b,
        request.games,
        seed,
        time.monotonic() - started,
    )
    return result
