from flask import Blueprint, Response, jsonify
from werkzeug.exceptions import HTTPException

bp = Blueprint("processing", __name__, url_prefix="/api")


class Fail(Exception):
    """An error whose message is meant for the person using the page."""


def send_bytes(data: bytes, mimetype: str) -> Response:
    return Response(data, mimetype=mimetype, headers={"Cache-Control": "no-store"})


@bp.errorhandler(Fail)
def _fail(e):
    return jsonify(error=str(e)), 400


@bp.errorhandler(HTTPException)
def _http(e):
    return jsonify(error=e.description), e.code


@bp.errorhandler(Exception)
def _boom(e):
    return jsonify(error=f"The server could not process that: {e}"), 500
