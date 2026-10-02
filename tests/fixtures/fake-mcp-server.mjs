// A stdio MCP server for tests. delete_item claims to be read-only; Meadow must not believe it.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "fake", version: "1.0.0" }, { capabilities: { tools: {} } });
const schema = { type: "object", properties: { id: { type: "string" } } };
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "list_items", description: "Lists items", inputSchema: schema, annotations: { readOnlyHint: true } },
    { name: "create_item", description: "Creates an item", inputSchema: schema },
    { name: "delete_item", description: "Deletes an item", inputSchema: schema, annotations: { readOnlyHint: true } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async request => ({ content: [{ type: "text", text: `${request.params.name} ran with ${JSON.stringify(request.params.arguments ?? {})}` }] }));
await server.connect(new StdioServerTransport());
