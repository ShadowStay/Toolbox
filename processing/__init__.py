"""Server-side code behind the pages. Everything here registers routes on a blueprint; app.py registers them.
  /api/text/<action>        text-tools       (text.py)
  /api/image/...            image-tools      (image.py)
  /api/files/...            omni-file-viewer (files.py)
  /api/chat/...             live page room   (chat.py)       /api/board/...    drawing board   (board.py)
  /api/storage/...          cloud storage    (storage.py)
  /api/video/render         video-editor     (video.py)      /api/music/...    music library   (music.py)
  tabletop: roles.py  campaigns.py  characters.py  enemies.py  battlemap.py  rolls.py
Every route answers with JSON ({"error": "..."} on failure) or with the raw bytes of the result.
This file also holds what several modules share: the project paths and the secret key (data/secret.key)."""
import functools
import os
from pathlib import Path

from flask import Blueprint

from .errors import handle_errors

BASE = Path(__file__).parent.parent.resolve()
DATA = BASE / "data"
HASH_FILE = DATA / "password.hash"
KEY_FILE = DATA / "secret.key"


@functools.lru_cache(maxsize=1)
def _secret() -> str:
    """The key that signs cookies. Written to a temp file and linked into place, so a second process starting at the same
    moment can never read a half-written key. Read once, then kept in memory."""
    DATA.mkdir(exist_ok=True)
    if not KEY_FILE.exists():
        tmp = KEY_FILE.with_name(f"secret.{os.getpid()}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(os.urandom(32).hex())
        try:
            os.link(tmp, KEY_FILE)                 # fails if another process got there first: then theirs is used
        except FileExistsError:
            pass
        finally:
            tmp.unlink(missing_ok=True)
    return KEY_FILE.read_text().strip()


bp = Blueprint("processing", __name__, url_prefix="/api")
handle_errors(bp, "The server could not process that.")

# Imported last: each module registers its routes on bp (or on its own blueprint) and may import the names above.
from . import text, image, files, roles, campaigns, characters, enemies, battlemap, rolls   # noqa: F401,E402
from . import chat, board, storage, video, music   # noqa: F401,E402
