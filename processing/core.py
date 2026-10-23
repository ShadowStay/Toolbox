from flask import Blueprint, Response

from errors import Fail, handle_errors   # noqa: F401  (Fail is imported from here by the other modules)

bp = Blueprint("processing", __name__, url_prefix="/api")
handle_errors(bp, "The server could not process that.")


def send_bytes(data: bytes, mimetype: str) -> Response:
    return Response(data, mimetype=mimetype, headers={"Cache-Control": "no-store"})
