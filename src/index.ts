#!/usr/bin/env node
/**
 * zotero-native-mcp
 *
 * An MCP server over Zotero's local HTTP API. Every operation, reads and
 * writes alike, is served by the running Zotero instance on loopback: no
 * zotero.org account, no web API key, no network round trip, no rate limits,
 * and no Zotero plugin to install.
 *
 * Requires Zotero 7.1 or newer with Settings -> Advanced -> "Allow other
 * applications on this computer to communicate with Zotero" enabled.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { ZoteroLocalClient } from './client.js';
import { loadConfig } from './config.js';
import { registerAttachmentTools } from './tools/attachments.js';
import { registerCollectionTools } from './tools/collections.js';
import { registerDiscoveryTools } from './tools/discovery.js';
import { registerItemTools } from './tools/items.js';
import { registerSystemTools } from './tools/system.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new ZoteroLocalClient(config);

  const server = new McpServer(
    { name: 'zotero-native-mcp', version: '1.0.0' },
    {
      instructions: [
        'Tools for reading and writing the local Zotero library over Zotero\'s own local API.',
        '',
        'Object keys are 8 uppercase alphanumeric characters and are scoped to a library. All tools',
        'act on the personal library unless a groupId is passed.',
        '',
        'Writes need one-time consent: the first write raises a dialog in Zotero and the user must',
        'approve it. Calling zotero_authorize up front lets the user press "Always Allow" once,',
        'rather than being interrupted mid-task.',
        '',
        'Typical flow for filing a paper: zotero_create_items (with `collections` set) to create the',
        'reference, then zotero_attach_file to attach the PDF to it.',
      ].join('\n'),
    },
  );

  registerSystemTools(server, client);
  registerCollectionTools(server, client);
  registerItemTools(server, client);
  registerAttachmentTools(server, client);
  registerDiscoveryTools(server, client);

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  // stdout carries the MCP protocol; diagnostics must go to stderr.
  console.error('[zotero-native-mcp] fatal:', error instanceof Error ? error.stack : error);
  process.exit(1);
});
