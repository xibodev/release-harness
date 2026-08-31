from fastapi import FastAPI
from tinyapp.routers import auth, items

app = FastAPI(title="tinyapp")
app.include_router(auth.router, prefix="/auth", tags=["auth"])
app.include_router(items.router, prefix="/items", tags=["items"])


@app.get("/health")
def health():
    return {"status": "ok"}
