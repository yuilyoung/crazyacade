"""Regression tests for coverage validation, truthful scoring and failed evidence."""
import copy
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('quality_gates', ROOT / 'scripts/check-quality-gates.py')
gates = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gates)


class QualityGateTests(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((ROOT / 'scripts/quality-gates.json').read_text())

    def test_repository_manifest_has_valid_complete_coverage(self):
        gates.validate_manifest(self.manifest, ROOT)
        self.assertEqual(len(self.manifest['categories']), 10)
        self.assertEqual(sum(c['points'] for c in self.manifest['categories']), 100)

    def test_missing_category_duplicate_check_and_unknown_reference_are_rejected(self):
        mutations = [lambda m: m['categories'].pop(),
                     lambda m: m['checks'].append(copy.deepcopy(m['checks'][0])),
                     lambda m: m['categories'][0]['checks'].append('invented-success')]
        for mutate in mutations:
            invalid = copy.deepcopy(self.manifest)
            mutate(invalid)
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                gates.validate_manifest(invalid, ROOT)

    def test_nonexistent_target_and_shell_command_are_rejected(self):
        for field, value in [('targets', ['Server/test/no-such-test.js']), ('argv', 'npm test')]:
            invalid = copy.deepcopy(self.manifest)
            invalid['checks'][0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                gates.validate_manifest(invalid, ROOT)

    def test_unbounded_timeout_missing_evidence_and_missing_threshold_are_rejected(self):
        for field, value in [('timeoutSeconds', 0), ('evidence', []), ('thresholds', [])]:
            invalid = copy.deepcopy(self.manifest)
            invalid['checks'][0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                gates.validate_manifest(invalid, ROOT)

    def test_latency_assertion_budget_and_three_browsers_cannot_silently_disappear(self):
        for check_id, argument in [('input-latency', '--assert-latency'), ('browser-compatibility', 'all')]:
            invalid = copy.deepcopy(self.manifest)
            check = next(c for c in invalid['checks'] if c['id'] == check_id)
            check['argv'].remove(argument)
            with self.subTest(check=check_id), self.assertRaises(ValueError):
                gates.validate_manifest(invalid, ROOT)
        invalid = copy.deepcopy(self.manifest)
        command = next(c for c in invalid['checks'] if c['id'] == 'input-latency')['argv']
        command[command.index('--threshold-ms') + 1] = '999'
        with self.assertRaises(ValueError):
            gates.validate_manifest(invalid, ROOT)

    def test_unexecuted_checks_earn_no_score_and_fresh_all_pass_earns_100(self):
        missing = gates.score(self.manifest, [])
        self.assertEqual(missing['score'], 0)
        self.assertFalse(missing['passed'])
        results = [{'id': c['id'], 'status': 'passed', 'returncode': 0} for c in self.manifest['checks']]
        passed = gates.score(self.manifest, results)
        self.assertEqual(passed['score'], 100)
        self.assertTrue(passed['passed'])

    def test_security_sync_and_essential_e2e_are_hard_requirements(self):
        for critical in self.manifest['hardRequiredChecks']:
            results = [{'id': c['id'], 'status': 'passed', 'returncode': 0} for c in self.manifest['checks'] if c['id'] != critical]
            result = gates.score(self.manifest, results)
            self.assertFalse(result['passed'], critical)
            self.assertIn(critical, result['hardRequirementsMissing'])

    def test_score_above_90_does_not_excuse_a_missing_check(self):
        results = [{'id': c['id'], 'status': 'passed', 'returncode': 0} for c in self.manifest['checks'] if c['id'] != 'automation-guards']
        result = gates.score(self.manifest, results)
        self.assertGreaterEqual(result['score'], 90)
        self.assertFalse(result['passed'])

    def test_stale_or_forward_dependency_cannot_be_accepted(self):
        invalid = copy.deepcopy(self.manifest)
        invalid['checks'][0]['dependsOn'] = ['movement-quality']
        with self.assertRaises(ValueError):
            gates.validate_manifest(invalid, ROOT)

    def test_a_failed_command_never_earns_credit_even_with_passed_label(self):
        results = [{'id': c['id'], 'status': 'passed', 'returncode': 17} for c in self.manifest['checks']]
        self.assertEqual(gates.score(self.manifest, results)['score'], 0)

    def test_exit_status_and_timeout_survive_with_logs(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            check = {'id': 'failure', 'argv': [sys.executable, '-c', 'print("retained failure"); raise SystemExit(17)'], 'cwd': '.', 'timeoutSeconds': 5}
            result = gates.execute_check(check, ROOT, output)
            self.assertEqual(result['returncode'], 17)
            self.assertEqual(result['status'], 'failed')
            self.assertIn('retained failure', Path(result['log']).read_text())
            check.update(id='timeout', argv=[sys.executable, '-c', 'import time; time.sleep(3)'], timeoutSeconds=.05)
            result = gates.execute_check(check, ROOT, output)
            self.assertEqual(result['returncode'], 124)
            self.assertEqual(result['status'], 'timed_out')

    def test_timeout_and_sigterm_allow_finally_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            marker = output / 'cleanup'
            program = f"import time\ntry:\n time.sleep(3)\nfinally:\n open({str(marker)!r},'w').write('cleaned')"
            check = {'id': 'timeout-cleanup', 'argv': [sys.executable, '-c', program], 'cwd': '.', 'timeoutSeconds': .1}
            result = gates.execute_check(check, ROOT, output)
            self.assertEqual(result['returncode'], 124)
            self.assertEqual(marker.read_text(), 'cleaned')
            marker.unlink()
            program = f"import os,signal,time\ntry:\n os.kill(os.getppid(),signal.SIGTERM)\n time.sleep(3)\nfinally:\n open({str(marker)!r},'w').write('cleaned')"
            check.update(id='sigterm-cleanup', argv=[sys.executable, '-c', program], timeoutSeconds=5)
            result = gates.execute_check(check, ROOT, output)
            self.assertEqual(result['returncode'], 143)
            self.assertEqual(marker.read_text(), 'cleaned')

    def test_concurrent_report_writes_have_unique_temporary_files(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'report.json'
            reports = [{'runId': str(i), 'results': []} for i in range(30)]
            with ThreadPoolExecutor(max_workers=5) as pool:
                list(pool.map(lambda report: gates.write_report(path, report, self.manifest), reports))
            self.assertIn(json.loads(path.read_text())['runId'], [str(i) for i in range(30)])
            self.assertFalse(list(Path(directory).glob('*.tmp')))

    def test_duplicate_effective_latency_options_are_rejected(self):
        invalid = copy.deepcopy(self.manifest)
        command = next(c for c in invalid['checks'] if c['id'] == 'input-latency')['argv']
        command.extend(['--threshold-ms', '999', '--network-delay-ms', '0'])
        with self.assertRaises(ValueError):
            gates.validate_manifest(invalid, ROOT)

    def test_load_cannot_be_shortened_below_sixty_seconds(self):
        invalid = copy.deepcopy(self.manifest)
        command = next(c for c in invalid['checks'] if c['id'] == 'bounded-load')['argv']
        command[command.index('--duration-seconds') + 1] = '1'
        with self.assertRaises(ValueError):
            gates.validate_manifest(invalid, ROOT)

    def test_each_declared_check_must_execute_its_real_entrypoint(self):
        for original in self.manifest['checks']:
            invalid = copy.deepcopy(self.manifest)
            next(c for c in invalid['checks'] if c['id'] == original['id'])['argv'] = ['python3', '-c', 'pass']
            with self.subTest(check=original['id']), self.assertRaises(ValueError):
                gates.validate_manifest(invalid, ROOT)

    def test_reduced_or_filtered_suite_flags_and_wrong_cwd_are_rejected(self):
        mutations = [('game-shell', ['--ready-only']), ('game-shell', ['--skip-duel']),
                     ('game-shell', ['--scenario', 'auth']), ('server-tests', ['--', '--test-name-pattern', 'nonexistent']),
                     ('automation-guards', ['-k', 'nonexistent']), ('bounded-load', ['--duration-seconds', '1'])]
        for check_id, extra in mutations:
            invalid = copy.deepcopy(self.manifest)
            next(c for c in invalid['checks'] if c['id'] == check_id)['argv'].extend(extra)
            with self.subTest(check=check_id, extra=extra), self.assertRaises(ValueError):
                gates.validate_manifest(invalid, ROOT)
        invalid = copy.deepcopy(self.manifest)
        next(c for c in invalid['checks'] if c['id'] == 'server-tests')['cwd'] = '.'
        with self.assertRaises(ValueError):
            gates.validate_manifest(invalid, ROOT)

    def test_option_arity_unknown_options_and_nonfinite_numbers_are_rejected(self):
        cases = [('input-latency', ['--threshold-ms']), ('input-latency', ['--samples', '0']),
                 ('input-latency', ['--unknown', 'pass']), ('bounded-load', ['--output']),
                 ('browser-compatibility', ['--browser', 'chromium'])]
        for check_id, extra in cases:
            invalid = copy.deepcopy(self.manifest)
            next(c for c in invalid['checks'] if c['id'] == check_id)['argv'].extend(extra)
            with self.subTest(check=check_id, extra=extra), self.assertRaises(ValueError):
                gates.validate_manifest(invalid, ROOT)
        for option in ['--threshold-ms', '--network-delay-ms']:
            for value in ['nan', 'inf', '-inf']:
                invalid = copy.deepcopy(self.manifest)
                command = next(c for c in invalid['checks'] if c['id'] == 'input-latency')['argv']
                command[command.index(option) + 1] = value
                with self.subTest(option=option, value=value), self.assertRaises(ValueError):
                    gates.validate_manifest(invalid, ROOT)

    def test_stricter_latency_and_longer_load_keep_the_gate_valid(self):
        command = next(c for c in self.manifest['checks'] if c['id'] == 'input-latency')['argv']
        command[command.index('--threshold-ms') + 1] = '90'
        command[command.index('--network-delay-ms') + 1] = '60'
        load = next(c for c in self.manifest['checks'] if c['id'] == 'bounded-load')['argv']
        load[load.index('--duration-seconds') + 1] = '90'
        gates.validate_manifest(self.manifest, ROOT)

    def test_npm_script_must_keep_full_node_test_discovery(self):
        original = Path.read_text
        def weakened_package(path, *args, **kwargs):
            if path == ROOT / 'Server/package.json':
                return json.dumps({'scripts': {'test': 'node -e "process.exit(0)"'}})
            return original(path, *args, **kwargs)
        with patch.object(Path, 'read_text', weakened_package), self.assertRaises(ValueError):
            gates.validate_manifest(self.manifest, ROOT)

    def test_abbreviated_equals_and_source_override_flags_are_rejected(self):
        for extra in [['--threshold-ms=999'], ['--threshold-m', '999'], ['--network-delay-m', '0'], ['--server-root', '/tmp/old-sources']]:
            invalid = copy.deepcopy(self.manifest)
            next(c for c in invalid['checks'] if c['id'] == 'input-latency')['argv'].extend(extra)
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                gates.validate_manifest(invalid, ROOT)

    def test_declared_checks_and_movement_dependency_cannot_be_removed(self):
        invalid = copy.deepcopy(self.manifest)
        invalid['checks'] = [c for c in invalid['checks'] if c['id'] != 'automation-guards']
        for category in invalid['categories']:
            category['checks'] = [id for id in category['checks'] if id != 'automation-guards']
        with self.assertRaises(ValueError):
            gates.validate_manifest(invalid, ROOT)
        invalid = copy.deepcopy(self.manifest)
        next(c for c in invalid['checks'] if c['id'] == 'movement-quality').pop('dependsOn')
        with self.assertRaises(ValueError):
            gates.validate_manifest(invalid, ROOT)

    def test_zero_tests_cannot_earn_suite_credit(self):
        with tempfile.TemporaryDirectory() as directory:
            for check_id, stdout in [('server-tests', '# tests 0\n# pass 0'), ('unity-bridges', '# tests 0\n# pass 0'), ('automation-guards', 'Ran 0 tests in 0.001s\n\nOK')]:
                check = {'id': check_id, 'argv': [sys.executable, '-c', f'print({stdout!r})'], 'cwd': '.', 'timeoutSeconds': 5}
                result = gates.execute_check(check, ROOT, Path(directory))
                with self.subTest(check=check_id):
                    self.assertNotEqual(result['returncode'], 0)
                    self.assertEqual(result['status'], 'failed')

    def test_inherited_python_optimization_cannot_disable_assertions(self):
        with tempfile.TemporaryDirectory() as directory:
            check = {'id': 'optimization', 'argv': [sys.executable, '-c', 'import sys; raise SystemExit(sys.flags.optimize)'], 'cwd': '.', 'timeoutSeconds': 5}
            with patch.dict(os.environ, {'PYTHONOPTIMIZE': '1'}):
                result = gates.execute_check(check, ROOT, Path(directory))
            self.assertEqual(result['returncode'], 0)

    def test_node_24_spec_and_tap_summaries_are_recognized(self):
        for summary in ['# tests 696\n# pass 696\n', 'ℹ tests 696\nℹ pass 696\n', '\x1b[34mℹ tests 5\x1b[39m\n\x1b[34mℹ pass 5\x1b[39m\n']:
            with self.subTest(summary=summary):
                self.assertTrue(gates.has_nonempty_suite_result('server-tests', summary))
