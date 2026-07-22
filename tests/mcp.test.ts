import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, test } from "vitest";
import { createMcpServer } from "../src/mcp.js";

// The MCP server resolves the brain from process.cwd() and env, exactly like
// the CLI, so these tests point OPENBRAIN_HOME at a temp store instead of
// passing options.
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

async function tempHome() {
  const home = await mkdtemp(path.join(tmpdir(), "openbrain-mcp-test-"));
  const previousHome = process.env.OPENBRAIN_HOME;
  const previousBrain = process.env.OPENBRAIN_BRAIN;
  process.env.OPENBRAIN_HOME = home;
  delete process.env.OPENBRAIN_BRAIN;
  cleanups.push(async () => {
    if (previousHome === undefined) {
      delete process.env.OPENBRAIN_HOME;
    } else {
      process.env.OPENBRAIN_HOME = previousHome;
    }
    if (previousBrain !== undefined) {
      process.env.OPENBRAIN_BRAIN = previousBrain;
    }
    await rm(home, { recursive: true, force: true });
  });
  return home;
}

async function connectedClient() {
  const server = await createMcpServer();
  const client = new Client({ name: "openbrain-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

function resultText(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as Array<{ type: string; text: string }>;
  return content.map((item) => item.text).join("\n");
}

describe("OpenBrain MCP server", () => {
  test("lists the memory, brain, and review tools", async () => {
    await tempHome();
    const client = await connectedClient();

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "brain_current",
      "memory_add",
      "memory_delete",
      "memory_list",
      "memory_merge",
      "memory_promote",
      "memory_search",
      "memory_show",
      "memory_update",
      "review_done",
      "review_list"
    ]);
    const search = tools.find((tool) => tool.name === "memory_search");
    expect(search?.description).toContain("before starting a task");
  });

  test("roundtrips memory_add and memory_search", async () => {
    await tempHome();
    const client = await connectedClient();

    const added = await client.callTool({
      name: "memory_add",
      arguments: { type: "workflow", text: "Run pnpm lint:fix before committing changes." }
    });
    expect(added.isError).toBeFalsy();
    const record = JSON.parse(resultText(added)) as { id: string; type: string };
    expect(record.type).toBe("workflow");

    const searched = await client.callTool({
      name: "memory_search",
      arguments: { query: "lint before committing" }
    });
    expect(searched.isError).toBeFalsy();
    const results = JSON.parse(resultText(searched)) as Array<{ id: string }>;
    expect(results.map((result) => result.id)).toContain(record.id);
  });

  test("honors and validates a per-call memory_search limit", async () => {
    await tempHome();
    const client = await connectedClient();

    for (const text of ["Shared retrieval term alpha.", "Shared retrieval term beta."]) {
      await client.callTool({ name: "memory_add", arguments: { type: "workflow", text } });
    }

    const searched = await client.callTool({
      name: "memory_search",
      arguments: { query: "shared retrieval term", limit: 1 }
    });
    expect(JSON.parse(resultText(searched))).toHaveLength(1);

    const invalid = await client.callTool({
      name: "memory_search",
      arguments: { query: "shared retrieval term", limit: 0 }
    });
    expect(invalid.isError).toBe(true);
  });

  test("lists summaries without bodies or private memories", async () => {
    await tempHome();
    const client = await connectedClient();

    const added = await client.callTool({
      name: "memory_add",
      arguments: { type: "workflow", text: "Visible memory. public-body-marker" }
    });
    const visible = JSON.parse(resultText(added)) as { id: string };
    await client.callTool({
      name: "memory_add",
      arguments: { type: "preference", text: "Hidden memory. private-body-marker", sensitivity: "private" }
    });

    const listed = await client.callTool({ name: "memory_list", arguments: {} });
    expect(JSON.parse(resultText(listed))).toEqual([
      {
        id: visible.id,
        type: "workflow",
        createdAt: expect.any(String),
        title: "Visible memory"
      }
    ]);
    expect(resultText(listed)).not.toContain("public-body-marker");
    expect(resultText(listed)).not.toContain("Hidden memory");
    expect(resultText(listed)).not.toContain("private-body-marker");
  });

  test("returns a tool error instead of crashing when no brain is assigned", async () => {
    const home = await tempHome();
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify({ brains: { default: "main", unmatched: "ask", pathRules: [] } }, null, 2),
      "utf8"
    );
    const client = await connectedClient();

    const result = await client.callTool({
      name: "memory_add",
      arguments: { type: "workflow", text: "Should not be stored." }
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("Ask the user which brain");

    // The server survives the failed call.
    const current = await client.callTool({ name: "brain_current", arguments: {} });
    expect(JSON.parse(resultText(current))).toEqual({ brain: "main", state: "ask" });
  });

  test("returns a tool error for an unknown memory id", async () => {
    await tempHome();
    const client = await connectedClient();

    const result = await client.callTool({ name: "memory_show", arguments: { id: "no-such-id" } });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("Memory not found: no-such-id");
  });

  test("renders sandbox guidance when the store is not writable", async () => {
    const home = await tempHome();
    await chmod(home, 0o555);
    cleanups.push(() => chmod(home, 0o755).catch(() => {}));
    const client = await connectedClient();

    const result = await client.callTool({
      name: "memory_add",
      arguments: { type: "workflow", text: "Should not be stored." }
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("write allowlist");
  });
});
