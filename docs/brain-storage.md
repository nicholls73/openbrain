# Brain storage

Each brain can use local storage, Obsidian Sync, or an existing local Obsidian vault. Local storage is the default and needs no configuration.

Show the current mode and location:

```bash
openbrain brain storage main
```

## Obsidian Sync

Install [Obsidian Headless](https://help.obsidian.md/sync/headless) and make sure your account has an active Obsidian Sync subscription:

```bash
npm install -g obsidian-headless
```

Connect a brain:

```bash
openbrain brain storage main obsidian
```

By default, OpenBrain stores a brain under `OpenBrain/brains/<brain>` inside the vault. To make the brain itself the vault contents, use the root layout:

```bash
openbrain brain storage main obsidian --root
```

This moves `memories`, `episodes`, and `dreams` to the vault's top level. Obsidian then shows those folders at the root of the vault. OpenBrain keeps the vault's `.obsidian` settings and unrelated notes. The SQLite index stays under `~/.openbrain/indexes/<brain>`.

Root layout reserves the vault for one OpenBrain brain. If another brain already uses that vault, OpenBrain refuses the move. Use a dedicated Obsidian Sync vault for root layout. On another device, connect the same remote vault with `openbrain brain storage <brain> obsidian --root` so that device uses the same layout.

OpenBrain asks Obsidian Headless to log in when needed. It reuses the remote vault named `brain`, or creates it when missing, then performs an initial sync. The local vault lives at `~/.openbrain/vaults/brain` unless Obsidian Headless already configured that remote vault elsewhere.

The Markdown brain data is synchronized. The rebuildable SQLite search index stays local at `~/.openbrain/indexes/<brain>/openbrain.db` so a live database is never synchronized.

OpenBrain starts continuous synchronization as a user background service. It uses a LaunchAgent on macOS and a user systemd service on Linux, starts again at login, and restarts after unexpected failures. No Obsidian credentials are copied into the service definition.

Check or control the service:

```bash
openbrain brain sync main status
openbrain brain sync main start
openbrain brain sync main stop
```

On macOS, output is written under `~/.openbrain/logs`. On Linux, use `journalctl --user` to inspect the service log. Platforms without LaunchAgent or systemd support keep the foreground `ob sync --continuous` fallback shown by the command.

The service is shared by every brain in the `brain` vault. Moving one brain back to local storage keeps synchronization running when another brain still uses that vault. Do not run Obsidian desktop Sync and Headless Sync for the same vault on one computer; Obsidian warns that this can cause conflicts.

If both local and remote storage already contain different data for the same brain, OpenBrain stops without merging or deleting either copy.

## Existing local vault

Move the complete brain into a vault without configuring Obsidian Sync:

```bash
openbrain brain storage main obsidian --vault "/path/to/My Vault"
```

OpenBrain requires the vault's `.obsidian` directory. By default, it stores the brain at:

```text
My Vault/OpenBrain/brains/main/
├── memories/
├── episodes/
├── dreams/
└── openbrain.db
```

The move copies and verifies the files, rebuilds the index at its new location, updates the configuration, and only then removes the old directory. Stop other OpenBrain processes while moving a brain.

To store the brain at the top level of an existing vault instead, add `--root`:

```bash
openbrain brain storage main obsidian --vault "/path/to/My Vault" --root
```

OpenBrain moves only the brain's managed folders and preserves `.obsidian` and other vault files. Root layout can be changed back by moving the brain to local storage or to a nested Obsidian layout.

Move it back to local storage:

```bash
openbrain brain storage main local
```

## Editing and synchronization

Markdown edited in Obsidian becomes searchable after:

```bash
openbrain index rebuild
```

Relate notes explicitly with repeatable `--related-to <id>` flags on `memory add` or `memory update`. An update replaces the current relation list; use `--clear-related-to` to remove it. Reviewed promotions also link back through their `promotedFrom` metadata. OpenBrain renders these links in a delimited generated section using relative Markdown paths. Rebuild regenerates the section from metadata while preserving user-authored body text and unrelated frontmatter; the parser excludes the generated section from indexed bodies and embeddings.

Only existing, unexpired, non-private targets receive generated links. OpenBrain refreshes incoming links after add, update, delete, and episode pruning. If expiry or privacy changes are made directly in Obsidian, run `openbrain index rebuild` to refresh links. Unresolved IDs stay in metadata and are linked if the target appears later.

Local-vault mode does not configure synchronization. In the default nested layout, its SQLite index stays with the brain, so do not synchronize that vault between computers. Root layout and Headless Sync keep the index under `~/.openbrain/indexes/<brain>`.

If a move is interrupted before the configuration changes, the verified source remains authoritative. Remove the incomplete destination shown by the error, then run the command again. If the configuration already points to the destination, verify it with `openbrain doctor` before removing the old directory.

The global configuration and downloaded embedding model cache remain under `~/.openbrain`; they are installation settings, not brain data.
