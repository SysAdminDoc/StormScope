"""Typed camera-provider adapter boundary."""

from .contracts import ProviderResult
from .registry import FunctionProviderAdapter, ProviderAdapter, ProviderRegistry
from .runtime import ProviderRuntime

__all__ = [
    "FunctionProviderAdapter",
    "ProviderAdapter",
    "ProviderRegistry",
    "ProviderResult",
    "ProviderRuntime",
]
