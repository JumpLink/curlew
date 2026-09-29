/**
 * A stand-in for McpServer that records registrations instead of serving them.
 *
 * Lets the tool catalogue and the read-only gate be asserted on BOTH runtimes without a
 * transport, a client, or a live GOA session — the handlers are never invoked.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** The parts of a tool config these tests care about. */
export interface RecordedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, { safeParse(value: unknown): { success: boolean } }>;
  annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean };
}

/** A registered tool's handler, as loosely as a test that only calls it needs. */
export type RecordedHandler = (params: unknown) => Promise<unknown>;

export interface Recorder {
  server: McpServer;
  tools: RecordedTool[];
  names(): string[];
  find(name: string): RecordedTool | undefined;
  /**
   * Every registered handler, by name.
   *
   * Additive, and added for one reason: a tool that REFUSES something has to be called to be
   * tested. Asserting that a refusal exists by reading its source proves nothing, and the
   * security claims on the setup tools are all about what a handler does when invoked.
   */
  handlers: Map<string, RecordedHandler>;
  /** The handler for a tool, or a thrown error naming what is missing. */
  handler(name: string): RecordedHandler;
}

export function createRecorder(): Recorder {
  const tools: RecordedTool[] = [];
  const handlers = new Map<string, RecordedHandler>();
  const server = {
    registerTool: (name: string, config: Omit<RecordedTool, 'name'>, handler: RecordedHandler) => {
      tools.push({ name, ...config });
      handlers.set(name, handler);
      return undefined;
    },
  } as unknown as McpServer;
  return {
    server,
    tools,
    names: () => tools.map((t) => t.name),
    find: (name) => tools.find((t) => t.name === name),
    handlers,
    handler: (name) => {
      const found = handlers.get(name);
      if (found === undefined)
        throw new Error(`no tool registered as ${name}: ${tools.map((t) => t.name).join(', ')}`);
      return found;
    },
  };
}
