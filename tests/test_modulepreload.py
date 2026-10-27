"""The modulepreload list in app/index.html must match the static import graph of js/main.js."""

from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parent.parent


class ModulePreloadTests(unittest.TestCase):
    def test_index_preloads_every_startup_module(self):
        result = subprocess.run([sys.executable, str(ROOT / "tools" / "modulepreload.py"), "--check"],
                                capture_output=True, text=True, cwd=ROOT)
        self.assertEqual(result.returncode, 0, "Run python tools/modulepreload.py\n" + result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
