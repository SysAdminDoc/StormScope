"""Ordered internal adapter registry with legacy-compatible CLI selection."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Protocol, runtime_checkable

from .contracts import ProviderResult

Fetcher = Callable[[], int]
Runner = Callable[[str, Fetcher], ProviderResult]


@runtime_checkable
class ProviderAdapter(Protocol):
    name: str
    family: str

    def fetch(self, runner: Runner) -> ProviderResult: ...


@dataclass(frozen=True)
class FunctionProviderAdapter:
    """Adapts one legacy collector without changing its network/data behavior."""

    name: str
    family: str
    collector: Fetcher

    def __post_init__(self) -> None:
        if not self.name.strip() or not self.family.strip() or not callable(self.collector):
            raise ValueError("provider adapter requires name, family, and collector")

    def fetch(self, runner: Runner) -> ProviderResult:
        result = runner(self.name, self.collector)
        if not isinstance(result, ProviderResult) or result.name != self.name:
            raise TypeError("provider runner violated the ProviderResult contract")
        return result


class ProviderRegistry:
    """Immutable-order registry preserving historic provider and CLI semantics."""

    def __init__(self, adapters: list[ProviderAdapter]):
        names = [adapter.name for adapter in adapters]
        if len(names) != len(set(names)):
            raise ValueError("provider names must be unique")
        self._adapters = tuple(adapters)

    def all(self) -> tuple[ProviderAdapter, ...]:
        return self._adapters

    def select(self, requested_names: list[str]) -> tuple[ProviderAdapter, ...]:
        if not requested_names:
            return self._adapters
        selected: list[ProviderAdapter] = []
        missing: list[str] = []
        for requested in requested_names:
            normalized = requested.casefold()
            matches = [adapter for adapter in self._adapters if normalized in adapter.name.casefold()]
            if len(matches) == 1:
                if matches[0] not in selected:
                    selected.append(matches[0])
            else:
                missing.append(normalized)
        if missing:
            raise ValueError(f"unknown or ambiguous provider(s): {', '.join(sorted(missing))}")
        return tuple(selected)
