"""Observability — structured logging via structlog."""
import structlog

log = structlog.get_logger()


def log_login_attempt(email: str, ok: bool) -> None:
    log.info("auth.login_attempt", email=email, ok=ok)


def delete_all_users(db) -> int:
    """DELIBERATE DEFECT for monitoring-audit:
    This is a destructive admin action but emits NO structured-log
    event before / after. The audit must flag the missing log.
    """
    count = db.execute("delete from users").rowcount
    db.commit()
    return count
