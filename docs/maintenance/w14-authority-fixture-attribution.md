# W14 authority/execution fixture attribution

Base: `a7019b6`, branch `feat/htc-250-authority-acceptance`.

This change repairs synthetic test setup only. No production pricing, fact authority, preview, or submission guards change. All Haul scenarios remain Haul. No tests are skipped and existing behavioral assertions remain intact.

## Baseline

The five-file offline run reproduced 12 failures out of 105 tests (`.test-data/w14-authority-before.log`).

| Area | Failures | Cause and correction |
| --- | ---: | --- |
| execution | 3 | Cleanup/preview/color scenarios changed the program to Haul without a current pricing decision. Seed confirmed synthetic CNY cost and package facts, production-generated quote and actual offer before creating the task. Preserve owned revision, upload and preview assertions. |
| fallback fact boundary | 3 | Current report is v3; v2 tests were still using current output, one draft omitted its Haul program, and illegal-version mutation used now-valid v3. Explicitly strip dependencies to construct v2 history, declare Haul, and reject version 99. |
| fallback adoption | 1 | Historical AI response uses the legacy field contract, and the Haul draft lacked pricing. Use explicit legacy context for this case and seed pricing. Unsupported brand must still remain blocked after material adoption. |
| generic brand resume | 3 | Two platform-dispute cases lacked a quote; ACTIVE review preparation used a legacy response under full-schema context. Seed pricing and use legacy context only for the candidate/review journal compatibility cases. Retain manual handling and no additional paid calls. |
| legacy fact owner | 1 | Image workflow stopped at pricing before reaching the intended cached-DONE checkpoint. Seed pricing before creating the original completion operation; retain original operation ID, slots, interruption and zero-request assertions. |
| full-schema adoption | 1 | The Haul draft had only offer audience/marketplace and no pricing decision. Seed a complete actual offer and quote; retain full-schema production context, raw response, unsupported field omission and idempotency assertions. |

## Fixture integrity

`tests/helpers/authority-haul-pricing.ts` persists CNY 2.4 purchase cost and confirmed synthetic 5 cm package axes / 100 g weight through WorkspaceStore, renews source consistency for the new product revision, and invokes real `applyBusinessRules` with current stored rules. It copies only pricing fields so unrelated legacy authority failures survive, verifies `quoted` plus `assertCurrentPricingForPaid`, and supplies a self-contained package schema with a matching checksum and offline schema fetch. It does not stub pricing qualification or fabricate a pricing decision.

## Verification

- `node --test tests/execution.test.ts tests/fallback-fact-boundary.test.ts tests/generic-brand-resume.test.ts tests/listing-full-schema.test.ts tests/legacy-fact-authority-resume.test.ts`: 105 passed, 0 failed, 0 skipped.
- `npm run typecheck`: passed.
- `git diff --check`: passed.
- Logs: `.test-data/w14-authority-final.log`, `.test-data/w14-authority-types.log` (local ignored artifacts).

All service responses are existing offline fakes and all databases/files are synthetic temporary fixtures. No real service, formal database, push or deployment was used. Other W14 source-consumer work must rerun this suite after integration.
