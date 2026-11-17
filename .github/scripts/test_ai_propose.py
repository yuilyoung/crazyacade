import tempfile
import unittest
from pathlib import Path
import ai_propose as ai

class ContextSelectionTests(unittest.TestCase):
    def test_budget_keeps_backlog_runtime_and_regression_context(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            files={'docs/Design/Gameplay-Upgrade-2026-11-17.md':'completed gameplay; only reproduced bugs',
                   'Server/src/match-engine.js':'authoritative engine',
                   'Server/test/match-engine.test.js':'protected regression tests',
                   'Server/public/huge.js':'x'*130000}
            for name,text in files.items():
                path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(text)
            bundle,omitted=ai.source_bundle(root,sorted(files),budget=1000)
            selected={item['path'] for item in bundle}
            self.assertTrue(set(files)-{'Server/public/huge.js'}<=selected)
            self.assertIn('Server/public/huge.js',omitted)
