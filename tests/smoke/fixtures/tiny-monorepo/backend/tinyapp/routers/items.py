from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from tinyapp.db import get_db

router = APIRouter()


@router.get("/list/{owner_id}")
def list_items(owner_id: int, db: Session = Depends(get_db)):
    """DELIBERATE DEFECT for performance-audit (N+1) and
    database-readiness-audit (missing index on items.owner_id):

    1. items.owner_id has no index, so this query table-scans.
    2. The per-item user lookup runs once per row — classic N+1.
    """
    items = db.execute(
        f"select id, owner_id, name from items where owner_id = {owner_id}"
    ).fetchall()
    enriched = []
    for it in items:
        user = db.execute(
            f"select email from users where id = {it.owner_id}"
        ).fetchone()
        enriched.append({"id": it.id, "name": it.name, "owner_email": user.email})
    return enriched
