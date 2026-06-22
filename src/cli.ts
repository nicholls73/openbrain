#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import {
  addMemory,
  addBrainPath,
  deleteMemory,
  dreamMaybe,
  dreamRun,
  getCurrentBrain,
  initOpenBrain,
  listMemories,
  pruneEpisodes,
  promoteMemory,
  rebuildIndex,
  searchMemories,
  showMemory,
  setupOpenBrain,
  syncCodexAgent
} from "./openbrain.js";
import {
  isDurableMemoryType,
  isMemoryType,
  isStoredMemoryType,
  type DurableMemoryType,
  type MemoryConfidence,
  type MemorySensitivity,
  type MemoryType,
  type SearchResult,
  type SetupInput,
  type SetupPathRuleInput,
  type StoredMemoryType
} from "./types.js";

async function main(argv: string[]) {
  const [area, command, ...rest] = argv;

  if (area === "init") {
    await initOpenBrain();
    console.log("OpenBrain initialized.");
    return;
  }

  if (area === "setup") {
    await setupCommand([command, ...rest].filter((value): value is string => Boolean(value)));
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

  if (area === "brain" && command === "current") {
    console.log(await getCurrentBrain());
    return;
  }

  if (area === "brain" && command === "add-path") {
    const brain = rest[0];
    const targetPath = rest[1] ?? process.cwd();
    if (!brain) {
      throw new Error("brain add-path requires a brain name");
    }
    const result = await addBrainPath(brain, targetPath);
    console.log(`Added path rule: ${result.brain}\t${result.path}`);
    return;
  }

  if (area === "dream") {
    await dreamCommand(command, rest);
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

async function dreamCommand(command: string | undefined, args: string[]) {
  const quiet = args.includes("--quiet");
  if (command === "maybe") {
    const result = await dreamMaybe();
    if (!quiet) {
      printDreamResult(result);
    }
    return;
  }

  if (command === "run") {
    const result = await dreamRun();
    if (!quiet) {
      printDreamResult(result);
    }
    return;
  }

  usage();
}

async function setupCommand(args: string[]) {
  const input = await readSetupInput(args);
  const result = await setupOpenBrain(input);

  console.log("OpenBrain setup complete.");
  console.log(`Brain setup: ${result.brainScope === "default" ? "one brain" : "path-specific brains"}`);
  console.log(`Current brain: ${result.currentBrain}`);
  for (const rule of result.pathRules) {
    console.log(`Path rule: ${rule.brain}\t${rule.path}`);
  }
  console.log(`Codex: ${result.codexAgentFile ? result.codexAgentFile : "not synced"}`);
}

async function readSetupInput(args: string[]): Promise<SetupInput> {
  const brainScope = readOption(args, "--brain-scope") as SetupInput["brainScope"] | undefined;
  const codex = readOption(args, "--codex");
  const pathRules = readOptions(args, "--path-rule").map(parsePathRule);

  if (brainScope && !["default", "paths"].includes(brainScope)) {
    throw new Error("setup --brain-scope must be default or paths");
  }

  if (brainScope && codex) {
    return {
      brainScope,
      pathRules,
      syncCodex: parseYesNo(codex, "--codex")
    };
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      "setup needs answers. Run interactively, or pass --brain-scope default|paths and --codex yes|no."
    );
  }

  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    const resolvedScope = brainScope ?? (await askBrainScope(prompt));
    const resolvedPathRules =
      resolvedScope === "paths" && pathRules.length === 0 ? await askPathRules(prompt) : pathRules;
    const resolvedCodex = codex ? parseYesNo(codex, "--codex") : await askYesNo(prompt, "Sync Codex? [Y/n] ");

    return {
      brainScope: resolvedScope,
      pathRules: resolvedPathRules,
      syncCodex: resolvedCodex
    };
  } finally {
    prompt.close();
  }
}

async function askBrainScope(prompt: ReturnType<typeof createInterface>): Promise<SetupInput["brainScope"]> {
  const oneBrain = await askYesNo(prompt, "One brain for this machine? [Y/n] ");
  return oneBrain ? "default" : "paths";
}

async function askPathRules(prompt: ReturnType<typeof createInterface>) {
  const rules: SetupPathRuleInput[] = [];
  while (true) {
    const answer = (await prompt.question("Path rule brain=/path (blank when done): ")).trim();
    if (!answer) {
      break;
    }
    rules.push(parsePathRule(answer));
  }
  if (!rules.length) {
    throw new Error("path-specific setup requires at least one path rule");
  }
  return rules;
}

async function askYesNo(prompt: ReturnType<typeof createInterface>, question: string) {
  const answer = (await prompt.question(question)).trim().toLowerCase();
  return answer === "" || answer === "y" || answer === "yes";
}

async function memoryCommand(command: string | undefined, args: string[]) {
  if (command === "add") {
    const type = readOption(args, "--type") as MemoryType | undefined;
    const text = readOption(args, "--text");
    if (!isMemoryType(type)) {
      throw new Error("memory add requires --type preference|workflow|workspace|decision|episode");
    }
    if (!text) {
      throw new Error("memory add requires --text");
    }
    const result = await addMemory({
      type,
      text,
      metadata: {
        source: readOption(args, "--source"),
        scope: readOption(args, "--scope"),
        confidence: parseConfidence(readOption(args, "--confidence")),
        expiresAt: readOption(args, "--expires-at"),
        sensitivity: parseSensitivity(readOption(args, "--sensitivity")),
        promotedFrom: readOption(args, "--promoted-from"),
        promoteAs: parseDurableType(readOption(args, "--promote-as"))
      }
    });
    console.log(`${result.id}\t${result.path}`);
    return;
  }

  if (command === "promote") {
    const episodeId = args[0];
    const type = parseDurableType(readOption(args, "--type"));
    const text = readOption(args, "--text");
    if (!episodeId) {
      throw new Error("memory promote requires an episode id");
    }
    if (!type) {
      throw new Error("memory promote requires --type preference|workflow|workspace|decision");
    }
    if (!text) {
      throw new Error("memory promote requires --text");
    }
    const result = await promoteMemory({ episodeId, type, text });
    console.log(`${result.id}\t${result.path}`);
    return;
  }

  if (command === "search") {
    const { query, options } = parseSearchArgs(args);
    if (!query) {
      throw new Error("memory search requires a query");
    }
    printSearchResults(await searchMemories(query, options));
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

function readOptions(args: string[], name: string) {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === name && args[index + 1]) {
      values.push(args[index + 1]!);
    }
  }
  return values;
}

function parsePathRule(value: string): SetupPathRuleInput {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error("setup --path-rule must be brain=/path");
  }
  return {
    brain: value.slice(0, separator),
    path: value.slice(separator + 1)
  };
}

