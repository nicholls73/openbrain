import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { renderCliError } from "./cli-error.js";
import {
  addMemory,
  deleteMemory,
  getBrainStatus,
  listMemories,
  listPendingReviews,
  markReviewDone,
  mergeMemory,
  promoteMemory,
  searchMemories,
  showMemory,
  updateMemory
} from "./openbrain.js";
import { DURABLE_MEMORY_TYPES, MEMORY_TYPES, STORED_MEMORY_TYPES } from "./types.js";
import { readCurrentVersion } from "./update.js";

const memoryType = z.enum(MEMORY_TYPES);
const storedMemoryType = z.enum(STORED_MEMORY_TYPES);
const durableMemoryType = z.enum(DURABLE_MEMORY_TYPES);

// Domain errors (e.g. an unassigned workspace path) become MCP tool errors
// carrying the same guidance the CLI prints, so a failing call never kills
// the server and the agent can act on the message.
async function toolResult(run: () => Promise<unknown>) {
  try {
    const value = await run();
    return {
      content: [
        { type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }
      ]
    };
  } catch (error) {
    return { content: [{ type: "text" as const, text: renderCliError(error) }], isError: true };
  }
}

// The brain is resolved per call from process.cwd() and OPENBRAIN_BRAIN,
// exactly like the CLI: no cwd/brain overrides are passed to the facade.
export async function createMcpServer() {
  const server = new McpServer({ name: "openbrain", version: await readCurrentVersion() });

  server.registerTool(
    "memory_search",
    {
      description:
        "Search stored memories in the current workspace's brain. Run this before starting a task with a short description of the task, and use only the relevant results. If a result already covers a fact you were about to record, revise it with memory_update instead of adding a near-duplicate.",
      inputSchema: {
        query: z.string().describe("Short description of the current task or fact to look up"),
        type: storedMemoryType.optional(),
        durableOnly: z.boolean().optional(),
        includePrivate: z.boolean().optional().describe("Include private memories; requires explicit opt-in"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum results; defaults to configured limit")
      }
    },
    ({ query, type, durableOnly, includePrivate, limit }) =>
      toolResult(() => searchMemories(query, { type, durableOnly, includePrivate, limit }))
  );

  server.registerTool(
    "memory_add",
    {
      description:
        "Record a memory after meaningful work. Use durable types (preference, workflow, workspace, decision) only for guidance that stays useful across future tasks; use episode for short-lived session notes, handoff state, or fast-changing facts. Never store secrets or one-off details like branch names or commit IDs. If the result reports duplicateOf, fold the fact into that existing memory with memory_update and delete this one.",
      inputSchema: {
        type: memoryType,
        text: z.string(),
        scope: z.string().optional().describe("Narrow retrieval scope"),
        confidence: z.enum(["low", "medium", "high"]).optional(),
        sensitivity: z
          .enum(["standard", "private"])
          .optional()
          .describe("private memories are local-only, never embedded, and need includePrivate to search"),
        promoteAs: durableMemoryType
          .optional()
          .describe("For episodes: mark for later review as this durable type")
      }
    },
    ({ type, text, scope, confidence, sensitivity, promoteAs }) =>
      toolResult(() => addMemory({ type, text, metadata: { scope, confidence, sensitivity, promoteAs } }))
  );

  server.registerTool(
    "memory_update",
    {
      description:
        "Replace a memory's text, keeping its id. Prefer this over memory_add when an existing memory is outdated or already covers the same fact.",
      inputSchema: { id: z.string(), text: z.string() }
    },
    ({ id, text }) => toolResult(() => updateMemory({ id, text }))
  );

  server.registerTool(
    "memory_merge",
    {
      description:
        "Fold one memory into another: the target gets the merged text, the source is deleted. Use when two memories cover the same fact, e.g. when acting on a dream consolidation review. Read both memories first; never merge automatically.",
      inputSchema: { sourceId: z.string(), targetId: z.string(), text: z.string() }
    },
    ({ sourceId, targetId, text }) => toolResult(() => mergeMemory({ sourceId, targetId, text }))
  );

  server.registerTool(
    "memory_promote",
    {
      description:
        "Promote an episode into a durable memory of the given type with rewritten text. Use when acting on a dream promotion-candidates review. Read the episode's source text first; never promote automatically.",
      inputSchema: { episodeId: z.string(), type: durableMemoryType, text: z.string() }
    },
    ({ episodeId, type, text }) => toolResult(() => promoteMemory({ episodeId, type, text }))
  );

  server.registerTool(
    "memory_list",
    { description: "List non-private memory summaries with id, type, creation date, and title." },
    () =>
      toolResult(async () =>
        (await listMemories())
          .filter((memory) => memory.metadata.sensitivity !== "private")
          .map(({ id, type, createdAt, title }) => ({ id, type, createdAt, title }))
      )
  );

  server.registerTool(
    "memory_show",
    {
      description: "Show a memory's full markdown (frontmatter and body) by id.",
      inputSchema: { id: z.string() }
    },
    ({ id }) => toolResult(() => showMemory(id))
  );

  server.registerTool(
    "memory_delete",
    {
      description:
        "Delete a memory by id. Use after folding a near-duplicate into an existing memory, or when a review recommends removal.",
      inputSchema: { id: z.string() }
    },
    ({ id }) =>
      toolResult(async () => {
        await deleteMemory(id);
        return `Deleted ${id}.`;
      })
  );

  server.registerTool(
    "brain_current",
    {
      description:
        "Report which brain (memory container) the current workspace path resolves to, and its state. If the state is not active, ask the user which brain should own the path before using memory."
    },
    () => toolResult(() => getBrainStatus())
  );

  server.registerTool(
    "review_list",
    {
      description:
        "List dream-written review files awaiting action (promotion candidates and duplicate consolidations). Dream proposes; you dispose: read each pending file and action its suggestions with memory_promote, memory_update, memory_merge, or memory_delete, asking the user only where a judgement call is needed."
    },
    () => toolResult(() => listPendingReviews())
  );

  server.registerTool(
    "review_done",
    {
      description: "Mark a review file as handled after actioning its suggestions.",
      inputSchema: { file: z.string() }
    },
    ({ file }) => toolResult(() => markReviewDone(file))
  );

  return server;
}

export async function runMcpServer() {
  const server = await createMcpServer();
  await server.connect(new StdioServerTransport());
}
