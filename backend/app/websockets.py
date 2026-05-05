"""
WebSocket endpoint for real-time preview updates.

The preview endpoint is intentionally anonymous — the public gallery needs to
render previews for non-logged-in visitors. Defenses are layered: per-IP
concurrent-connection cap, per-connection request rate limit, payload-size
cap on submitted YAML, and a render timeout. See `settings.WS_*`.
"""

import asyncio
import json
import logging
import time
from collections import defaultdict, deque
from typing import Any, Deque, Dict, Set

from fastapi import WebSocket, WebSocketDisconnect
from websockets.exceptions import ConnectionClosed

from .config import settings
from .core_services import PDFService, EinkPDFServiceError
from .models import WebSocketMessage

logger = logging.getLogger(__name__)

# Initialize PDF service for preview generation
pdf_service = PDFService()


def _ws_client_ip(websocket: WebSocket) -> str:
    """Resolve the real client IP for a WebSocket, honoring X-Forwarded-For."""
    forwarded = websocket.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    if websocket.client and websocket.client.host:
        return websocket.client.host
    return "unknown"


class ConnectionManager:
    """Manages WebSocket connections for real-time preview updates.

    Tracks open connections by client_id (1:1) and by IP (1:many) so that
    one abusive source can't open unlimited sockets.
    """

    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}
        self._connections_by_ip: Dict[str, Set[str]] = defaultdict(set)
        # Sliding-window timestamps of preview requests, keyed by client_id.
        self._request_history: Dict[str, Deque[float]] = defaultdict(deque)

    async def connect(self, websocket: WebSocket, client_id: str) -> bool:
        """Accept a WebSocket connection if the IP cap allows.

        Returns True on success, False if the connection was rejected.
        """
        ip = _ws_client_ip(websocket)
        if len(self._connections_by_ip[ip]) >= settings.WS_MAX_CONNECTIONS_PER_IP:
            logger.info(
                "Rejecting WebSocket connection from %s: per-IP cap reached (%d)",
                ip, settings.WS_MAX_CONNECTIONS_PER_IP,
            )
            await websocket.close(code=1013, reason="Too many connections from this IP")
            return False

        await websocket.accept()
        self.active_connections[client_id] = websocket
        self._connections_by_ip[ip].add(client_id)
        logger.info(
            "WebSocket client %s connected from %s (concurrent for IP: %d)",
            client_id, ip, len(self._connections_by_ip[ip]),
        )
        return True

    def disconnect(self, client_id: str) -> None:
        """Remove the connection from all tracking maps."""
        websocket = self.active_connections.pop(client_id, None)
        self._request_history.pop(client_id, None)
        if websocket is not None:
            ip = _ws_client_ip(websocket)
            self._connections_by_ip[ip].discard(client_id)
            if not self._connections_by_ip[ip]:
                del self._connections_by_ip[ip]
        logger.info("WebSocket client %s disconnected", client_id)

    def check_request_rate(self, client_id: str) -> bool:
        """Return True if the client may submit another preview request now.

        Sliding 60-second window; mutates the history on success so the call
        is the rate-limit decision *and* the recording of it.
        """
        history = self._request_history[client_id]
        now = time.monotonic()
        cutoff = now - 60.0
        while history and history[0] < cutoff:
            history.popleft()
        if len(history) >= settings.WS_PREVIEW_REQUESTS_PER_MINUTE:
            return False
        history.append(now)
        return True

    async def send_message(self, client_id: str, message: Dict[str, Any]) -> None:
        """Send message to specific client."""
        if client_id in self.active_connections:
            websocket = self.active_connections[client_id]
            try:
                await websocket.send_text(json.dumps(message))
            except ConnectionClosed:
                self.disconnect(client_id)

    async def send_error(self, client_id: str, error_message: str) -> None:
        """Send error message to client."""
        await self.send_message(client_id, {
            "type": "error",
            "data": {
                "message": error_message
            }
        })


# Global connection manager
connection_manager = ConnectionManager()


