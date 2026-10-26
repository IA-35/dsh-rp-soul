# Internal RP Engine Modules

The user clarified that modularization is for code organization, not runtime
feature switches. Runtime toggle controls, flags, protocol fields and their
combination tests have been removed.

- [x] Keep fixed mood/memory/agency/wake responsibilities and lifecycle entrypoints.
- [x] Keep pure calculations in domain/ and one transaction, sidecar and database.
- [x] Compose module context through the fixed registry.
- [x] Keep the original wakeEnabled control and normal settings panels.
- [x] Remove module-toggle UI, /modules API and engineModules configuration.
- [x] Remove stdio module flags and transient state configuration.
- [x] Replace toggle tests with normal-flow lifecycle and boundary tests.
- [x] Run final regression checks and update the requested prompt sample.

No commits, branch changes, database migration or third-party plugin loader.

Verified: Python 206 cases across 9 files; Node 617 assertions across 11 scripts. Prompt sample regenerated through actual SystemPrompt and Python using fictional temporary data. Desktop restart remains unverified.
