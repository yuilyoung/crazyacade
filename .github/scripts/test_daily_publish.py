import unittest
import daily_publish as daily

class DailyPublishTests(unittest.TestCase):
    def test_base_must_be_exact_and_valid(self):
        sha='a'*40
        self.assertEqual(daily.verify_base(sha,sha),sha)
        for actual in ['b'*40,'',sha+'bad']:
            with self.assertRaises(ValueError): daily.verify_base(sha,actual)
    def test_ci_must_be_new_dispatch_for_exact_sha_on_main(self):
        good={'id':10,'head_sha':'a'*40,'head_branch':'main','event':'workflow_dispatch','created_at':'2026-11-17T00:01:00Z'}
        self.assertEqual(daily.find_ci_run([good],'a'*40,'2026-11-17T00:00:00Z'),10)
        for change in [{'head_sha':'b'*40},{'event':'push'},{'head_branch':'other'},{'created_at':'2026-11-16T00:00:00Z'}]:
            self.assertIsNone(daily.find_ci_run([{**good,**change}],'a'*40,'2026-11-17T00:00:00Z'))
    def test_render_requires_live_deployment_of_exact_sha(self):
        live={'deploy':{'status':'live','commit':{'id':'a'*40}}}
        self.assertTrue(daily.render_live([live],'a'*40))
        self.assertFalse(daily.render_live([live],'b'*40))
        self.assertFalse(daily.render_live([{'deploy':{'status':'build_failed','commit':{'id':'a'*40}}}],'a'*40))
