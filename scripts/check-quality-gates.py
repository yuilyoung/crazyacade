#!/usr/bin/env python3
"""Validate/run the engineering quality gate; score only this invocation's results."""
import argparse
import hashlib
from datetime import datetime, timezone
import json
import math
import os
import re
from pathlib import Path
import signal
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
CATEGORY_IDS = {'traffic-latency', 'security', 'service-stability', 'ipc-stability',
                'test-levels', 'ui-ux', 'browser-refresh-compatibility',
                'concurrent-connections', 'thread-safety', 'synchronization'}
HARD_CHECKS = {'server-tests', 'game-shell', 'member-account', 'gameplay-upgrade', 'browser-compatibility'}

# Changes to a gate command must be reviewed here together with its coverage;
# descriptive target metadata alone must never authorize a no-op replacement.
COMMANDS = {
    'server-tests': ['npm', 'test'],
    'unity-bridges': ['node', '--test', 'Assets/Tests/*.test.cjs'],
    'migration-consistency': ['python3', 'scripts/build-supabase-setup.py', '--check'],
    'postgres-rankings': ['python3', 'scripts/test-rankings-db.py'],
    'automation-guards': ['python3', '-m', 'unittest', 'discover', '-s', '.github/scripts', '-p', 'test_*.py'],
    'game-shell': ['python3', 'scripts/game-shell-smoke.py'],
    'member-account': ['python3', 'scripts/member-account-smoke.py'],
    'gameplay-upgrade': ['python3', 'scripts/gameplay-upgrade-smoke.py'],
    'movement-quality': ['node', 'scripts/movement-quality.mjs', '/tmp/crazyacade-upgrade/browser/frames.json'],
    'input-latency': ['python3', 'scripts/input-latency-smoke.py'],
    'bounded-load': ['node', 'scripts/load85-smoke.mjs'],
    'browser-compatibility': ['python3', 'scripts/quality-browser-smoke.py', '--browser', 'all'],
}


def parse_options(arguments, required, flags=()):
    """Accept exact option names once; no argparse abbreviations or last-wins."""
    options = {}
    index = 0
    while index < len(arguments):
        option = arguments[index]
        if option not in required or option in options:
            raise ValueError(f'Unknown or repeated quality option: {option}')
        if option in flags:
            options[option] = True
            index += 1
        else:
            if index + 1 >= len(arguments) or arguments[index + 1].startswith('--'):
                raise ValueError(f'Missing value for {option}')
            options[option] = arguments[index + 1]
            index += 2
    if set(options) != set(required):
        raise ValueError(f'Missing quality options: {sorted(set(required) - set(options))}')
    return options


def validate_command(check, root):
    check_id, argv = check['id'], check['argv']
    expected = COMMANDS.get(check_id)
    if expected is None:
        raise ValueError(f'Unknown quality check: {check_id}')
    if check.get('cwd', '.') != ('Server' if check_id == 'server-tests' else '.'):
        raise ValueError(f'{check_id} must use its canonical working directory')
    expected_dependencies = ['gameplay-upgrade'] if check_id == 'movement-quality' else []
    if check.get('dependsOn', []) != expected_dependencies:
        raise ValueError(f'{check_id} must retain dependencies {expected_dependencies}')
    if check_id not in {'input-latency', 'bounded-load'}:
        if argv != expected:
            raise ValueError(f'{check_id} must execute the complete canonical command')
    else:
        if argv[:len(expected)] != expected:
            raise ValueError(f'{check_id} must execute its canonical entrypoint')
        if check_id == 'input-latency':
            options = parse_options(argv[len(expected):],
                                    {'--assert-latency', '--threshold-ms', '--network-delay-ms', '--output'},
                                    {'--assert-latency'})
            try:
                threshold, delay = float(options['--threshold-ms']), float(options['--network-delay-ms'])
            except ValueError as error:
                raise ValueError('Latency budgets must be finite numbers') from error
            if not (math.isfinite(threshold) and 0 < threshold <= 100 and math.isfinite(delay) and delay >= 40):
                raise ValueError('Latency must assert <=100ms with >=40ms simulated delay each way')
            if options['--output'] != '/tmp/crazyacade-input/after.json':
                raise ValueError('Latency evidence must use its declared output path')
        else:
            options = parse_options(argv[len(expected):], {'--duration-seconds', '--output'})
            try:
                duration = int(options['--duration-seconds'])
            except ValueError as error:
                raise ValueError('Load duration must be an integer') from error
            if not 60 <= duration <= 90:
                raise ValueError('64-client/8-room load must run 60..90 seconds')
            if options['--output'] != '/tmp/poppop85-load.json':
                raise ValueError('Load evidence must use its declared output path')
    if check_id == 'server-tests':
        try:
            package = json.loads((root / 'Server/package.json').read_text())
            if package['scripts']['test'] != 'node --test test/*.test.js':
                raise ValueError('npm test must retain complete Node test discovery')
        except (KeyError, TypeError, json.JSONDecodeError) as error:
            raise ValueError('Invalid Node test discovery configuration') from error



