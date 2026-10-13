# W14 copy review regression acceptance

Scope: `feat/htc-250-copy-acceptance`, based on `fa441f5`. Offline temporary-workspace tests only; no production workspace, real provider, push or deployment.

## Root causes and changes

- Explicit candidate rechecks reused a completed A19 chain forever. The existing newer-negative-review regression failed because the old PASS was returned without another request. `ListingAiService.review` now explicitly requests a fresh completed chain. The trusted `AiService.listingFields` default remains resume-only.
- Task-owned review replays must never interpret that flag as a new user action. Candidate and current-copy paths suppress fresh-chain creation in `taskAiContext`; Completion calls also retain their original completion identity. A new current-copy Batch fake test failed with an unexpected third `BatchWaitingError` before the fix and passed after it.
- Finished chains retain their original first/second results, frozen routing, owners and usage. Unfinished or unknown chains keep the existing no-resend behavior. No changes were made to prices, manual handling, unknown-state gates, ownership validation or upgrade budgets.

## Fixture corrections

- Copy repair tests now locate the repair payload by its purpose rather than assuming it follows one current review. They count the real ordinary and upgraded negative reviews.
- Native JSON repair receives two actual negative reviews before repair, preserving A19 upgrade behavior and the native-value invariant.
- Omission-budget coverage uses an ordinary editorial rejection without factual uncertainty, isolating omission retries from the separately tested A19 upgrade budget.
- Historical diagnostic-only recovery removes the newer provider receipt pointer along with response/rejection flags; the old fixture otherwise still had independent proof of receipt.
- Legacy theme and image color-resume fixtures establish real eligible Haul pricing before testing downstream scope/owner behavior. No price guard is stubbed or bypassed.

## Evidence

- Assigned seven suites plus A19, Batch integration/runtime, Batch transport/recovery/accounting and purpose-routing suites were run together.
- Candidate explicit recheck: separate result/call identity and a third real fake request; newer NEEDS_CHANGES blocks adoption of the earlier PASS, which remains unchanged.
- Candidate and current-copy Batch tests replay with `waitingOperationId` three times concurrently, then reconcile and flush. Calls, results, usage, Batch adoption records and review-chain JSON remain byte-for-byte unchanged; original pairs remain the only paid review attempts.
- Existing A19 tests continue to cover frozen targets, missing targets, interruption, unknown responses, rollback, ownership corruption, completion budget and final-adoption restart.

Final verification (2026-10-14): **119/119 tests passed**, `npm run typecheck` exited 0, and `git diff --check` passed.

```powershell
node --test tests/listing-ai-adoption.test.ts tests/listing-copy-repair.test.ts tests/listing-local-recovery.test.ts tests/listing-native-value-paths.test.ts tests/listing-review-omission.test.ts tests/legacy-theme-repair.test.ts tests/plain-color-resume.test.ts tests/copy-review-upgrade.test.ts tests/batch-copy-review-integration.test.ts tests/task-batch-runtime.test.ts tests/openrouter-batch.test.ts tests/ai-batch-recovery.test.ts tests/ai-batch-accounting.test.ts tests/ai-purpose-routing.test.ts
npm run typecheck
git diff --check
```
 Local diagnostic logs: `.test-data-copy-verification.log`, `.test-data-current-batch-red.log`, `.test-data-current-batch-green.log` (ignored test artifacts).
