import tempfile
import unittest
from pathlib import Path
from ai_changes import apply, validate

class ChangesGuardTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
    def proposal(self, path, content='export const answer = 42;'):
        return {'summary': 'Small change', 'changes': [{'path': path, 'content': content}]}
    def test_applies_source_content(self):
        apply(self.proposal('Server/src/example.js'), self.root)
        self.assertEqual((self.root/'Server/src/example.js').read_text(), 'export const answer = 42;')
    def test_blocks_automation_credentials_traversal_and_dependencies(self):
        for path in ['.github/workflows/ci.yml', 'Server/package.json', 'Server/src/../../.env', '/tmp/file.js', 'Server/src/.env', 'Server/src/x\\y.js', 'Server/src/../private.js']:
            with self.subTest(path=path), self.assertRaises(ValueError): validate(self.proposal(path), self.root)
    def test_validates_all_changes_before_writing(self):
        data=self.proposal('Server/src/good.js'); data['changes'].append({'path': '.git/config', 'content': 'bad'})
        with self.assertRaises(ValueError): apply(data, self.root)
        self.assertFalse((self.root/'Server/src/good.js').exists())
    def test_rejects_symlink_target(self):
        (self.root/'Server').mkdir(); (self.root/'Server/src').symlink_to('/tmp')
        with self.assertRaises(ValueError): validate(self.proposal('Server/src/example.js'), self.root)
    def test_rejects_duplicates_and_oversize(self):
        data=self.proposal('Server/src/test.js'); data['changes'] *= 2
        with self.assertRaises(ValueError): validate(data, self.root)
        with self.assertRaises(ValueError): validate(self.proposal('Server/src/test.js','x'*300001), self.root)

if __name__ == '__main__': unittest.main()
