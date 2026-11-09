# Email signup response compatibility (2026-11-09)

With email confirmation enabled, raw Supabase Auth `POST /auth/v1/signup` returns HTTP 200 with a top-level User object (`id`, `email`, metadata). Autoconfirm instead returns an access/refresh token response with a nested user. The browser treated a successful top-level user as `signup_failed`, displaying the same generic failure reported by the user.

Official reference: [Supabase Auth v2.177.0 signup handler](https://github.com/supabase/auth/blob/v2.177.0/internal/api/signup.go#L339). This is the raw HTTP API, not the supabase-js return wrapper. The previous Node and browser protocol fixtures incorrectly wrapped the confirmation response as `{user}` and missed the incompatibility.

The client now recognizes a valid confirmation-pending user without creating a session. Token responses still require a complete valid member session; anonymous or malformed responses are rejected. The prior wrapped response remains compatible.

Before the fix, the corrected raw-response Node test failed with `signup_failed`, and Chromium displayed `가입을 완료하지 못했어요. 입력 내용을 확인하거나 잠시 후 다시 시도해 주세요.` instead of the confirmation notice. The browser fixture now sends the actual top-level response shape. This verifies response handling locally; it does not verify delivery of a real Supabase email.

The separately reported `/health/services` failure is not established by this client bug. Render's configured readiness path remains `/health/ready`. Official PostgREST v12.2.12, v13.0.7 and v14.0 RPC metadata use inline body parameters compatible with the current probe; no unsupported metadata change was made without a failing response. The public service's status JSON is still needed to distinguish configuration, Auth settings, missing schema and provider errors.

Validation after the fix: all 658 Node tests passed, including 11 account-client tests; the real Chromium/local GoTrue protocol fixture passed all 9 member-flow checkpoints. Independent code review found no blockers. Real deployment, email delivery and the public health result remain unverified.
