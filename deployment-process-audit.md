# DEPLOY_BOT Deployment Process Audit

## Executive assessment

The deployment workflow has a solid functional foundation: it validates bot type and session identifiers, gates regular deployments through deploy keys or payment, checks Heroku ownership conflicts, persists deployment metadata, and provides Telegram progress feedback. However, it is not yet production-grade in its reliability model. The biggest gap is that deployment execution is held in process memory and is started asynchronously from the web endpoint, so a restart, crash, or duplicate request can leave the user, Heroku, and the database in different states.

A fair assessment is **functional but operationally fragile**. The flow can be made professional without replacing the whole system, but it needs a durable deployment job model, idempotency, compensating cleanup, and clearer status reporting.

## Current flow observed in the code

| Stage | Current behavior | Assessment |
| --- | --- | --- |
| Request entry | `/api/deploy` receives bot type, app name, session ID, status preference, and deploy key. | Good starting contract, but request idempotency is missing. |
| Basic validation | Checks required fields, pending payment state, and session ID prefixes for Raganork/Levanter. | Useful, but validation should also normalize and strictly validate app names and allowed bot types. |
| Authorization/payment | Admin bypasses the key path; regular users use a deploy key or payment flow. | Correct concept, but key consumption and deployment creation should be tied to one durable job transaction. |
| Provider preparation | Checks whether the Heroku app exists. A 403 triggers a rename; a 404 is treated as available. | Ownership conflict handling is thoughtful, but renaming before all state is committed can create reconciliation risk. |
| Build | `buildWithProgress` creates/configures the Heroku app, installs buildpacks, sets config vars, and waits for bot status. | Functional, but a long-running build should be a background job rather than an in-memory request-linked operation. |
| Progress | Telegram messages are animated and later edited when the bot reports online/logged out. | Good user experience, but progress should also be persisted so users can recover after a restart. |
| Persistence | Deployment and config state are saved after provider configuration is retrieved. | Risk of orphaned Heroku apps if persistence fails after provider creation. |
| Completion | HTTP deployment endpoint returns before the asynchronous build finishes. | The client receives an early success response without a durable job ID or status endpoint. |
| Recovery | Some 404 cleanup and status timeouts exist. | There is no complete rollback/compensation strategy for every partial-failure stage. |

## Highest-priority risks

### 1. No durable deployment job state

The workflow relies on `appDeploymentPromises`, an in-memory map, to wait for a bot to report status. That state disappears when Render restarts the process, redeploys the service, or the application crashes. The user may see a deployment animation stop while Heroku continues running the app. This is the most important reliability issue.

**Recommendation:** add a `deployment_jobs` table with a job ID, owner, app name, requested bot type, status, provider app ID, timestamps, error message, and retry count. Return `202 Accepted` plus the job ID from `/api/deploy`, and expose a status endpoint or Telegram status lookup backed by the database.

### 2. Duplicate deployment requests are not safely idempotent

A browser retry, Telegram double tap, webhook retry, or network timeout can start the same deployment more than once. The current pending-payment check does not replace an idempotency mechanism for the build operation itself.

**Recommendation:** require an idempotency key per deployment request and enforce a unique database constraint on active jobs for `(user_id, normalized_app_name)`. Repeated requests should return the existing job rather than consume another key or create another Heroku app.

### 3. Partial failures can create orphaned provider apps

The provider app can be created and configured before `saveUserDeployment` or `addUserBot` completes. If the database write fails, the Heroku app can remain active but invisible to the user’s bot list.

**Recommendation:** implement a compensating transaction. Track the provider app immediately, retry database persistence, and if persistence cannot succeed, either delete the newly created provider app or mark the job as `NEEDS_RECONCILIATION` for an admin repair task.

### 4. Long-running deployment is detached from the HTTP request without a job contract

The endpoint intentionally does not await the build, which is reasonable for request timeouts, but it currently returns an early success response without a durable job identifier or a reliable completion channel.

**Recommendation:** return a clear `queued` response containing `jobId`, `appName`, and an estimated state such as `VALIDATING`, `BUILDING`, `CONFIGURING`, `STARTING`, or `LIVE`. The frontend or Telegram flow should poll a status endpoint or receive persisted event updates.

### 5. Provider API calls need structured retries and rate-limit handling

The workflow performs multiple Heroku API calls but does not appear to use a consistent retry policy with exponential backoff, bounded attempts, and special handling for `429`, `408`, and transient `5xx` responses.

**Recommendation:** centralize Heroku calls behind a provider client that implements request timeouts, retry classification, exponential backoff, correlation IDs, and redacted structured logs.

## User experience improvements

The current Telegram progress animation is a good base. To make deployment feel professional, show a stable deployment receipt after submission containing the app name, bot type, job ID, current stage, and a support-safe error code. Avoid telling users that a deployment is complete until provider configuration and bot health checks succeed. If a build fails, show the failed stage and a safe next action such as retry, edit configuration, or contact support.

The web deployment endpoint should use consistent status semantics. `202 Accepted` should mean queued, `200` should mean completed, `409` should mean an existing deployment is already active, `422` should mean invalid user input, and `503` should mean the provider is temporarily unavailable. The current generic `500` response makes it difficult for the client to distinguish user errors from recoverable infrastructure failures.

## Security and data handling recommendations

The code should strictly validate and normalize Heroku app names before interpolating them into provider URLs or logs. Configuration values and session IDs should never appear in ordinary logs, error payloads, or Telegram messages. Every provider operation should be authorized against the authenticated owner or admin role immediately before execution, not only when the request first begins.

Payment completion and deploy-key consumption should be transactionally linked to a deployment job. A payment webhook should be idempotent by provider reference and should not trigger two builds if the webhook is delivered more than once. Keep provider secrets only in environment variables and redact authorization headers, tokens, session IDs, and config-var values from logs.

## Recommended implementation order

| Priority | Change | Expected result |
| --- | --- | --- |
| P0 | Add durable `deployment_jobs` state and return a job ID. | Restarts no longer lose deployment state; users can see reliable status. |
| P0 | Add idempotency and unique active-job constraints. | Double clicks and retried requests do not create duplicate bots. |
| P0 | Add provider/database compensation and reconciliation states. | Partial failures stop producing invisible orphan apps. |
| P1 | Centralize Heroku API calls with timeout, retry, rate-limit, and correlation-ID handling. | Provider instability becomes recoverable and diagnosable. |
| P1 | Persist deployment event history and expose a status endpoint. | Telegram and web clients can recover progress after reconnects. |
| P1 | Improve error/status semantics and user-facing receipts. | Users know whether a deployment is queued, running, live, or failed. |
| P2 | Add preflight validation for app names, session formats, required variables, and provider capacity. | Fewer deployments fail after consuming a key or payment. |
| P2 | Add automated reconciliation for provider apps missing from the database. | Admins can detect and repair drift between Heroku and PostgreSQL. |
| P2 | Add integration tests with a mocked provider client. | Core deployment behavior can be verified without creating real Heroku apps. |

## Conclusion

The deployment process is a credible prototype and contains several good operational instincts, especially ownership-conflict handling, progress feedback, and deployment persistence. It should not yet be described as fully professional or production-hardened because the job lifecycle is not durable, duplicate requests are not idempotent, and partial provider/database failures can leave inconsistent state. Implementing the P0 items first would produce the largest improvement for users with the least architectural disruption.
