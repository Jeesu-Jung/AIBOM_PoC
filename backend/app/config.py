import os
from dataclasses import dataclass
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
# Loaded in order; a variable already set (shell, CI, or an earlier file) always wins.
ENV_FILES = (BACKEND_DIR / ".env.local", BACKEND_DIR / ".env")


def _load_env_files() -> None:
    """Minimal KEY=VALUE loader so `uvicorn app.main:app` works without exporting variables first.

    Set AIBOM_SKIP_ENV_FILES=1 to disable (the test suite does, to keep settings deterministic).
    """
    if os.getenv("AIBOM_SKIP_ENV_FILES") == "1":
        return
    for path in ENV_FILES:
        if not path.is_file():
            continue
        for raw in path.read_text(encoding="utf-8-sig").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.removeprefix("export ").split("=", 1)
            key, value = key.strip(), value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            if key:
                os.environ.setdefault(key, value)


_load_env_files()


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
    openrouter_api_key: str = os.getenv("OPENROUTER_API_KEY", "")
    openrouter_model: str = os.getenv("OPENROUTER_MODEL", "anthropic/claude-opus-5")
    openrouter_base_url: str = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
    openrouter_http_referer: str = os.getenv("OPENROUTER_HTTP_REFERER", "http://localhost:5173")
    openrouter_timeout_seconds: float = float(os.getenv("OPENROUTER_TIMEOUT_SECONDS", "300"))


settings = Settings()
