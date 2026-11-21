from pathlib import Path
import subprocess
import tempfile
import unittest

from verify_scheduled_regression import verify


class ScheduledRegressionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.test_file = self.root / 'Server/test/sample.test.js'
        self.test_file.parent.mkdir(parents=True)
        (self.root / 'Server/node_modules').mkdir()
        self.module = self.root / 'Server/value.js'
        self.module.write_text('module.exports = 1;')
        self.git('init', '-q')
        self.git('add', 'Server/value.js')
        self.git('-c', 'user.name=Tester', '-c', 'user.email=tester@example.invalid',
                 'commit', '-qm', 'baseline')
        self.module.write_text('module.exports = 2;')
        self.git('add', 'Server/value.js')

    def git(self, *args):
        subprocess.run(['git', *args], cwd=self.root, check=True)

    def stage_test(self, body):
        self.test_file.write_text(
            "const test = require('node:test'); const assert = require('node:assert/strict');\n" + body)
        self.git('add', 'Server/test/sample.test.js')

    def test_real_regression_passes_only_after_staged_fix(self):
        self.stage_test("test('updated value', () => assert.equal(require(process.cwd() + '/value.js'), 2));")
        self.module.write_text('module.exports = 3;')  # Evidence must use the staged change.
        verify(self.root)

    def test_unity_bridge_uses_repository_root(self):
        bridge = self.root / 'Assets/Tests/value.test.cjs'
        bridge.parent.mkdir(parents=True)
        bridge.write_text("""const test = require('node:test');
const assert = require('node:assert/strict');
test('bridge value', () => assert.equal(require(process.cwd() + '/Server/value.js'), 2));
""")
        self.git('add', 'Assets/Tests/value.test.cjs')
        verify(self.root)

    def test_staged_fixture_is_available_on_both_versions(self):
        fixture = self.test_file.parent / 'fixtures/expected.json'
        fixture.parent.mkdir()
        fixture.write_text('{"value": 2}')
        self.git('add', 'Server/test/fixtures/expected.json')
        self.stage_test("""const expected = require('./fixtures/expected.json');
test('updated value', () => assert.equal(require('../value'), expected.value));
""")
        fixture.write_text('{"value": 3}')  # Only the staged fixture is evidence.
        verify(self.root)

    def test_empty_new_file_is_not_counted_alongside_a_real_test(self):
        self.stage_test("test('updated value', () => assert.equal(require('../value'), 2));")
        (self.test_file.parent / 'empty.test.js').write_text('// no tests here')
        self.git('add', 'Server/test/empty.test.js')
        with self.assertRaises(ValueError):
            verify(self.root)

    def test_different_nested_suite_cannot_supply_the_green_case(self):
        self.stage_test("""const value = require('../value');
for (const group of ['first', 'second']) test.describe(group, () => {
  test.describe('nested', () => {
    test('updated value', {skip: group === 'first' && value === 2}, () => {
      if (group === 'first') assert.equal(value, 2);
    });
  });
});
""")
        with self.assertRaises(ValueError):
            verify(self.root)

    def test_duplicate_generated_identity_cannot_supply_evidence(self):
        self.stage_test("""const value = require('../value');
for (const variant of [1, 2]) test('same case', {skip: variant === value}, () => assert.equal(value, 2));
""")
        with self.assertRaises(ValueError):
            verify(self.root)

    def test_ambiguous_ancestor_on_either_revision_cannot_supply_evidence(self):
        for ambiguous_revision in [1, 2]:
            with self.subTest(ambiguous_revision=ambiguous_revision):
                self.stage_test("""const value = require('../value');
const groups = value === %d ? [1, 2] : [value];
for (const group of groups) test.describe('team', () => {
  test.describe('round', () => {
    if (group === value) test('updated value', () => assert.equal(value, 2));
  });
});
""" % ambiguous_revision)
                with self.assertRaises(ValueError):
                    verify(self.root)

    def test_generated_subtests_match_in_the_same_suite_and_file(self):
        self.stage_test("""for (const group of ['first', 'second']) test.describe(group, () => {
  test('runner', async t => { await t.test('value', () => assert.equal(require('../value'), 2)); });
});
""")
        (self.test_file.parent / 'second.test.js').write_bytes(self.test_file.read_bytes())
        self.git('add', 'Server/test/second.test.js')
        verify(self.root)

    def test_absent_behavioral_evidence_fails(self):
        for body in [
            '',
            "test.skip('value', () => assert.fail());",
            "test.todo('value');",
            "test('value', () => assert.ok(true));",
            "test('value', () => assert.fail());",
            "test('value', () => { if (require('../value') === 1) require('./missing'); });",
            "test('slow', { timeout: 10 }, () => new Promise(resolve => setTimeout(resolve, 80)));",
            'invalid syntax!',
        ]:
            with self.subTest(body=body), self.assertRaises(ValueError):
                self.stage_test(body)
                verify(self.root)
