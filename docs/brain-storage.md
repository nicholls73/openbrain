# Brain storage

Each brain can use local storage or live entirely inside an existing Obsidian vault. Local storage is the default and needs no configuration.

Show the current mode and location:

```bash
openbrain brain storage main
```

Move the complete brain into a vault:

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

Obsidian storage currently supports one computer. Do not synchronize and use the same vault brain on another computer: a live SQLite database cannot be made safe by waiting for file synchronization. Multi-device vault support requires a separate per-device index design.

If a move is interrupted before the configuration changes, the verified source remains authoritative. Remove the incomplete destination shown by the error, then run the command again. If the configuration already points to the destination, verify it with `openbrain doctor` before removing the old directory.

The global configuration and downloaded embedding model cache remain under `~/.openbrain`; they are installation settings, not brain data.
