"""rp-soul engine: the "living person" core (Python, stdlib only).

Ported from adult-tension's mechanism layer. The world/content pack is gone:
everything that used to come from a world pack now comes from an rp-soul
persona pack (markdown + optional front matter).
"""

ENGINE_VERSION = "0.1.0"
DB_SCHEMA_VERSION = 1
STATE_SCHEMA_VERSION = 1
RNG_VERSION = 1
SAVE_FORMAT = "rp-soul-save"
MIN_PYTHON = (3, 10)
MIN_SQLITE = (3, 22, 0)