def within(root, value):
    resolved = (root / value).resolve()
    if not resolved.is_relative_to(root.resolve()):
        raise ValueError(f'Path escapes repository: {value}')
    return resolved


def validate_manifest(manifest, root):
    def require(condition, message):
        if not condition:
            raise ValueError(message)
    require(manifest.get('schemaVersion') == 1, 'Unsupported schemaVersion')
    require(manifest.get('minimumScore') == 90, 'The engineering score threshold must be 90/100')
    checks, categories = manifest.get('checks', []), manifest.get('categories', [])
    require(isinstance(checks, list) and bool(checks), 'checks must be a nonempty list')
    require(isinstance(categories, list) and len(categories) == 10, 'Exactly ten categories are required')
    ids = [check.get('id') for check in checks]
    require(all(isinstance(value, str) and value and all(c.isalnum() or c == '-' for c in value) for value in ids), 'Invalid check ID')
    require(len(set(ids)) == len(ids), 'Duplicate check IDs')
    require(set(ids) == set(COMMANDS), 'Every canonical quality check must remain present')
    require({c.get('id') for c in categories} == CATEGORY_IDS, 'All ten quality categories must be covered')
    require(set(manifest.get('hardRequiredChecks', [])) == HARD_CHECKS, 'Security, synchronization and essential E2E must remain hard requirements')
    require(HARD_CHECKS <= set(ids), 'Missing hard check')
    referenced = set()
    for category in categories:
        require(category.get('points') == 10, 'Each category must have ten points')
        require(isinstance(category.get('target'), str) and bool(category['target']), 'Missing category target')
        links = category.get('checks', [])
        require(isinstance(links, list) and bool(links) and len(set(links)) == len(links), 'Missing or duplicate category checks')
        require(set(links) <= set(ids), 'Unknown category check reference')
        referenced.update(links)
    require(referenced == set(ids), 'Every executed check must contribute to declared coverage')
    previous_checks = set()
    for check in checks:
        dependencies = check.get('dependsOn', [])
        require(isinstance(dependencies, list) and set(dependencies) <= previous_checks, 'Dependencies must name earlier checks in this run')
        previous_checks.add(check['id'])
        argv = check.get('argv')
        require(isinstance(argv, list) and bool(argv) and all(isinstance(arg, str) and arg and '\x00' not in arg for arg in argv), 'argv must be a nonempty argument array, never a shell string')
        validate_command(check, root)
        require(within(root, check.get('cwd', '.')).is_dir(), 'Missing working directory')
        seconds = check.get('timeoutSeconds')
        require(isinstance(seconds, (int, float)) and not isinstance(seconds, bool) and math.isfinite(seconds) and 0 < seconds <= 1800, 'Each check needs a bounded timeout')
        for field in ('targets', 'evidence', 'thresholds'):
            require(isinstance(check.get(field), list) and bool(check[field]), f'Missing {field} for {check["id"]}')
        for target in check['targets']:
            require(isinstance(target, str) and within(root, target).is_file(), f'Target does not exist: {target}')
        require(all(isinstance(e, str) and bool(e) for e in check['evidence']), 'Invalid evidence path')
        require(all(isinstance(t, dict) and all(key in t for key in ('metric', 'operator', 'value', 'enforcedBy')) for t in check['thresholds']), 'Threshold needs metric/operator/value/enforcedBy')
        require(all(t['enforcedBy'] in check['targets'] for t in check['thresholds']), 'Threshold must name its actual enforcing target')


