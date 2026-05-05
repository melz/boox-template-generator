"""Email delivery service.

Extracted from the legacy ``backend/app/auth.py`` so the active code path can
import it directly without dragging in the rest of the file-based auth stack.

Configuration is read from ``EINK_SMTP_*`` and ``EINK_EMAIL_OUTPUT_DIR`` env
vars, matching what the docker-compose deployment already sets. SMTP delivery
takes priority; falling back to writing each message to a file is useful for
local dev where you want to inspect the email body without sending.
"""

from __future__ import annotations

import os
import smtplib
import ssl
from datetime import datetime, timezone
from email.message import EmailMessage
from pathlib import Path
from typing import Optional

from pydantic import EmailStr


class EmailServiceError(Exception):
    """Raised when email delivery cannot be completed."""


class EmailService:
    """Simple SMTP or file-backed email delivery service."""

    def __init__(
        self,
        smtp_host: Optional[str] = None,
        smtp_port: Optional[int] = None,
        smtp_username: Optional[str] = None,
        smtp_password: Optional[str] = None,
        from_address: Optional[str] = None,
        use_tls: Optional[bool] = None,
        output_dir: Optional[Path] = None,
    ) -> None:
        self.smtp_host = smtp_host or os.getenv("EINK_SMTP_HOST")
        port_env = os.getenv("EINK_SMTP_PORT")
        self.smtp_port = smtp_port or (int(port_env) if port_env else 587)
        self.smtp_username = smtp_username or os.getenv("EINK_SMTP_USERNAME")
        self.smtp_password = smtp_password or os.getenv("EINK_SMTP_PASSWORD")
        self.from_address = from_address or os.getenv("EINK_SMTP_FROM")
        use_tls_env = os.getenv("EINK_SMTP_USE_TLS", "true").lower()
        self.use_tls = use_tls if use_tls is not None else use_tls_env not in {"0", "false", "no"}
        dir_env = os.getenv("EINK_EMAIL_OUTPUT_DIR")
        self.output_dir = Path(output_dir) if output_dir else (Path(dir_env) if dir_env else None)
        if self.output_dir is not None:
            self.output_dir.mkdir(parents=True, exist_ok=True)

    def _build_message(self, to_address: EmailStr, subject: str, body: str) -> EmailMessage:
        message = EmailMessage()
        message["To"] = to_address
        if self.from_address:
            message["From"] = self.from_address
        message["Subject"] = subject
        message.set_content(body)
        return message

    def _deliver_via_smtp(self, message: EmailMessage) -> None:
        if not self.smtp_host or not self.from_address:
            raise EmailServiceError("SMTP configuration incomplete; set EINK_SMTP_* variables")
        context = ssl.create_default_context()
        try:
            with smtplib.SMTP(self.smtp_host, self.smtp_port, timeout=10) as server:
                if self.use_tls:
                    server.starttls(context=context)
                if self.smtp_username and self.smtp_password:
                    server.login(self.smtp_username, self.smtp_password)
                server.send_message(message)
        except (smtplib.SMTPException, OSError) as exc:
            raise EmailServiceError(f"SMTP delivery failed: {exc}") from exc

    def _deliver_to_file(self, message: EmailMessage) -> None:
        if self.output_dir is None:
            raise EmailServiceError("Email output directory is not configured")
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        slug = message["To"].replace("@", "_at_").replace("/", "_")
        target = self.output_dir / f"{timestamp}_{slug}.eml"
        target.write_text(message.as_string())

    def send_password_reset_email(self, to_address: EmailStr, reset_link: str, expires_at: datetime) -> None:
        if expires_at.tzinfo is None:
            raise EmailServiceError("expires_at must be timezone-aware")
        subject = "Reset your E-ink PDF account password"
        body = (
            "Hello,\n\n"
            "We received a request to reset the password for your E-ink PDF Templates account.\n"
            "If you made this request, click the link below to set a new password:\n\n"
            f"{reset_link}\n\n"
            f"This link will expire at {expires_at.isoformat()}.\n\n"
            "If you did not request a password reset, you can safely ignore this email."
        )
        message = self._build_message(to_address, subject, body)
        if self.smtp_host:
            self._deliver_via_smtp(message)
            return
        if self.output_dir is not None:
            self._deliver_to_file(message)
            return
        raise EmailServiceError(
            "Email delivery is not configured. Set SMTP variables or EINK_EMAIL_OUTPUT_DIR."
        )
