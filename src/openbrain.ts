// Facade over the domain modules so existing import sites keep working.
// New code should import from the specific module instead.
export {
  CLAUDE_HOOK_COMMAND,
  detectClaudeAgent,
  detectCodexAgent,
  disableClaudeAutoMemory,
  OPENBRAIN_BEGIN,
  runSessionStartHook,
  syncClaudeAgent,
  syncClaudeSettings,
  syncCodexAgent
} from "./adapters.js";
export { getBrainStatus, getCurrentBrain, initOpenBrain, memoryFiles } from "./internal.js";
export {
  dreamMaybe,
  dreamRun,
  listPendingReviews,
  markReviewDone,
  pruneEpisodes,
  rebuildIndex
} from "./maintenance.js";
export {
  addMemory,
  deleteMemory,
  listMemories,
  mergeMemory,
  promoteMemory,
  showMemory,
  updateMemory
} from "./memories.js";
export { searchMemories } from "./search.js";
export { addBrainPath, setupOpenBrain } from "./setup.js";
