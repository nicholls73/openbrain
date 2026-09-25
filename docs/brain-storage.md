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

OpenBrain asks Obsidian Headless to log in when needed. It reuses the remote vault named `brain`, or creates it when missing, then performs an initial sync. The local vault lives at `~/.openbrain/vaults/brain` unless Obsidian Headless already configured that remote vault elsewhere.

The Markdown brain data is synchronized. The rebuildable SQLite search index stays local at `~/.openbrain/indexes/<brain>/openbrain.db` so a live database is never synchronized.

The command prints the `ob sync --continuous` command for ongoing synchronization. Do not run Obsidian desktop Sync and Headless Sync for the same vault on one computer; Obsidian warns that this can cause conflicts.

If both local and remote storage already contain different data for the same brain, OpenBrain stops without merging or deleting either copy.

## Existing local vault

Move the complete brain into a vault without configuring Obsidian Sync:

```bash
openbrain brain storage main obsidian --vault "/path/to/My Vault"
```

OpenBrain requires the vault's `.obsidian` directory, then stores the brain at:

```text
My Vault/OpenBrain/brains/main/
├── memories/
├── episodes/
├── dreams/
└── openbrain.db
```

The move copies and verifies the files, rebuilds the index at its new location, updates the configuration, and only then removes the old directory. Stop other OpenBrain processes while moving a brain.

Move it back to local storage:

```bash
openbrain brain storage main local
```

## Editing and synchronization

Markdown edited in Obsidian becomes searchable after:

```bash
openbrain index rebuild
```

Local-vault mode does not configure synchronization. Its SQLite index remains inside the vault, so do not synchronize that vault between computers. Account-based Headless Sync mode keeps its index outside the vault.

If a move is interrupted before the configuration changes, the verified source remains authoritative. Remove the incomplete destination shown by the error, then run the command again. If the configuration already points to the destination, verify it with `openbrain doctor` before removing the old directory.

The global configuration and downloaded embedding model cache remain under `~/.openbrain`; they are installation settings, not brain data.
