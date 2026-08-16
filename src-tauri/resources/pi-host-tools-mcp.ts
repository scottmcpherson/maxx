import { Type } from "typebox";

type HostTool = { name: string; endpoint: string; token: string };
type HostToolSession = HostTool & { sessionId?: string; nextId: number };

const raw = process.env.MAXX_HOST_TOOLS_JSON;
if (!raw) throw new Error("Maxx host-tool MCP configuration is required");

const configured = JSON.parse(raw) as HostTool[];
if (!Array.isArray(configured) || configured.length === 0) {
	throw new Error("Maxx host-tool MCP configuration must contain at least one server");
}

function responsePayload(body: string, contentType: string): unknown {
	if (!body.trim()) return undefined;
	if (!contentType.includes("text/event-stream")) return JSON.parse(body);
	const data = body
		.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.filter(Boolean)
		.at(-1);
	return data ? JSON.parse(data) : undefined;
}

async function rpc(server: HostToolSession, method: string, params?: unknown, signal?: AbortSignal): Promise<any> {
	const id = server.nextId++;
	const headers: Record<string, string> = {
		Authorization: `Bearer ${server.token}`,
		Accept: "application/json, text/event-stream",
		"Content-Type": "application/json",
	};
	if (server.sessionId) headers["Mcp-Session-Id"] = server.sessionId;
	const response = await fetch(server.endpoint, {
		method: "POST",
		headers,
		body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }),
		signal,
	});
	if (!response.ok) throw new Error(`Maxx MCP ${server.name} ${method} failed with HTTP ${response.status}`);
	server.sessionId = response.headers.get("mcp-session-id") ?? server.sessionId;
	const payload = responsePayload(await response.text(), response.headers.get("content-type") ?? "") as any;
	if (payload?.error) throw new Error(payload.error.message ?? `Maxx MCP ${server.name} ${method} failed`);
	return payload?.result;
}

async function notify(server: HostToolSession, method: string, params?: unknown): Promise<void> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${server.token}`,
		Accept: "application/json, text/event-stream",
		"Content-Type": "application/json",
	};
	if (server.sessionId) headers["Mcp-Session-Id"] = server.sessionId;
	const response = await fetch(server.endpoint, {
		method: "POST",
		headers,
		body: JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }),
	});
	if (!response.ok) throw new Error(`Maxx MCP ${server.name} notification failed with HTTP ${response.status}`);
}

export default async function maxxHostToolsMcp(pi: any) {
	for (const configuredServer of configured) {
		const server: HostToolSession = { ...configuredServer, nextId: 1 };
		await rpc(server, "initialize", {
			protocolVersion: "2025-11-25",
			capabilities: {},
			clientInfo: { name: "maxx-pi", version: "1.0" },
		});
		await notify(server, "notifications/initialized");
		const listed = await rpc(server, "tools/list");
		for (const tool of listed?.tools ?? []) {
			pi.registerTool({
				name: tool.name,
				label: tool.title ?? tool.name,
				description: tool.description ?? `Use the Maxx host tool ${tool.name}`,
				parameters: Type.Unsafe(tool.inputSchema ?? { type: "object", properties: {} }),
				executionMode: "sequential",
				async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
					const result = await rpc(server, "tools/call", { name: tool.name, arguments: params }, signal);
					const content = Array.isArray(result?.content) && result.content.length > 0
						? result.content
						: [{ type: "text", text: JSON.stringify(result?.structuredContent ?? result ?? null) }];
					return { content, details: result?.structuredContent ?? result };
				},
			});
		}
	}
}