function parseYesNo(value: string, optionName: string) {
  const normalized = value.trim().toLowerCase();
  if (["yes", "y", "true"].includes(normalized)) {
    return true;
  }
  if (["no", "n", "false"].includes(normalized)) {
    return false;
  }
  throw new Error(`${optionName} must be yes or no`);
}

function parseSearchArgs(args: string[]) {
  const queryTokens: string[] = [];
  const options: {
    type?: StoredMemoryType;
    scope?: string;
    confidence?: MemoryConfidence;
    durableOnly?: boolean;
    includePrivate?: boolean;
  } = {};

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--durable-only") {
      options.durableOnly = true;
      continue;
    }
    if (arg === "--include-private") {
      options.includePrivate = true;
      continue;
    }
    if (arg === "--type") {
      options.type = parseStoredType(args[++index]);
      continue;
    }
    if (arg === "--scope") {
      options.scope = args[++index];
      continue;
    }
    if (arg === "--confidence") {
      options.confidence = parseConfidence(args[++index]);
      continue;
    }
    queryTokens.push(arg);
  }

  return { query: queryTokens.join(" ").trim(), options };
}

function parseStoredType(value: string | undefined): StoredMemoryType | undefined {
  if (isStoredMemoryType(value)) {
    return value;
  }
  throw new Error("--type must be preference|workflow|workspace|decision|episode|project");
}

function parseDurableType(value: string | undefined): DurableMemoryType | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (isDurableMemoryType(value)) {
    return value;
  }
  throw new Error("durable memory type must be preference|workflow|workspace|decision");
}

function parseConfidence(value: string | undefined): MemoryConfidence | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  throw new Error("--confidence must be low|medium|high");
}

function parseSensitivity(value: string | undefined): MemorySensitivity | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "standard" || value === "private") {
    return value;
  }
  throw new Error("--sensitivity must be standard|private");
}

function printSearchResults(results: SearchResult[]) {
  if (!results.length) {
    console.log("No memories found.");
    return;
  }

  for (const result of results) {
    console.log(`[${result.id}] ${result.title}`);
    console.log(
      `type=${result.type} scope=${result.scope} confidence=${result.confidence} sensitivity=${result.sensitivity} match=${result.match} score=${result.score.toFixed(3)}`
    );
    if (result.expiresAt || result.promotedFrom || result.promoteAs) {
      console.log(
        [
          result.expiresAt ? `expiresAt=${result.expiresAt}` : undefined,
          result.promotedFrom ? `promotedFrom=${result.promotedFrom}` : undefined,
          result.promoteAs ? `promoteAs=${result.promoteAs}` : undefined
        ]
          .filter(Boolean)
          .join(" ")
      );
    }
    console.log(`path=${result.path}`);
    console.log(result.excerpt);
    console.log("");
  }
}

function printDreamResult(result: Awaited<ReturnType<typeof dreamMaybe>>) {
  if (result.status === "ran") {
    console.log(`Dream ran for brain ${result.brain}: ${result.logPath}`);
    if (result.promotionCandidatesPath) {
      console.log(`Promotion candidates: ${result.promotionCandidatesPath}`);
    }
    console.log(`Pruned ${result.prunedEpisodes} episode file${result.prunedEpisodes === 1 ? "" : "s"}.`);
    return;
  }

  console.log(`Dream skipped for brain ${result.brain}: ${result.reason}`);
}

function usage() {
  console.log(`Usage:
  openbrain init
  openbrain setup [--brain-scope default|paths] [--path-rule <brain=/path>] [--codex yes|no]
  openbrain agents sync codex
  openbrain dream maybe [--quiet]
  openbrain dream run [--quiet]
  openbrain memory add --type <type> --text <text> [--source <value>] [--scope <value>] [--confidence low|medium|high] [--expires-at <iso>] [--sensitivity standard|private] [--promoted-from <id>] [--promote-as <type>]
  openbrain memory promote <episode-id> --type <type> --text <text>
  openbrain memory search <query> [--type <type>] [--scope <value>] [--confidence low|medium|high] [--durable-only] [--include-private]
  openbrain memory list
  openbrain memory show <id>
  openbrain memory delete <id>
  openbrain brain current
  openbrain brain add-path <brain> [path]
  openbrain index rebuild
  openbrain prune`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
