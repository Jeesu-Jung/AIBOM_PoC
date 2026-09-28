import os

# Keep settings deterministic: never read the developer's backend/.env.local during tests.
os.environ["AIBOM_SKIP_ENV_FILES"] = "1"
