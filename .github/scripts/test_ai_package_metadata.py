import tempfile
import unittest
from pathlib import Path

from ai_changes import apply


class PackageMetadataProtection(unittest.TestCase):
    def test_rejects_nested_package_metadata_before_applying_sibling_changes(self):
        paths = (
            'Server/src/arena/package.json',
            'Server/public/example/package-lock.json',
            'Server/test/fixtures/npm-shrinkwrap.json',
            'Assets/Scripts/example/packages-lock.json',
        )
        for path in paths:
            with self.subTest(path=path), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                game_data = 'Server/public/maps/garden.json'
                proposal = {'summary': 'Map update', 'changes': [
                    {'path': game_data, 'content': '{"width": 15}'},
                    {'path': path, 'content': '{}'},
                ]}
                with self.assertRaises(ValueError):
                    apply(proposal, root)
                self.assertFalse((root / game_data).exists())
                self.assertFalse((root / path).exists())

    def test_ordinary_game_json_can_be_updated(self):
        with tempfile.TemporaryDirectory() as directory:
            path = 'Server/public/maps/garden.json'
            proposal = {'summary': 'Map update', 'changes': [
                {'path': path, 'content': '{"width": 15}'},
            ]}
            apply(proposal, directory)
            self.assertEqual((Path(directory) / path).read_text(), '{"width": 15}')