async def handle_websocket_connection(websocket: WebSocket, client_id: str) -> None:
    """
    Handle WebSocket connection for real-time preview updates.

    Args:
        websocket: WebSocket connection
        client_id: Unique client identifier
    """
    accepted = await connection_manager.connect(websocket, client_id)
    if not accepted:
        return

    try:
        while True:
            # Receive message from client
            try:
                data = await websocket.receive_text()
                message_data = json.loads(data)
            except json.JSONDecodeError:
                await connection_manager.send_error(client_id, "Invalid JSON message format")
                continue

            # Validate message structure
            if not isinstance(message_data, dict) or "type" not in message_data:
                await connection_manager.send_error(client_id, "Message must contain 'type' field")
                continue

            message_type = message_data.get("type")
            message_payload = message_data.get("data", {})

            if message_type == "preview_request":
                if not connection_manager.check_request_rate(client_id):
                    await connection_manager.send_error(
                        client_id,
                        f"Preview rate limit reached "
                        f"({settings.WS_PREVIEW_REQUESTS_PER_MINUTE}/minute). "
                        "Slow down and try again."
                    )
                    continue
                await handle_preview_request(client_id, message_payload)
            else:
                await connection_manager.send_error(client_id, f"Unknown message type: {message_type}")

    except WebSocketDisconnect:
        connection_manager.disconnect(client_id)
    except Exception as e:
        logger.error(f"WebSocket error for client {client_id}: {e}")
        await connection_manager.send_error(client_id, f"Server error: {str(e)}")
        connection_manager.disconnect(client_id)


async def handle_preview_request(client_id: str, payload: Dict[str, Any]) -> None:
    """
    Handle preview generation request.

    Args:
        client_id: Client identifier
        payload: Request payload containing template data
    """
    # Validate required fields
    required_fields = ["yaml_content", "profile"]
    for field in required_fields:
        if field not in payload:
            await connection_manager.send_error(client_id, f"Missing required field: {field}")
            return

    yaml_content = payload["yaml_content"]
    profile = payload["profile"]
    page_number = payload.get("page_number", 1)
    scale = payload.get("scale", 2.0)

    # Validate field types
    if not isinstance(yaml_content, str) or not yaml_content.strip():
        await connection_manager.send_error(client_id, "yaml_content must be a non-empty string")
        return

    # Cap the YAML size — anonymous renderers must not consume unbounded memory.
    yaml_bytes = len(yaml_content.encode("utf-8"))
    if yaml_bytes > settings.WS_MAX_YAML_BYTES:
        await connection_manager.send_error(
            client_id,
            f"yaml_content exceeds maximum size "
            f"({yaml_bytes} > {settings.WS_MAX_YAML_BYTES} bytes)"
        )
        return

    if not isinstance(profile, str) or not profile.strip():
        await connection_manager.send_error(client_id, "profile must be a non-empty string")
        return

    if not isinstance(page_number, int) or page_number < 1:
        await connection_manager.send_error(client_id, "page_number must be a positive integer")
        return

    if not isinstance(scale, (int, float)) or scale <= 0:
        await connection_manager.send_error(client_id, "scale must be a positive number")
        return

    try:
        # Generate preview, but bound the work — a malicious YAML could otherwise
        # tie up an event-loop thread indefinitely.
        loop = asyncio.get_running_loop()
        preview_bytes = await asyncio.wait_for(
            loop.run_in_executor(
                None,
                lambda: pdf_service.generate_preview(
                    yaml_content=yaml_content,
                    profile=profile,
                    page_number=page_number,
                    scale=scale,
                ),
            ),
            timeout=settings.WS_PREVIEW_TIMEOUT_SECONDS,
        )

        # Convert to base64 for JSON transmission
        import base64
        preview_base64 = base64.b64encode(preview_bytes).decode('utf-8')

        # Send response
        await connection_manager.send_message(client_id, {
            "type": "preview_response",
            "data": {
                "preview_base64": preview_base64,
                "page_number": page_number,
                "scale": scale,
                "size_bytes": len(preview_bytes)
            }
        })

    except asyncio.TimeoutError:
        logger.warning(
            "Preview generation timed out for client %s after %ds",
            client_id, settings.WS_PREVIEW_TIMEOUT_SECONDS,
        )
        await connection_manager.send_error(
            client_id,
            f"Preview generation exceeded {settings.WS_PREVIEW_TIMEOUT_SECONDS}s timeout"
        )
    except EinkPDFServiceError as e:
        await connection_manager.send_error(client_id, str(e))
    except Exception as e:
        logger.error(f"Preview generation error for client {client_id}: {e}")
        await connection_manager.send_error(client_id, f"Preview generation failed: {str(e)}")
