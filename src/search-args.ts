import { isStoredMemoryType, type MemoryConfidence, type StoredMemoryType } from "./types.js";

export function parseSearchArgs(args: string[]) {
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
      options.type = parseStoredType(requireOptionValue(args[++index], "--type"));
      continue;
    }
    if (arg === "--scope") {
      options.scope = requireOptionValue(args[++index], "--scope");
      continue;
    }
    if (arg === "--confidence") {
      options.confidence = parseConfidence(requireOptionValue(args[++index], "--confidence"));
      continue;
    }
    queryTokens.push(arg);
  }

  return { query: queryTokens.join(" ").trim(), options };
}

function requireOptionValue(value: string | undefined, optionName: string): string {
  // A following flag token means the value is missing, not that the next
  // option's name was meant as the value.
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function parseStoredType(value: string | undefined): StoredMemoryType | undefined {
  if (isStoredMemoryType(value)) {
    return value;
  }
  throw new Error("--type must be preference|workflow|workspace|decision|episode|project");
}

export function parseConfidence(value: string | undefined): MemoryConfidence | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  throw new Error("--confidence must be low|medium|high");
}
