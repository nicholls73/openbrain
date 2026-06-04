#!/usr/bin/env node
import {
  addMemory,
  deleteMemory,
  initOpenBrain,
  listMemories,
  pruneEpisodes,
  rebuildIndex,
  searchMemories,
  showMemory,
  syncCodexAgent
} from "./openbrain.js";
import type { MemoryType, SearchResult } from "./types.js";

async function main(argv: string[]) {
  const [area, command, ...rest] = argv;

  if (area === "init") {
    await initOpenBrain();
    console.log("OpenBrain initialized.");
    return;
  }

  if (area === "agents" && command === "sync") {
    const agent = rest[0];
    if (agent !== "codex") {
      throw new Error("Only Codex agent sync is supported in v1.");
    }
    const file = await syncCodexAgent();
    console.log(`Synced Codex adapter: ${file}`);
    return;
  }

  if (area === "memory") {
    await memoryCommand(command, rest);
    return;
  }

  if (area === "index" && command === "rebuild") {
    await rebuildIndex();
    console.log("Index rebuilt.");
    return;
  }

  if (area === "prune") {
    const pruned = await pruneEpisodes();
    console.log(`Pruned ${pruned.length} episode file${pruned.length === 1 ? "" : "s"}.`);
    return;
  }

  usage();
}

async function memoryCommand(command: string | undefined, args: string[]) {
  if (command === "add") {
    const type = readOption(args, "--type") as MemoryType | undefined;
    const text = readOption(args, "--text");
    if (!type || !["preference", "workflow", "project", "decision", "episode"].includes(type)) {
      throw new Error("memory add requires --type preference|workflow|project|decision|episode");
    }
    if (!text) {
      throw new Error("memory add requires --text");
    }
    const result = await addMemory({ type, text });
    console.log(`${result.id}\t${result.path}`);
    return;
  }

  if (command === "search") {
    const query = args.join(" ").trim();
    if (!query) {
      throw new Error("memory search requires a query");
    }
    printSearchResults(await searchMemories(query));
    return;
  }

  if (command === "list") {
    const memories = await listMemories();
    for (const memory of memories) {
      console.log(`${memory.id}\t${memory.type}\t${memory.createdAt}\t${memory.title}`);
    }
    return;
  }

  if (command === "show") {
    const id = args[0];
    if (!id) {
      throw new Error("memory show requires an id");
    }
    process.stdout.write(await showMemory(id));
    return;
  }

  if (command === "delete") {
    const id = args[0];
    if (!id) {
      throw new Error("memory delete requires an id");
    }
    await deleteMemory(id);
    console.log(`Deleted ${id}.`);
    return;
  }

  usage();
}

function readOption(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  return args[index + 1];
}

function printSearchResults(results: SearchResult[]) {
  if (!results.length) {
    console.log("No memories found.");
    return;
  }

  for (const result of results) {
    console.log(`[${result.id}] ${result.title}`);
    console.log(`type=${result.type} match=${result.match} score=${result.score.toFixed(3)}`);
    console.log(`path=${result.path}`);
    console.log(result.excerpt);
    console.log("");
  }
}

function usage() {
  console.log(`Usage:
  openbrain init
  openbrain agents sync codex
  openbrain memory add --type <type> --text <text>
  openbrain memory search <query>
  openbrain memory list
  openbrain memory show <id>
  openbrain memory delete <id>
  openbrain index rebuild
  openbrain prune`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
