"""Server-side processing for the tools. The pages use these routes when the "On the server" option is chosen.
  /api/text/<action>        text-tools      (text.py)
  /api/image/...            image-tools     (image.py)
  /api/files/...            omni-file-viewer (files.py)
Every route answers with JSON ({"error": "..."} on failure) or with the raw bytes of the result."""
from .core import bp          # noqa: F401  (imported first so the modules below can register routes on it)
from . import text, image, files, characters   # noqa: F401,E402
