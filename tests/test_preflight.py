from __future__ import annotations

import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import preflight  # noqa: E402


class PreflightTests(unittest.TestCase):
    def test_version_parser_handles_common_tool_output(self) -> None:
        self.assertEqual((24, 16, 0), preflight.version_tuple("v24.16.0"))
        self.assertEqual((3, 11, 9), preflight.version_tuple("Python 3.11.9"))
        self.assertEqual((2026, 7, 4), preflight.version_tuple("2026.07.04"))

    def test_supported_version_ranges_are_explicit(self) -> None:
        self.assertTrue(preflight.in_range((3, 11), preflight.PYTHON_MIN, preflight.PYTHON_MAX))
        self.assertTrue(preflight.in_range((24, 16), preflight.NODE_MIN))
        self.assertFalse(preflight.in_range((3, 10, 99), preflight.PYTHON_MIN, preflight.PYTHON_MAX))
        self.assertFalse(preflight.in_range((4, 0), preflight.PYTHON_MIN, preflight.PYTHON_MAX))


if __name__ == "__main__":
    unittest.main()
