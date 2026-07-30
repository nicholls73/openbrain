# Contributing

Thanks for considering a contribution to OpenBrain.

## Development

Use the Node.js and pnpm versions declared in `package.json`, then run the same core checks as CI:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm build
pnpm test
```

When manually testing the CLI, point `OPENBRAIN_HOME` and `CODEX_HOME` at temporary directories so real memories and agent configuration are not changed.

## Issues and pull requests

- Search existing issues and pull requests before opening a new one.
- For substantial or breaking changes, open an issue before starting work to confirm the approach.
- Bug reports should include reproduction steps, expected behaviour, and actual behaviour.
- Keep each pull request focused on one change.
- Explain what changed, why, and how it was tested in the pull request description.
- Add or update tests for behaviour changes and documentation for user-facing changes.
- Write all documentation in clear, plain English, including README files, guides, and explanatory code comments.
- Use a Conventional Commit title so release automation can classify the change.
- Contributors are responsible for reviewing, testing, and ensuring they have the right to submit all work, including AI-assisted changes.
- Ensure `pnpm lint`, `pnpm build`, and `pnpm test` pass before requesting review.

## Release versioning

Release Please determines the next version from Conventional Commits merged since the last release:

| Prefix | Release | Example |
| --- | --- | --- |
| `fix:` | Patch (`0.5.0` → `0.5.1`) | `fix: handle a missing config` |
| `feat:` | Minor (`0.5.0` → `0.6.0`) | `feat: add memory export` |
| Any `<type>!:` or a `BREAKING CHANGE:` footer | Major | `feat!: change the memory format` |

Use Conventional Commit titles for commits and pull requests. A squash-merged pull request uses its title as the commit title. Changes such as `docs:`, `test:`, `ci:`, and `chore:` do not create a release by themselves.

Do not edit package versions or `CHANGELOG.md` manually. After successful CI on `main`, CI prepares the version and changelog in a release pull request. To publish it, manually run the Release workflow from `main`; it updates the release pull request to latest `main`, runs fresh checks, then merges, tags, and publishes the release.
