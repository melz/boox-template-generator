"""Per-IP rate limiter wired into FastAPI via slowapi.

Lives at module scope so routers can decorate handlers with `@limiter.limit(...)`.
Rate limits are read from `settings` so they can be tuned per environment.

Behind a reverse proxy (production at eink.cgpsmapper.com), the upstream IP
arrives in `X-Forwarded-For`. The proxy is trusted to overwrite that header,
so we read it directly. Behind nothing — falls back to `request.client.host`.
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import Request
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from starlette.responses import JSONResponse

from .config import settings

logger = logging.getLogger(__name__)


def _client_ip(request: Request) -> str:
    """Resolve the real client IP, honoring X-Forwarded-For if present."""
    forwarded: Optional[str] = request.headers.get("x-forwarded-for")
    if forwarded:
        # Take the leftmost address (the original client). The proxy is
        # responsible for replacing any client-supplied value.
        return forwarded.split(",")[0].strip()
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


# `enabled=...` is honored at request time; flipping RATE_LIMIT_ENABLED off
# bypasses the limiter without removing the decorators.
#
# We deliberately don't set `default_limits` — a blanket limit on every route
# trips on normal page loads (project list + profiles + me + ... in one
# navigation). Each route that needs protection is decorated explicitly.
limiter = Limiter(
    key_func=_client_ip,
    enabled=settings.RATE_LIMIT_ENABLED,
    headers_enabled=True,
)


def rate_limit_exceeded_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    """Return 429 with a clear JSON body when a limit is hit."""
    logger.info(
        "Rate limit exceeded for %s on %s %s",
        _client_ip(request), request.method, request.url.path,
    )
    return JSONResponse(
        status_code=429,
        content={
            "error": "RATE_LIMITED",
            "message": "Too many requests. Please slow down and try again shortly.",
        },
    )