def score(manifest, results):
    # Do not read prior report files or award points from mere file existence.
    passed = {r['id'] for r in results if r.get('status') == 'passed' and r.get('returncode') == 0}
    categories = []
    for category in manifest['categories']:
        completed = sorted(set(category['checks']) & passed)
        points = category['points'] * len(completed) / len(category['checks'])
        categories.append({'id': category['id'], 'points': round(points, 3), 'maximum': category['points'],
                           'passedChecks': completed, 'missingOrFailedChecks': sorted(set(category['checks']) - passed)})
    total = round(sum(c['points'] for c in categories), 3)
    missing = sorted(set(manifest['hardRequiredChecks']) - passed)
    missing_checks = sorted({c['id'] for c in manifest['checks']} - passed)
    return {'score': total, 'maximum': 100, 'minimum': manifest['minimumScore'], 'categories': categories,
            'hardRequirementsMissing': missing, 'missingOrFailedChecks': missing_checks,
            'passed': total >= manifest['minimumScore'] and not missing and not missing_checks}


def now():
    return datetime.now(timezone.utc).isoformat()


class GateInterrupted(Exception):
    def __init__(self, signum):
        self.signum = signum


def stop_process_group(process):
    # Python finally blocks remove disposable Docker containers and browser/server
    # scripts close their service before the hard kill deadline.
    try:
        os.killpg(process.pid, signal.SIGINT)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()


def has_nonempty_suite_result(check_id, log):
    log = re.sub(r'\x1b\[[0-9;]*m', '', log)
    if check_id in {'server-tests', 'unity-bridges'}:
        tests = re.findall(r'^(?:#|ℹ) tests (\d+)\s*$', log, re.MULTILINE)
        passed = re.findall(r'^(?:#|ℹ) pass (\d+)\s*$', log, re.MULTILINE)
        return bool(tests and passed and int(tests[-1]) > 0 and int(passed[-1]) > 0)
    if check_id == 'automation-guards':
        tests = re.findall(r'^Ran (\d+) tests? in ', log, re.MULTILINE)
        return bool(tests and int(tests[-1]) > 0)
    return True


