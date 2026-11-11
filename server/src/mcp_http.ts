/**
 * Streamable HTTP MCP endpoint at /mcp (ops tools only).
 * Auth: opaque MCP Bearer tokens from Settings — not session JWTs.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Context } from "hono";
import { bearerFromHeader, HttpError } from "./auth";
import { readVersion } from "./config";
import { clientIp } from "./http";
import { buildMcpTools } from "./homebase_tools";
import { mcpRequestContext } from "./mcp_context";
import {
  mcpServerEnabled,
  mcpServerFeatures,
  verifyMcpBearerToken,
} from "./mcp_server";
import { isLocalPeerIp, upsertPresence } from "./presence";

function createOpsMcpServer(ctx: {
  actorId: string;
  actorLabel: string;
  peerIp?: string;
}): Server {
  const tools = buildMcpTools(mcpServerFeatures());
  const server = new Server(
    { name: "homebase", version: readVersion() },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(tools).map(([name, def]) => ({
      name,
      description: def.description,
      inputSchema: {
        type: "object" as const,
        properties:
          (def.parameters?.properties as Record<string, unknown>) || {},
        ...(Array.isArray(def.parameters?.required)
          ? { required: def.parameters.required as string[] }
          : {}),
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return mcpRequestContext.run(
      {
        actorId: ctx.actorId,
        actorLabel: ctx.actorLabel,
        peerIp: ctx.peerIp,
      },
      async () => {
        const name = request.params.name;
        const def = tools[name];
        if (!def) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: `Unknown tool: ${name}` }),
              },
            ],
          };
        }
        try {
          const args = (request.params.arguments || {}) as Record<string, unknown>;
          const text = await def.execute(args);
          try {
            const { recordActivity } = await import("./activity_audit");
            const argKeys = Object.keys(args || {}).slice(0, 12);
            recordActivity({
              source: "mcp",
              kind: "tool",
              summary: `${name}${argKeys.length ? ` (${argKeys.join(", ")})` : ""}`,
              actor: ctx.actorLabel,
              peerIp: ctx.peerIp,
              detail: { tool: name, argKeys, actorId: ctx.actorId },
            });
          } catch {
            /* ignore */
          }
          void import("./email_alerts")
            .then(({ maybeEmailAiAwayAccess }) => {
              maybeEmailAiAwayAccess({
                actorLabel: ctx.actorLabel,
                actorId: ctx.actorId,
                peerIp: ctx.peerIp,
                action: `tool ${name}`,
              });
            })
            .catch(() => undefined);
          return {
            content: [{ type: "text" as const, text: String(text) }],
          };
        } catch (e) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: e instanceof Error ? e.message : String(e),
                }),
              },
            ],
          };
        }
      },
    );
  });

  return server;
}

export async function handleMcpHttp(c: Context): Promise<Response> {
  if (!mcpServerEnabled()) {
    return c.json({ detail: "Not found" }, 404);
  }

  const token =
    bearerFromHeader(c.req.header("authorization")) ||
    c.req.query("token") ||
    undefined;
  const ip = clientIp(c);
  let actor: { id: string; label: string };
  try {
    actor = verifyMcpBearerToken(token, ip);
    const peerIp = ip === "unknown" ? undefined : ip;
    // Always register AI presence. Seat-local MCP (rare) stays quiet for the window;
    // unknown/remote opens Presence. Store peerIp even when unknown-ish via label.
    upsertPresence({
      id: `mcp:${actor.id}`,
      kind: "ai",
      name: actor.label || "Grok",
      label: "MCP AI",
      peerIp: peerIp || "unknown",
      announce: !isLocalPeerIp(peerIp),
    });
    void import("./email_alerts")
      .then(({ maybeEmailAiAwayAccess }) => {
        maybeEmailAiAwayAccess({
          actorLabel: actor.label || "MCP AI",
          actorId: actor.id,
          peerIp,
          action: "MCP session",
        });
      })
      .catch(() => undefined);
  } catch (e) {
    if (e instanceof HttpError) {
      return new Response(JSON.stringify({ detail: e.detail }), {
        status: e.status,
        headers: {
          "content-type": "application/json",
          "www-authenticate": 'Bearer realm="homebase-mcp"',
        },
      });
    }
    throw e;
  }

  const peerIp = ip === "unknown" ? undefined : ip;
  const server = createOpsMcpServer({
    actorId: actor.id,
    actorLabel: actor.label || "MCP",
    peerIp,
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await mcpRequestContext.run(
      {
        actorId: actor.id,
        actorLabel: actor.label || "MCP",
        peerIp,
      },
      () => transport.handleRequest(c.req.raw),
    );
  } finally {
    try {
      await transport.close();
    } catch {
      /* ignore */
    }
    try {
      await server.close();
    } catch {
      /* ignore */
    }
  }
}
