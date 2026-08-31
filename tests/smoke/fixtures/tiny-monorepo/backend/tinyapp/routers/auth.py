from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from tinyapp.db import get_db

router = APIRouter()


@router.post("/login")
def login(email: str, password: str, db: Session = Depends(get_db)):
    """DELIBERATE DEFECT for security-audit:
    Classic SQL injection via f-string interpolation. The audit
    must detect this and emit a critical-severity finding.
    """
    query = f"select * from users where email = '{email}' and password_hash = '{password}'"
    row = db.execute(query).fetchone()
    return {"ok": row is not None}
