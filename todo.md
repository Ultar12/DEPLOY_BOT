
# Reported Bug Fixes

- [x] Remove unwanted backslashes from expiry alert text such as `marcubot1\\-7c28`.
- [x] Make `/restoreall` follow the same restore logic as `/bapp restore`.
- [x] Fix admin bot menus that show `N/A days left` when a valid expiry value exists.
- [x] Add regression checks for alert formatting, restoreall parity, and expiry display fallback behavior.

# Branch Correction

- [x] Identify the exact free verification remote branch.
- [x] Move and validate the three bug fixes on the free verification branch.
- [x] Commit and push the fixes to that branch.

# Free Trial Verification Branch Audit

- [ ] Audit `free-trial-verification` against `main` without treating `main` as authoritative.
- [ ] Run syntax checks across every JavaScript module on `free-trial-verification`.
- [ ] Run dependency and available regression checks on `free-trial-verification`.
- [ ] Inspect branch-only code paths and report findings.

# Audit Findings

- [x] Audit `free-trial-verification` against `main` without treating `main` as authoritative.
- [x] Run syntax checks across every JavaScript module on `free-trial-verification`.
- [x] Run dependency and available regression checks on `free-trial-verification`.
- [x] Inspect branch-only code paths and report findings.
- [ ] Fix genuine undefined runtime symbols found by static analysis, including `triggerRestoreLogic`, `extractVariableFromMessage`, `extractValueFromMessage`, `checkFreeTrialEligibility`, `generateCountryVcf`, and `handleGroupCommand`.
- [ ] Fix the undefined `cid` in the `/welcome set` group handler.
- [ ] Remove the duplicate `backupAllPaidBots` export and formalize undeclared shared variables in `bot_services.js`.

# New Requested Changes

- [x] Remove VCF generation and related user/admin menu flows.
- [x] Remove the free-trial flow and related eligibility, monitoring, and messaging behavior.
- [x] Trace and fix every expiry alert formatter so ordinary hyphens never render with backslashes.
- [x] Trace and fix every bot menu expiry formatter so valid expiry data never falls back to N/A.
- [x] Add regression coverage for all expiry formatter paths and removed-feature behavior.

# Expanded Whole-Codebase Scope

- [x] Inventory every backslash escape helper and every template/string path that can emit a literal backslash.
- [x] Inventory every `N/A` fallback and replace user-facing bot/config/expiry displays with accurate data or an explicit unavailable state.
- [x] Verify VCF and free-trial references are removed from commands, menus, schedulers, services, and user-facing copy.

# Final Commit and Push Request

- [ ] Confirm the latest intended changes are committed and pushed to `free-trial-verification`.

# Branch Merge Request

- [ ] Merge `free-trial-verification` into `main` and push the updated `main` branch.

# Dependency Update

- [x] Inspect all dependency manifests and available upgrades on `main`.
- [x] Update all declared dependencies and refresh the lockfile.
- [x] Run syntax, regression, and dependency integrity checks.
- [x] Commit and push the validated dependency update to `main`.

# Startup Regression Repair

- [x] Restore the missing `addReferralAndSecondLevelReward` implementation removed by the oversized cleanup edit.
- [x] Validate `bot_services.js` and `bot.js` module loading plus regression tests.
- [x] Synchronize the startup fix to both `main` and `free-trial-verification`.

# Telegram Constructor Regression

- [x] Inspect `node-telegram-bot-api` 2.x export shape and the current constructor import.
- [x] Patch TelegramBot constructor compatibility and validate startup loading.
- [x] Synchronize the constructor fix to both `main` and `free-trial-verification`.

# Deployment Process Audit

- [x] Trace the end-to-end user deployment flow from command/menu through payment, key validation, build, persistence, and status feedback.
- [x] Evaluate provider API usage, configuration validation, database persistence, retries, rollback, and recovery behavior.
- [x] Assess deployment security, idempotency, observability, and user-facing professionalism.
- [x] Produce prioritized recommendations and an implementation roadmap.

# Log Stop and Mini App Expansion

- [x] Persist the user’s stopped-log-stream state so reopening a bot log does not restart streaming unexpectedly.
- [x] Extend deploy-bot-dashboard with an authorized mini app deployment and bot-management workflow.
- [x] Add or update tests for log-stream state persistence and dashboard deployment actions.

# Telegram WebApp and Clean Conversation Upgrade

- [ ] Audit current temporary-message creation, editing, deletion, and task-completion paths.
- [ ] Audit Express static serving and existing mini-app/web endpoints.
- [ ] Add reusable Telegram message cleanup helpers and apply them to key user workflows.
- [x] Add secure Telegram WebApp init-data validation using the bot token and Telegram user ID scoping.
- [x] Add the mini-app source inside this repository and serve it from the bot app URL.
- [x] Add user-scoped mini-app API endpoints for dashboard, deployment, bot actions, logs, and support.
- [x] Add tests for message cleanup, WebApp authentication, user scoping, and mini-app API contracts.
- [x] Commit and push the implementation to both `main` and `free-trial-verification`.

# Deployment Jobs, Payments, and Mini App URL

- [x] Add durable deployment job records with job IDs and status/progress retrieval.
- [x] Let deployment proceed through either a valid deploy key or payment gateway checkout.
- [x] Validate session ID format and app name format before accepting deployment requests.
- [x] Add user ownership checks to deployment-job status and action endpoints.
- [x] Replace support placeholder with `@staries1`.
- [x] Serve the mini app explicitly at `/miniapp` and verify the Telegram WebApp button URL format.
- [x] Add tests for job IDs, validation, payment/key branching, support link, and `/miniapp` routing.

# Mini App Deployment Wizard and Dashboard Refinement

- [x] Diagnose the generic deployment-job creation failure path and return actionable user-safe errors.
- [x] Add live server-backed checks for app name, session ID, and deploy key with green/red UI states.
- [x] Add Save and Next wizard controls before revealing key deployment or payment options.
- [x] Reuse the authenticated user's database email and ask only when no email exists.
- [x] Start deployment automatically after verified payment and preserve the job ID.
- [x] Rename user-facing deployment copy to avoid provider/infrastructure branding.
- [x] Add a per-bot menu button with management actions.
- [x] Show days remaining beside each subscription status.
- [x] Add regression tests and visual/syntax checks for the revised wizard and dashboard.

# Verified-Email Checkout and Chat Cleanup

- [x] Diagnose and remove the remaining generic mini-app deployment-job creation failure.
- [x] Remove the manual email field and use only the user’s verified database email for payment.
- [x] Show payment only when the deploy-key field is empty; show immediate deployment only after a key validates.
- [x] Redirect a keyless user to the generated payment URL and start the job only from verified payment confirmation.
- [x] Add safe cleanup of private user command messages where deletion is permitted.
- [x] Reuse or replace prior bot menu/status messages instead of accumulating new messages.
- [x] Add regression checks for verified-email checkout and safe message cleanup.
