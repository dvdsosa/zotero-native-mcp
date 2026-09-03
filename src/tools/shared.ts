/**
 * Shared registration plumbing and reusable schema fragments.
 *
 * Registering through `defineTool` guarantees two things every tool needs:
 * a single place where thrown errors become actionable tool errors, and a
 * consistent set of annotations so clients can reason about which tools mutate
 * the library.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z, ZodRawShape } from 'zod';

import { ZoteroError } from '../errors.js';
import { fail } from '../format.js';
import { LibraryRef } from '../client.js';

export interface ToolDefinition<Args extends ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Args;
  outputSchema?: ZodRawShape;
  annotations: ToolAnnotations;
  handler: (args: z.objectOutputType<Args, z.ZodTypeAny>) => Promise<CallToolResult>;
}

export function defineTool<Args extends ZodRawShape>(server: McpServer, tool: ToolDefinition<Args>): void {
  const config: {
    title: string;
    description: string;
    inputSchema: Args;
    outputSchema?: ZodRawShape;
    annotations: ToolAnnotations;
  } = {
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { ...tool.annotations, openWorldHint: false },
  };
  if (tool.outputSchema) config.outputSchema = tool.outputSchema;

  server.registerTool(tool.name, config as never, (async (args: unknown) => {
    try {
      return await tool.handler(args as z.objectOutputType<Args, z.ZodTypeAny>);
    } catch (error) {
      if (error instanceof ZoteroError) return fail(error.toToolText());
      const message = error instanceof Error ? error.message : String(error);
      return fail(`${tool.name} failed: ${message}`);
    }
  }) as never);
}

// ------------------------------------------------------------------ fragments

export const groupIdParam = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(
    'Group library ID. Omit for the personal library ("My Library"), which is what almost every ' +
      'request wants. Group IDs come from zotero_list_libraries.',
  );

export const verboseParam = z
  .boolean()
  .default(false)
  .describe(
    'Return Zotero\'s raw API envelope (library block, self/alternate links, full meta) instead of ' +
      'the flattened object. Costs many extra tokens per object; only useful when a URL or the raw ' +
      'meta block is genuinely needed.',
  );

export const limitParam = z
  .number()
  .int()
  .min(1)
  .max(500)
  .default(50)
  .describe('Maximum number of objects to return (1-500).');

export const startParam = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe('Zero-based offset for paging; pass the nextStart value from a previous call.');

/** 8-character uppercase alphanumeric Zotero object key. */
export const objectKey = z
  .string()
  .regex(/^[A-Z0-9]{8}$/, 'Zotero keys are exactly 8 uppercase letters/digits, e.g. "ABCD1234"');

export function libraryOf(args: { groupId?: number | undefined }): LibraryRef {
  return { groupId: args.groupId };
}

/** Output shape shared by every list-style tool. */
export const listOutputShape = {
  totalResults: z.number().nullable(),
  returned: z.number(),
  start: z.number(),
  nextStart: z.number().nullable(),
};

/** Loose record type for Zotero objects, whose fields vary by item type. */
export const zoteroObject = z.record(z.string(), z.unknown());