def execute_check(check, root, output):
    output.mkdir(parents=True, exist_ok=True)
    log_path = output / f'{check["id"]}.log'
    result = {'id': check['id'], 'argv': check['argv'], 'cwd': check.get('cwd', '.'),
              'startedAt': now(), 'log': str(log_path), 'status': 'failed', 'returncode': 1}
    started = time.monotonic()
    print(f'Running {check["id"]}: {json.dumps(check["argv"])}', flush=True)
    previous_sigterm = signal.getsignal(signal.SIGTERM)
    def terminate_handler(signum, frame):
        raise GateInterrupted(signum)
    signal.signal(signal.SIGTERM, terminate_handler)
    with log_path.open('w') as log:
        process = None
        try:
            environment = dict(os.environ)
            environment.pop('PYTHONOPTIMIZE', None)  # Smoke-test assert statements must execute.
            process = subprocess.Popen(check['argv'], cwd=root / check.get('cwd', '.'), env=environment,
                                       stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            result['returncode'] = process.wait(timeout=check['timeoutSeconds'])
            result['status'] = 'passed' if result['returncode'] == 0 else 'failed'
        except subprocess.TimeoutExpired:
            stop_process_group(process)
            result.update(status='timed_out', returncode=124)
            log.write(f'\nGate timed out after {check["timeoutSeconds"]} seconds.\n')
        except OSError as error:
            result.update(status='failed', returncode=127, error=str(error))
            log.write(str(error) + '\n')
        except (KeyboardInterrupt, GateInterrupted) as error:
            if process is not None:
                stop_process_group(process)
            code = 128 + error.signum if isinstance(error, GateInterrupted) else 130
            result.update(status='interrupted', returncode=code)
        finally:
            signal.signal(signal.SIGTERM, previous_sigterm)
    if result['returncode'] == 0 and not has_nonempty_suite_result(check['id'], log_path.read_text(errors='replace')):
        reason = 'Suite exited zero without a nonempty passing test summary'
        result.update(status='failed', returncode=1, commandReturncode=0, error=reason)
        with log_path.open('a') as log:
            log.write(reason + '\n')
    result.update(completedAt=now(), durationSeconds=round(time.monotonic() - started, 3))
    print(f'{check["id"]}: {result["status"]} (exit {result["returncode"]}; {log_path})', flush=True)
    if result['returncode']:
        print('\n'.join(log_path.read_text(errors='replace').splitlines()[-35:]), flush=True)
    return result


def write_report(path, report, manifest):
    report['quality'] = score(manifest, report['results'])
    # Replace atomically so interrupted runs cannot leave a half-written JSON file.
    temporary = path.with_name(path.name + '.' + report['runId'] + '.tmp')
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--validate', action='store_true')
    mode.add_argument('--list', action='store_true')
    mode.add_argument('--all', action='store_true', help='run every unique check and enforce the complete gate')
    mode.add_argument('--run', nargs='+', metavar='CHECK', help='diagnostic subset; does not certify the complete gate')
    parser.add_argument('--output', type=Path, default=Path('/tmp/crazyacade-quality'))
    args = parser.parse_args()
    manifest = json.loads((ROOT / 'scripts/quality-gates.json').read_text())
    validate_manifest(manifest, ROOT)
    if args.validate:
        print(f'Valid manifest: {len(manifest["categories"])} categories, {len(manifest["checks"])} checks; no checks executed and no score awarded.')
        return 0
    if args.list:
        for check in manifest['checks']:
            print(f'{check["id"]}: {json.dumps(check["argv"])}')
        return 0
    selected = set(args.run or [check['id'] for check in manifest['checks']])
    unknown = selected - {check['id'] for check in manifest['checks']}
    if unknown:
        parser.error(f'Unknown check IDs: {sorted(unknown)}')
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:8]
    directory = args.output / run_id
    directory.mkdir(parents=True)
    revision = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True, capture_output=True)
    report = {'schemaVersion': 1, 'runId': run_id, 'startedAt': now(), 'complete': False,
              'scope': 'local engineering acceptance; not a production SLA or a human fun/aesthetic score',
              'revision': revision.stdout.strip() if revision.returncode == 0 else None,
              'workingTreeModified': bool(subprocess.run(['git', 'status', '--porcelain'], cwd=ROOT, text=True, capture_output=True).stdout.strip()),
              'manifestSha256': hashlib.sha256((ROOT / 'scripts/quality-gates.json').read_bytes()).hexdigest(),
              'mode': 'full' if args.all else 'diagnostic-subset', 'results': []}
    report_path = directory / 'report.json'
    def publish_report():
        write_report(report_path, report, manifest)
        write_report(args.output / 'report.json', report, manifest)
    publish_report()
    exit_code = 0
    for check in manifest['checks']:
        if check['id'] not in selected:
            continue
        completed = {result['id'] for result in report['results'] if result['returncode'] == 0}
        dependencies_missing = set(check.get('dependsOn', [])) - completed
        if dependencies_missing:
            log_path = directory / f'{check["id"]}.log'
            log_path.write_text(f'Blocked: dependencies did not pass in this invocation: {sorted(dependencies_missing)}\n')
            result = {'id': check['id'], 'status': 'blocked', 'returncode': 125, 'log': str(log_path),
                      'missingDependencies': sorted(dependencies_missing)}
            print(log_path.read_text(), flush=True)
        else:
            result = execute_check(check, ROOT, directory)
        report['results'].append(result)
        publish_report()
        # Finish independent checks after failure so the retained score explains coverage.
        if not exit_code and result['returncode']:
            exit_code = result['returncode'] if result['returncode'] > 0 else 128 - result['returncode']
        if result['status'] == 'interrupted':
            break
    report.update(complete=True, completedAt=now())
    publish_report()
    print(json.dumps({'report': str(report_path), 'score': report['quality']['score'],
                      'fullGatePassed': report['quality']['passed'], 'mode': report['mode']}), flush=True)
    if args.all and not report['quality']['passed']:
        exit_code = exit_code or 1
    return min(exit_code, 255)


if __name__ == '__main__':
    raise SystemExit(main())
