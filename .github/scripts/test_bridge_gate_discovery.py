import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('quality_gates', ROOT / 'scripts/check-quality-gates.py')
gates = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gates)


class BridgeGateDiscovery(unittest.TestCase):
    def test_new_bridge_regression_is_discovered_and_can_fail_the_gate(self):
        manifest = json.loads((ROOT / 'scripts/quality-gates.json').read_text())
        check = next(check for check in manifest['checks'] if check['id'] == 'unity-bridges')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tests = root / 'Assets/Tests'
            tests.mkdir(parents=True)
            for path in ['auth-bridge.test.cjs', 'socket-bridge.test.cjs']:
                shutil.copy(ROOT / 'Assets/Tests' / path, tests / path)
            shutil.copytree(ROOT / 'Assets/Plugins/WebGL', root / 'Assets/Plugins/WebGL')
            (tests / 'added.test.cjs').write_text("""
                const {test} = require('node:test');
                const assert = require('node:assert/strict');
                test('new bridge state regression', () => {
                    assert.equal(require('./fixture.json').state, 'ready');
                });
            """)
            fixture = tests / 'fixture.json'
            for state, expected in [('ready', 'passed'), ('waiting', 'failed')]:
                with self.subTest(state=state):
                    fixture.write_text(json.dumps({'state': state}))
                    result = gates.execute_check(check, root, root / state)
                    self.assertEqual(result['status'], expected)
                    self.assertEqual(result['returncode'] == 0, expected == 'passed')
                    self.assertIn('new bridge state regression', Path(result['log']).read_text())
