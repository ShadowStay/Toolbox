"""Errors shared by every API blueprint. Raise Fail("message") for a mistake the person can fix (answered with 400 and
the message); anything unexpected is logged on the server and answered with a plain 500, so file paths and library
messages never reach the browser."""
from flask import current_app, jsonify
from werkzeug.exceptions import HTTPException


class Fail(Exception):
    """An error whose message is meant for the person using the page."""


def handle_errors(bp, fallback="The server could not do that."):
    @bp.errorhandler(Fail)
    def _fail(e):
        return jsonify(error=str(e)), 400

    @bp.errorhandler(HTTPException)
    def _http(e):
        return jsonify(error=e.description), e.code

    @bp.errorhandler(Exception)
    def _boom(e):
        current_app.logger.exception("Unhandled error in %s", bp.name)
        return jsonify(error=fallback), 500
