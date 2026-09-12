import os
from dataclasses import dataclass


def _origins() -> tuple[str, ...]:
    value = os.getenv(
        "CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    )
    return tuple(origin.strip() for origin in value.split(",") if origin.strip())


@dataclass(frozen=True)
class Settings:
    database_url: str = os.getenv(
        "DATABASE_URL",
        "mysql+pymysql://aibom_user:change-me@127.0.0.1:3306/aibom?charset=utf8mb4",
    )
    cors_origins: tuple[str, ...] = _origins()


settings = Settings()
