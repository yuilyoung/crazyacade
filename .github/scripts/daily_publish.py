#!/usr/bin/env python3
"""Trusted post-validation checks. Never execute proposal code in a write-token job."""
import argparse
from datetime import datetime, timezone
import json
import os
import re
import subprocess
import time
import urllib.request

SHA = re.compile(r'^[0-9a-f]{40}$')

def verify_base(expected, actual):
    if not SHA.fullmatch(expected) or expected != actual:
        raise ValueError('main changed since validation; refusing publication')
    return actual

def find_ci_run(runs, sha, since):
    for run in runs:
        if (run.get('head_sha') == sha and run.get('head_branch') == 'main'
                and run.get('event') == 'workflow_dispatch' and run.get('created_at', '') >= since
                and isinstance(run.get('id'), int)):
            return run['id']
    return None

def render_live(records, sha):
    return any(item.get('deploy', {}).get('status') == 'live'
               and item.get('deploy', {}).get('commit', {}).get('id') == sha for item in records)

def gh(*arguments):
    # No secrets in arguments. gh reads GH_TOKEN from its supported environment.
    return subprocess.check_output(['gh', *arguments], text=True).strip()

def check_render_config():
    service = os.environ.get('RENDER_SERVICE_ID', '')
    if not re.fullmatch(r'srv-[a-z0-9]+', service) or not os.environ.get('RENDER_API_KEY'):
        raise ValueError('Configure RENDER_SERVICE_ID variable and RENDER_API_KEY secret in GitHub Actions')
    return service

def wait_for_deploy(repository, sha, timeout=1500):
    if not SHA.fullmatch(sha):
        raise ValueError('Invalid deployment SHA')
    service = check_render_config()
    since = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    gh('api', '--method', 'POST', f'repos/{repository}/actions/workflows/ci.yml/dispatches', '-f', 'ref=main')
    deadline = time.monotonic() + timeout
    run_id = None
    while time.monotonic() < deadline:
        runs = json.loads(gh('api', f'repos/{repository}/actions/workflows/ci.yml/runs?event=workflow_dispatch&per_page=30'))['workflow_runs']
        run_id = find_ci_run(runs, sha, since)
        if run_id:
            run = json.loads(gh('api', f'repos/{repository}/actions/runs/{run_id}'))
            if run.get('status') == 'completed':
                if run.get('conclusion') != 'success':
                    raise RuntimeError(f'CI {run_id} failed; deployment is not confirmed')
                break
        # A newer main before dispatch selects it: fail instead of certifying a different commit.
        current = json.loads(gh('api', f'repos/{repository}/git/ref/heads/main'))['object']['sha']
        if current != sha and not run_id:
            raise RuntimeError('main advanced before exact-SHA CI dispatch; deployment is not confirmed')
        time.sleep(15)
    else:
        raise TimeoutError('Exact-SHA CI did not succeed before timeout')
    print(f'CI {run_id} passed for {sha}')
    # Render checksPass is responsible for triggering the deployment. This is verification only.
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        request = urllib.request.Request(f'https://api.render.com/v1/services/{service}/deploys?limit=20',
            headers={'Authorization': 'Bearer ' + os.environ['RENDER_API_KEY'], 'Accept': 'application/json'})
        with urllib.request.urlopen(request, timeout=30) as response:
            deployments = json.load(response)
        if render_live(deployments, sha):
            print(f'Render live deployment verified for {sha}')
            return
        for item in deployments:
            deploy = item.get('deploy', {})
            if deploy.get('commit', {}).get('id') == sha and deploy.get('status') in {'build_failed','update_failed','canceled','deactivated'}:
                raise RuntimeError('Render deployment failed; inspect the service Events')
        time.sleep(20)
    raise TimeoutError('Matching live Render deployment was not observed')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check-base')
    parser.add_argument('--preflight', action='store_true')
    parser.add_argument('--sha')
    args = parser.parse_args()
    if args.preflight:
        check_render_config()
    elif args.check_base:
        result = gh('api', f'repos/{os.environ["GITHUB_REPOSITORY"]}/git/ref/heads/main')
        verify_base(args.check_base, json.loads(result)['object']['sha'])
    elif args.sha:
        wait_for_deploy(os.environ['GITHUB_REPOSITORY'], args.sha)
    else:
        parser.error('Choose --preflight, --check-base or --sha')

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Do not include provider bodies or headers in logs.
        raise SystemExit(f'Daily publish stopped: {type(error).__name__}: {error}')
