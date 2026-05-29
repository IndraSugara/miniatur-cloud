"""Bilingual structured error responses.

Every error returned by the API follows:
    {"error": {"code": "QUOTA_EXCEEDED", "message": "Kuota instance habis (3 max)"}}

The ``code`` field is a stable, English, machine-readable identifier.
The ``message`` field is a human-readable description (Indonesian by default).
"""

from __future__ import annotations

from fastapi import HTTPException
from fastapi.responses import JSONResponse


class IaaSError(HTTPException):
    """HTTPException subclass that carries a structured error body."""

    def __init__(self, status_code: int, code: str, message: str):
        self.error_code = code
        self.error_message = message
        super().__init__(
            status_code=status_code,
            detail={"code": code, "message": message},
        )


def raise_error(status_code: int, code: str, message: str):
    """Raise a structured IaaS error.

    Parameters
    ----------
    status_code : int
        HTTP status code (e.g. 400, 404, 409, 429).
    code : str
        Machine-readable English error code (e.g. "QUOTA_EXCEEDED").
    message : str
        Human-readable detail (Indonesian).
    """
    raise IaaSError(status_code, code, message)


# ── Common error helpers ──────────────────────────────────────

def not_found(resource: str = "Resource"):
    raise_error(404, "NOT_FOUND", f"{resource} tidak ditemukan")


def forbidden():
    raise_error(403, "FORBIDDEN", "Bukan milikmu")


def admin_only():
    raise_error(403, "ADMIN_ONLY", "Hanya admin yang bisa akses")


def quota_exceeded(current: int, maximum: int):
    raise_error(429, "QUOTA_EXCEEDED", f"Kuota habis ({current}/{maximum} max)")


def conflict(message: str):
    raise_error(409, "CONFLICT", message)


def bad_request(message: str):
    raise_error(400, "BAD_REQUEST", message)


def rate_limited():
    raise_error(429, "RATE_LIMITED", "Terlalu banyak percobaan. Coba lagi nanti.")


def invalid_credentials():
    raise_error(401, "INVALID_CREDENTIALS", "Username atau password salah")


def invalid_token():
    raise_error(401, "INVALID_TOKEN", "Token tidak valid")


def not_ready(resource: str = "Resource"):
    raise_error(400, "NOT_READY", f"{resource} belum siap")


def already_exists(resource: str = "Resource"):
    raise_error(409, "ALREADY_EXISTS", f"{resource} sudah ada")


def still_in_use(resource: str = "Resource"):
    raise_error(409, "STILL_IN_USE", f"{resource} masih dipakai")


def service_error(service: str, detail: str):
    raise_error(502, "SERVICE_ERROR", f"{service} error: {detail}")
