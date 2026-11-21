import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

import ai_propose as ai


class MaintenanceContextTests(unittest.TestCase):
    def test_three_daily_runs_cover_gameplay_stability_and_security(self):
        days = [date(2026, 11, 21) + timedelta(days=i) for i in range(3)]
        focuses = {ai.focus_for_day(day, maintenance=True) for day in days}
        self.assertIn('stability', focuses)
        self.assertIn('security', focuses)
        self.assertEqual(len(focuses.intersection(ai.FOCUS)), 1)

    def test_budget_keeps_the_selected_contract_and_its_tests(self):
        pairs = {
            'stability': ('Server/src/runtime.js', 'Server/test/runtime.test.js'),
            'security': ('Server/src/account-http.js', 'Server/test/account-http.test.js'),
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            names = ['Server/public/background.js', 'Server/public/package.json']
            for pair in pairs.values():
                names.extend(pair)
            for name in names:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('x' * 50)
            for focus, pair in pairs.items():
                with self.subTest(focus=focus):
                    bundle, _ = ai.source_bundle(root, names, budget=100, focus=focus)
                    self.assertEqual([item['path'] for item in bundle], list(pair))
            bundle, _ = ai.source_bundle(root, names)
            self.assertNotIn('Server/public/package.json', {item['path'] for item in bundle})
