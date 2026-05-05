"""
FastAPI dependencies for database services.

Provides dependency injection for auth services, database sessions, etc.
"""

import hashlib
import hmac
import logging
from typing import Generator, Optional, Tuple

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from .auth_service import (
    DBAuthService,
    DBPasswordResetService,
    UserNotFoundError,
)
from .models import User
from . import get_db
from ..config import settings
from ..models import TokenPayload

logger = logging.getLogger(__name__)

# OAuth2 scheme for token extraction
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


# ---- Admin impersonation cookie ----
#
# The cookie carries `{admin_id}|{user_id}|{hmac_hex}` where the HMAC is over
# `{admin_id}|{user_id}` keyed with JWT_SECRET_KEY. Without the signature an
# XSS payload could read the JWT and forge an impersonation cookie naming any
# user as the target. With it, the attacker also needs the secret.

IMPERSONATE_COOKIE_NAME = "admin_impersonate"


def sign_impersonation_cookie(admin_id: str, user_id: str) -> str:
    """Produce the cookie value `{admin_id}|{user_id}|{hmac_hex}`.

    User IDs are 32-char hex tokens (no `|`), so the format is unambiguous.
    """
    payload = f"{admin_id}|{user_id}"
    sig = hmac.new(
        settings.JWT_SECRET_KEY.encode("utf-8"),
        payload.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"{payload}|{sig}"


def verify_impersonation_cookie(cookie_value: str) -> Optional[Tuple[str, str]]:
    """Return `(admin_id, user_id)` if the cookie is well-formed and signed.

    Returns None on any malformedness or signature mismatch — callers must
    treat that as "no impersonation in effect".
    """
    parts = cookie_value.rsplit("|", 1)
    if len(parts) != 2:
        return None
    payload, given_sig = parts
    expected_sig = hmac.new(
        settings.JWT_SECRET_KEY.encode("utf-8"),
        payload.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(given_sig, expected_sig):
        return None
    payload_parts = payload.split("|")
    if len(payload_parts) != 2:
        return None
    admin_id, user_id = payload_parts
    if not admin_id or not user_id:
        return None
    return admin_id, user_id


def get_auth_service(db: Session = Depends(get_db)) -> DBAuthService:
    """
    Dependency to get database-backed auth service.

    Usage:
        @app.post("/register")
        def register(auth: DBAuthService = Depends(get_auth_service)):
            user = auth.register_user(...)
    """
    return DBAuthService(db)


def get_password_reset_service(
    db: Session = Depends(get_db),
    auth_service: DBAuthService = Depends(get_auth_service)
) -> DBPasswordResetService:
    """Dependency to get password reset service."""
    return DBPasswordResetService(db, auth_service)


def get_current_user(
    request: Request,
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db)
) -> User:
    """
    Dependency to get current authenticated user from JWT token.

    Supports admin impersonation via admin_impersonate cookie.

    Raises:
        HTTPException 401: If token is invalid or user not found
        HTTPException 403: If user is inactive

    Usage:
        @app.get("/me")
        def get_profile(user: User = Depends(get_current_user)):
            return {"username": user.username}
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )

    try:
        # Decode JWT token
        payload = jwt.decode(
            token,
            settings.JWT_SECRET_KEY,
            algorithms=[settings.JWT_ALGORITHM]
        )
        user_id: str = payload.get("sub")
        if user_id is None:
            raise credentials_exception

    except JWTError:
        raise credentials_exception

    # Get user from database
    auth_service = DBAuthService(db)
    try:
        user = auth_service.get_user_by_id(user_id)
    except UserNotFoundError:
        raise credentials_exception

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account is inactive"
        )

    # Check for admin impersonation. Cookie is HMAC-signed (see
    # sign_impersonation_cookie); a valid signature plus the JWT-authenticated
    # user being the named admin are both required.
    impersonate_cookie = request.cookies.get(IMPERSONATE_COOKIE_NAME)
    if impersonate_cookie and user.is_admin:
        verified = verify_impersonation_cookie(impersonate_cookie)
        if verified is None:
            logger.warning("Rejected impersonation cookie: bad signature or format")
        else:
            admin_id, impersonated_user_id = verified
            if admin_id == user.id:
                try:
                    impersonated_user = auth_service.get_user_by_id(impersonated_user_id)
                except UserNotFoundError:
                    logger.warning(
                        "Impersonation cookie names unknown user '%s'",
                        impersonated_user_id,
                    )
                else:
                    logger.info(
                        "Admin '%s' impersonating user '%s'",
                        user.username, impersonated_user.username
                    )
                    return impersonated_user

    return user


def get_current_active_user(
    current_user: User = Depends(get_current_user),
) -> User:
    """
    Dependency to get current active user.

    This is a convenience wrapper around get_current_user
    that explicitly checks is_active (though get_current_user already does this).
    """
    if not current_user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Inactive user"
        )
    return current_user


def get_current_admin_user(
    current_user: User = Depends(get_current_user),
) -> User:
    """
    Dependency to get current admin user.

    Raises:
        HTTPException 403: If user is not an admin

    Usage:
        @app.get("/admin/users")
        def list_users(admin: User = Depends(get_current_admin_user)):
            return get_all_users()
    """
    if not current_user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required"
        )
    return current_user
