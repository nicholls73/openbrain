import { openBrainHome } from "./paths.js";

// Sandboxed agent hosts deny writes outside their workspace allowlist, and
// the raw EACCES/EPERM/SQLITE_* messages give an agent nothing to act on.
// The CLI cannot escape the sandbox itself, but the host can rerun the
// command with user-approved elevation, so say exactly that. Lives outside
// cli.ts so tests can import it without executing the CLI entrypoint.
export function renderCliError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown }).code;
  const denied =
    code === "EACCES" ||
    code === "EPERM" ||
    (typeof code === "string" && /^SQLITE_(READONLY|CANTOPEN)/.test(code));
  if (!denied) {
    return message;
  }
  return [
    message,
    "",
    `The OpenBrain store at ${openBrainHome()} may be outside this sandbox's write allowlist.`,
    "Reads (memory search, list, show) work without write access; writes, dream",
    "maintenance, and index rebuilds need it. Ask the user to approve elevated",
    "filesystem access and rerun this exact command."
  ].join("\n");
}
