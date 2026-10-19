/**
 * The package's programmatic surface: embed the daemon, drive the application
 * API directly, or reuse the pieces (journal, emulator, marks). Most users run
 * the `termd` binary and connect a host instead (README).
 */
export { App, type AppOptions, type Caller, type ReadResult, type RunResult, type SessionSummary } from './api/app.js';
export { SessionRegistry, type AnySession, type CreateOptions, type HistorySession, type LiveSession, type RegistryOptions } from './api/registry.js';
export { TokenMapResolver, type PrincipalResolver } from './api/principals.js';
export { callTool, TOOLS, toolsFor, type Profile, type ResultText, type ToolDef, type ToolResult } from './api/tools.js';
export { analyze as analyzeUsage, readUsage, type UsageRecord, type UsageReport } from './api/usage.js';
export { NodePtyBackend } from './backends/node-pty.js';
export { ScriptedBackend } from './backends/scripted.js';
export type { ExecutionBackend } from './backends/types.js';
export { Journal } from './core/journal.js';
export { FileStore, MemoryStore, type JournalStore } from './core/stores.js';
export { Screen } from './core/screen.js';
export { Session, type SessionOptions } from './core/session.js';
export { project, transcript } from './core/transcript.js';
export { TermError } from './core/errors.js';
export type { JournalEvent, Principal, RunInfo, RunState, ScreenSnapshot, Seq } from './core/types.js';
export { manifest, McplLane, FEATURE_SETS } from './transport/mcpl.js';
export { TermServer, type ServerOptions } from './transport/server.js';
