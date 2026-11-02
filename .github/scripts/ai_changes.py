#!/usr/bin/env python3
"""Guard and apply the narrowly scoped file proposal produced by an AI role.
No proposed code is executed by this script. Run tests in a separate job.
"""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import subprocess

ALLOWED = ('Server/src/', 'Server/public/', 'Server/test/', 'Assets/Scripts/', 'Assets/Tests/', 'docs/Design/', 'docs/Architecture/')
EXTENSIONS = {'.js', '.cjs', '.mjs', '.cs', '.html', '.css', '.svg', '.json', '.md'}
MAX_FILES = 20
MAX_BYTES = 300_000


def validate(proposal, root):
    if not isinstance(proposal, dict) or not isinstance(proposal.get('summary'), str):
        raise ValueError('Proposal requires a summary string')
    changes = proposal.get('changes')
    if not isinstance(changes, list) or len(changes) > MAX_FILES:
        raise ValueError('Proposal changes must be an array with at most 20 files')
    root = Path(root).resolve()
    seen, total = set(), 0
    approved = []
    for change in changes:
        if not isinstance(change, dict) or set(change) != {'path', 'content'}:
            raise ValueError('Each change must contain only path and content')
        name, content = change['path'], change['content']
        if not isinstance(name, str) or not isinstance(content, str):
            raise ValueError('Path and content must be strings')
        path = PurePosixPath(name)
        if not name or '\\' in name or ':' in name or '\0' in name or path.is_absolute() or str(path) != name:
            raise ValueError('Invalid relative path')
        if any(part in {'.', '..'} or part.startswith('.') for part in path.parts):
            raise ValueError('Hidden paths and traversal are forbidden')
        if not name.startswith(ALLOWED) or path.suffix not in EXTENSIONS:
            raise ValueError('Path is outside the permitted source/test/document scope')
        if name in seen:
            raise ValueError('Duplicate file path')
        seen.add(name)
        total += len(content.encode('utf-8'))
        if total > MAX_BYTES:
            raise ValueError('Proposal exceeds content size limit')
        target = root / name
        if any(parent.is_symlink() for parent in (target, *target.parents) if parent != root.parent):
            raise ValueError('Symlinks are forbidden')
        if not target.resolve().is_relative_to(root):
            raise ValueError('Resolved target escapes repository')
        if target.exists() and not target.is_file():
            raise ValueError('Target is not a file')
        approved.append((name, target, content))
    return approved


def apply(proposal, root):
    # Validate the entire proposal before writing anything.
    approved = validate(proposal, root)
    for _, target, content in approved:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding='utf-8')
    return [name for name, _, _ in approved]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('proposal')
    parser.add_argument('--root', default='.')
    parser.add_argument('--stage', action='store_true')
    args = parser.parse_args()
    proposal = json.loads(Path(args.proposal).read_text(encoding='utf-8'))
    files = apply(proposal, args.root)
    if args.stage and files:
        subprocess.run(['git', 'add', '--', *files], cwd=args.root, check=True)
    print(f'Validated {len(files)} proposed source files')


if __name__ == '__main__':
    main()
