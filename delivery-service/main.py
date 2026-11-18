"""Dedicated Reel delivery entry point; no Fireflies handlers or schedulers."""
from app import create_app

app = create_app()
