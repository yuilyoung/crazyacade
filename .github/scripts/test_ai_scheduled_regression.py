import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class ScheduledRegressionGuard(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.source = 'Server/src/arena.js'
        self.change = {'path': self.source, 'content': 'export const width = 15;'}

    def run_guard(self, changes, *, scheduled=True):
        proposal = self.root / 'proposal.json'
        proposal.write_text(json.dumps({'summary': 'Arena dimensions', 'changes': changes}))
        command = [sys.executable, str(Path(__file__).with_name('ai_changes.py')),
                   str(proposal), '--root', str(self.root)]
        if scheduled:
            command.append('--require-regression')
        return subprocess.run(command, capture_output=True, text=True)

    def test_source_only_is_accepted_manually_and_rejected_for_scheduled_fix(self):
        result = self.run_guard([self.change])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('new regression', result.stderr)
        self.assertFalse((self.root / self.source).exists())
        self.assertEqual(self.run_guard([self.change], scheduled=False).returncode, 0)

    def test_no_changes_requires_no_regression(self):
        result = self.run_guard([])
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_new_regressions_must_be_nonblank_and_match_test_discovery(self):
        for path, content in [('Server/test/nested/width.test.js', 'test()'),
                              ('Server/test/helper.js', 'test()'),
                              ('Assets/Tests/width.test.js', 'test()'),
                              ('Server/test/width.test.js', ' \n')]:
            with self.subTest(path=path):
                result = self.run_guard([self.change, {'path': path, 'content': content}])
                self.assertIn('new regression', result.stderr)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.root / self.source).exists())

    def test_existing_identical_test_does_not_count_as_new(self):
        for path in ['Server/test/width.test.js', 'Assets/Tests/width.test.cjs']:
            with self.subTest(path=path):
                content = (
                    "import('node:test').then(({test}) => test('arena width', async () => {"
                    "const {width} = await import('../../Server/src/arena.js');"
                    "(await import('node:assert/strict')).equal(width, 15); }));"
                )
                changes = [self.change, {'path': path, 'content': content}]
                first = self.run_guard(changes)
                self.assertEqual(first.returncode, 0, first.stderr)
                self.assertEqual((self.root / path).read_text(), content)
                second = self.run_guard(changes)
                self.assertIn('new regression', second.stderr)
                self.assertNotEqual(second.returncode, 0)
