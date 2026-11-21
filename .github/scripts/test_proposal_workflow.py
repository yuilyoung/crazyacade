from pathlib import Path
import re
import unittest


WORKFLOW = (Path(__file__).resolve().parents[1] / 'workflows' / 'ai-roles.yml').read_text()


def job(name):
    return re.search(rf'^  {name}:\n(.*?)(?=^  [\w-]+:|\Z)', WORKFLOW, re.M | re.S).group(1)


class ProposalValidationTests(unittest.TestCase):
    def test_full_gate_runs_on_guarded_proposal_before_publication(self):
        validate = job('validate')
        steps = [
            'python3 .github/scripts/ai_changes.py /tmp/ai-proposal/proposal.json --stage',
            'run: python3 scripts/check-quality-gates.py --all',
            'cmp /tmp/proposed.patch /tmp/tested.patch',
        ]
        positions = [validate.index(step) for step in steps]
        self.assertEqual(positions, sorted(positions))
        self.assertNotIn('continue-on-error', validate)
        for publisher in ['draft-pr', 'daily-publish']:
            with self.subTest(publisher=publisher):
                self.assertIn('needs: [propose, validate]', job(publisher))
                self.assertIn("needs.validate.result == 'success'", job(publisher))

    def test_scheduled_mode_comes_from_the_event(self):
        self.assertIn("AI_MAINTENANCE: ${{ github.event_name == 'schedule' }}", job('propose'))
        self.assertIn("--stage ${{ github.event_name == 'schedule' && '--require-regression' || '' }}", job('validate'))
        self.assertIn('proposal.json --stage --require-regression', job('daily-publish'))
        self.assertNotIn('--require-regression', job('draft-pr'))
