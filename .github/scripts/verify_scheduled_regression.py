"""Verify scheduled regression tests against HEAD and the staged proposal in the read-only CI job."""
from collections import Counter
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tarfile
import tempfile
import time


# The Node runner supplies structured test events separately from test stdout/stderr.
REPORTER = """\
import {relative} from 'node:path';
export default async function* (events) {
  const files = new Map();
  for await (const {type, data} of events) {
    // IDs join events within one entry file. Names and declarations identify cases across runs.
    if (type === 'test:enqueue' && data.entryFile) {
      if (!files.has(data.entryFile)) files.set(data.entryFile, new Map());
      const nodes = files.get(data.entryFile);
      const parent = data.parentId === 0 ? [] : nodes.get(data.parentId);
      if (parent && !nodes.has(data.testId)) {
        const location = [relative(process.cwd(), data.file), data.name, data.line, data.column];
        const lineage = [...parent, location];
        nodes.set(data.testId, lineage);
        yield JSON.stringify(['registered', relative(process.cwd(), data.entryFile), ...lineage]) + '\\n';
      }
      continue;
    }
    if (!['test:pass', 'test:fail'].includes(type)) continue;
    const {error} = data.details;
    const lineage = files.get(data.entryFile)?.get(data.testId);
    const named = data.file === data.entryFile && data.details.type === 'test'
      && data.name && data.name !== '<anonymous>';
    const assertion = error?.failureType === 'testCodeFailure'
      && error.cause?.code === 'ERR_ASSERTION' && error.cause?.name === 'AssertionError';
    const ignored = data.skip || data.todo || error?.failureType === 'subtestsFailed';
    if (ignored && !named) continue;
    const status = ignored ? 'ignored' : type === 'test:pass' ? 'pass' : assertion ? 'assertion' : 'error';
    if (named || type === 'test:fail') {
      yield JSON.stringify([named && lineage ? status : 'error', relative(process.cwd(), data.file ?? ''),
        ...(lineage ?? [])]) + '\\n';
    }
  }
}
"""


def git(root, *args):
    return subprocess.check_output(['git', *args], cwd=root)


def snapshot(root, revision, target):
    archive = target.with_suffix('.tar')
    git(root, 'archive', '--format=tar', '-o', str(archive), revision)
    with tarfile.open(archive) as source:
        source.extractall(target, filter='data')
    shutil.copytree(root / 'Server/node_modules', target / 'Server/node_modules')


def run_cases(directory, reporter, paths, timeout):
    command = ['node', '--test', '--test-concurrency=1', '--test-timeout=30000',
               f'--test-reporter={reporter}', *paths]
    with subprocess.Popen(command, cwd=directory, stdout=subprocess.PIPE, text=True,
                          start_new_session=True) as process:
        try:
            output, _ = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
            raise ValueError('Regression tests timed out')
        events = [json.loads(line) for line in output.splitlines()]
        return process.returncode, events


def run_phase(tree, reporter, paths):
    deadline = time.monotonic() + 120
    results = []
    exit_code = 0
    for cwd, prefix in [(tree / 'Server', 'Server/'), (tree, 'Assets/')]:
        group = [str((tree / name).relative_to(cwd)) for name in paths if name.startswith(prefix)]
        if group:
            status, events = run_cases(cwd, reporter, group, deadline - time.monotonic())
            if status not in (0, 1):
                raise ValueError(f'Node regression runner exited with status {status}')
            exit_code = max(exit_code, status)
            for result, file, *lineage in events:
                results.append((result, str(cwd.relative_to(tree) / file), *map(tuple, lineage)))
    return exit_code, results


def verify(root):
    paths = []
    test_additions = []
    for name in git(root, 'diff', '--cached', '--diff-filter=A', '--name-only', '-z',
                    '--no-renames').decode().split('\0'):
        path = Path(name)
        if name.startswith(('Server/test/', 'Assets/Tests/')):
            test_additions.append(name)
        if ((path.parent == Path('Server/test') and name.endswith('.test.js'))
                or (path.parent == Path('Assets/Tests') and name.endswith('.test.cjs'))):
            paths.append(name)
    if not paths:
        raise ValueError('No new Node regression tests were staged')
    with tempfile.TemporaryDirectory() as directory:
        work = Path(directory)
        reporter = work / 'reporter.mjs'
        reporter.write_text(REPORTER)
        baseline, proposal = work / 'baseline', work / 'proposal'
        snapshot(root, 'HEAD', baseline)
        snapshot(root, git(root, 'write-tree').decode().strip(), proposal)
        # New fixtures and helpers belong to the regression input on both revisions.
        for name in test_additions:
            source, target = proposal / name, baseline / name
            if source != source.resolve() or not source.is_file() or target != target.resolve():
                raise ValueError(f'Expected a regular staged test file: {name}')
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        red_status, red = run_phase(baseline, reporter, paths)
        if red_status != 1 or any(event[0] == 'error' for event in red):
            raise ValueError('Baseline must fail on a named assertion without setup or runner errors')
        failures = {tuple(case) for status, *case in red if status == 'assertion'}
        if not failures:
            raise ValueError('No new test recorded an assertion failure on the baseline')
        green_status, green = run_phase(proposal, reporter, paths)
        passes = {tuple(case) for status, *case in green if status == 'pass'}
        if green_status != 0 or not failures.issubset(passes):
            raise ValueError('Each baseline assertion failure must pass in the same test on the staged proposal')
        # Each prefix identifies one registered node, from the outer suite to the assertion.
        # A duplicated suite can register different children on the two revisions.
        for phase in [red, green]:
            registrations = Counter(tuple(case) for status, *case in phase if status == 'registered')
            for case in failures:
                if any(registrations[case[:end]] != 1 for end in range(2, len(case) + 1)):
                    raise ValueError('Each regression and its ancestor suites must be uniquely identifiable')
        if not set(paths).issubset(case[0] for case in passes):
            raise ValueError('Each new regression file must run a named passing test')
        print(f'Confirmed {len(failures)} regression case(s) across {len(paths)} new test file(s).')


if __name__ == '__main__':
    try:
        verify(Path.cwd())
    except ValueError as error:
        raise SystemExit(str(error))
