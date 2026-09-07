"""
ArticulAIT — API Logging Middleware
Intercepts HTTP requests and logs API endpoint, HTTP method, [req_id], status code, execution duration, and client details.
"""
import time
import uuid
# pyrefly: ignore [missing-import]
from starlette.middleware.base import BaseHTTPMiddleware
# pyrefly: ignore [missing-import]
from fastapi import Request, Response
from backend.core.logger import logger


class APILoggingMiddleware(BaseHTTPMiddleware):
    """
    Middleware for logging incoming API requests:
    - Assigns or reads [req_id] (request ID)
    - Records target endpoint ('where we are hitting')
    - Records HTTP method & status code
    - Records execution duration
    - Sets X-Request-ID response header
    """

    async def dispatch(self, request: Request, call_next) -> Response:
        req_id = request.headers.get("X-Request-ID") or f"req-{uuid.uuid4().hex[:8]}"
        request.state.req_id = req_id

        start_time = time.perf_counter()
        method = request.method
        url_path = request.url.path
        client_ip = request.client.host if request.client else "unknown"

        try:
            response = await call_next(request)
            process_time = round((time.perf_counter() - start_time) * 1000, 2)
            status_code = response.status_code

            log_msg = (
                f"[{req_id}] API: {url_path} | Method: {method} | "
                f"Status: {status_code} | Time: {process_time}ms | Client: {client_ip}"
            )

            if status_code >= 500:
                logger.error(log_msg)
            elif status_code >= 400:
                logger.warning(log_msg)
            else:
                logger.info(log_msg)

            response.headers["X-Request-ID"] = req_id
            return response

        except Exception as exc:
            process_time = round((time.perf_counter() - start_time) * 1000, 2)
            log_msg = (
                f"[{req_id}] API: {url_path} | Method: {method} | "
                f"Status: 500 | Time: {process_time}ms | Client: {client_ip} | Error: {str(exc)}"
            )
            logger.error(log_msg, exc_info=True)
            raise exc
