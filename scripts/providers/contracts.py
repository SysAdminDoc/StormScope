"""Shared provider result contract used by ingestion adapters and merging."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ProviderResult:
    """One atomic provider snapshot; errors never carry partial cameras."""

    name: str
    cameras: list[dict]
    error: str = ""

    def __post_init__(self) -> None:
        if not self.name.strip():
            raise ValueError("provider name is required")
        if self.error and self.cameras:
            raise ValueError("failed provider results cannot carry partial cameras")

    @property
    def succeeded(self) -> bool:
        return not self.error and bool(self.cameras)
