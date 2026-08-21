
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
