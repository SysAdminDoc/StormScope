"""Injected services shared by camera provider protocol implementations."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True)
class ProviderRuntime:
    """Narrow runtime seam that keeps provider families independent of the CLI."""

    fetch_json: Callable[..., Any]
    post_json: Callable[..., Any]
    http_bytes: Callable[..., bytes]
    add_camera: Callable[..., None]
    detect_type: Callable[[str], str]
    log: Callable[[str], None]
