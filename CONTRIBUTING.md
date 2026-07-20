# Contributing

## Release versioning

Release Please determines the next version from Conventional Commits merged since the last release:

| Prefix | Release | Example |
| --- | --- | --- |
| `fix:` | Patch (`0.5.0` → `0.5.1`) | `fix: handle a missing config` |
| `feat:` | Minor (`0.5.0` → `0.6.0`) | `feat: add memory export` |
| `feat!:` or a `BREAKING CHANGE:` footer | Major | `feat!: change the memory format` |

Use Conventional Commit titles for commits and pull requests. A squash-merged pull request uses its title as the commit title. Changes such as `docs:`, `test:`, `ci:`, and `chore:` do not create a release by themselves.

Do not edit package versions manually. After successful CI on `main`, the Release workflow waits for approval, prepares the version from the commit history, and publishes that exact version.
