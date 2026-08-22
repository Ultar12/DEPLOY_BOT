
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

# Flutterwave Checkout and Live Validation Refinement

- [x] Change unavailable or taken app-name feedback to “Name already exists, use another name.”
- [x] Trigger app name, session ID, and deploy key validation while users type, using debounced requests.
- [x] Remove the saved-email explanatory copy from the payment option.
- [x] Replace mini-app Paystack checkout creation with Flutterwave checkout.
- [x] Update verified Flutterwave completion to start the associated deployment job exactly once.
- [x] Add regression coverage for Flutterwave checkout and typing-triggered validation.

# Payment Plan Selection and Deployment Conversation Cleanup

- [x] Add payment-plan buttons that visually mark the selected plan before showing Pay and Deploy.
- [x] Keep deploy-key deployment on its fixed 30-day entitlement without showing payment plans.
- [x] Persist the selected plan amount and duration in the payment and deployment job records.
- [x] Return Flutterwave payment users to the mini-app deployment-progress page for their job.
- [x] Keep the Telegram reply keyboard visible after deployment, cancellation, and main-menu transitions.
- [x] Delete or replace stale deployment prompts, old session messages, and cancellation messages shown in the deployment flow.
- [x] Add regression coverage for plans, tracking return, reply-keyboard persistence, and targeted cleanup.

# Mini-App Offline Recovery, Lifecycle Controls, and Progress Polish

- [x] Show Change Session beside Menu for offline bots only and validate the new session against the bot type.
- [x] Persist a valid replacement session and restart the affected offline bot safely.
- [x] Show configuration values in the mini app rather than masking them.
- [x] Add Redeploy and Turn Off lifecycle actions with ownership checks.
- [x] Rename user-facing job language to Deploy ID and Processing.
- [x] Add real progress updates beyond 25 percent during deployment build and completion steps.
- [x] Add a glowing blue Create a new bot call-to-action.
- [x] Add regression coverage for session recovery, lifecycle actions, visible config, and progress stages.

# Deploy-Key Notification, Stable Keyboard, and Dashboard CTA Refinement

- [x] Restore the user notification when a deploy key is consumed through the mini app.
- [x] Reapply the persistent reply keyboard after private message cleanup so it does not depend on /start.
- [x] Remove the session-type validation helper text from the Change Session prompt.
- [x] Move Create a new bot above the bot list and animate its blue glow in a circular motion.
- [x] Add regression coverage for key-use notification, keyboard resilience, and CTA placement and animation.

# My Bots Synchronization and Primary Keyboard Flow Repair

- [x] Diagnose and fix the My Bots synchronization stall.
- [x] Change the synchronization copy to “Syncing your bots...”.
- [x] Restore the reply keyboard explicitly after Deploy, Get Session ID, My Bots, and related primary button flows.
- [x] Replace the directional glow with a true circular-orbit CTA animation.
- [x] Add regression coverage for synchronization completion, primary keyboard restoration, and circular glow behavior.

# Interaction Flow Rollback and Safe Bot-Button Edits

- [x] Restore the prior static deployment CTA without animated glow.
- [x] Remove the recent automatic private-message deletion and keyboard-anchor behavior.
- [x] Remove the “Menu is ready below.” message.
- [x] Prevent unhandled message-not-editable errors in user-bot button flows.
- [x] Verify My Bots and primary user-bot button loading after the rollback.
- [x] Add regression coverage for non-destructive flow and safe edit fallback.

# Live Logs and Provider-Key Recovery

- [x] Simplify Change Session failures to concise invalid-session feedback.
- [x] Replace manual log refreshing with automatically appended live log updates.
- [x] Audit database key storage, invalid-key detection, deploy TLS commands, silentrestore, and restore-all capabilities.
- [x] Define a bounded, idempotent provider-key recovery workflow with administrator notification and recovery locking.
- [x] Add regression coverage for concise validation feedback and live-log updating.

- [x] Run the TLS deployment automatically after a verified replacement provider key is activated.
- [x] Start the established mass restore automatically after successful TLS deployment, with no confirmation prompt.
- [x] Preserve recovery locking, administrator notifications, database key retirement, and failure-safe maintenance mode.
- [x] Add regression coverage for the approved automatic full recovery order.

# Silent Recovery and Administrator Recovery Controls

- [x] Keep provider-key recovery rebuild activity silent to ordinary bot owners.
- [x] Add an administrator Enter New Key button when no verified replacement key exists.
- [x] Ensure TLS Message Bot, Scraper Bot, and Email Service do not receive expiration metadata.
- [x] Exempt the administrator from email verification for administrator actions.
- [x] Add regression coverage for recovery silence, key-entry action, non-expiring support apps, and admin verification bypass.

# Mini-App Session Generator and Name Feedback

- [x] Standardize all mini-app unavailable-name failures as “This name already exists, try a different name.”
- [x] Add a mini-app Get Session entry point with supported bot-type selection and number entry.
- [x] Generate session data inside the mini app and provide a copyable session ID without sending it to the user’s Telegram chat.
- [x] Notify only the administrator when a mini-app session generation request succeeds or fails.
- [x] Add regression coverage for name feedback, session-generation access controls, copyable session output, and administrator-only alerts.

# Session Pairing UX, Raganork Repair, and Expiry Lifecycle

- [x] Add a compact copy control beside each mini-app pairing code.
- [x] Keep mini-app session generation in Processing only until the pairing code arrives and preserve completed session output.
- [x] Repair the Raganork pairing browser connection error without exposing session values in Telegram chat.
- [x] Remove YT-DLP-related code, commands, and dependencies from the repository.
- [x] Suspend expired bots for 24 hours with dynos stopped, then permanently delete unresolved suspended bots.
- [x] Add regression coverage for pairing UI state, Raganork repair, YT-DLP removal, and 24-hour expiry lifecycle.
