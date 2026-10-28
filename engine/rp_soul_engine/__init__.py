"""rp-soul engine: the "living person" core (Python, stdlib only).

Ported from adult-tension's mechanism layer. The world/content pack is gone:
everything that used to come from a world pack now comes from an rp-soul
persona pack (markdown + optional front matter).
"""

ENGINE_VERSION = "0.1.0"
DB_SCHEMA_VERSION = 4  # 4: rules read the clock (migrate.state_v3_to_v4)
STATE_SCHEMA_VERSION = 4  # 4: rules read the clock; 3: memory in four layers; 2: one companion
RNG_VERSION = 1
SAVE_FORMAT = "rp-soul-save"
MIN_PYTHON = (3, 10)
MIN_SQLITE = (3, 22, 0)
