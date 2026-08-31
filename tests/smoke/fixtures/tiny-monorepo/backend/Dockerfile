FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml ./
RUN pip install -e .
COPY tinyapp ./tinyapp
COPY alembic ./alembic
COPY alembic.ini ./
EXPOSE 8000
CMD ["uvicorn", "tinyapp.main:app", "--host", "0.0.0.0", "--port", "8000"]
