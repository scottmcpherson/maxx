import { Type } from "typebox";

const endpoint = process.env.MAXX_BROWSER_ENDPOINT;
const token = process.env.MAXX_BROWSER_TOKEN;

if (!endpoint || !token) {
	throw new Error("Maxx browser MCP endpoint and token are required");
}

let nextId = 1;
let sessionId: string | undefined;

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

async function rpc(method: string, params?: unknown, signal?: AbortSignal): Promise<any> {
	const id = nextId++;
	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		Accept: "application/json, text/event-stream",
		"Content-Type": "application/json",
	};
	if (sessionId) headers["Mcp-Session-Id"] = sessionId;
	const response = await fetch(endpoint, {
		method: "POST",
		headers,
		body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }),
		signal,
	});
	if (!response.ok) {
		throw new Error(`Maxx browser MCP ${method} failed with HTTP ${response.status}`);
	}
	sessionId = response.headers.get("mcp-session-id") ?? sessionId;
	const payload = responsePayload(await response.text(), response.headers.get("content-type") ?? "") as any;
	if (payload?.error) throw new Error(payload.error.message ?? `Maxx browser MCP ${method} failed`);
	return payload?.result;
}

async function notify(method: string, params?: unknown): Promise<void> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		Accept: "application/json, text/event-stream",
		"Content-Type": "application/json",
	};
	if (sessionId) headers["Mcp-Session-Id"] = sessionId;
	const response = await fetch(endpoint, {
		method: "POST",
		headers,
		body: JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }),
	});
	if (!response.ok) {
		throw new Error(`Maxx browser MCP ${method} notification failed with HTTP ${response.status}`);
	}
}

export default async function maxxBrowserMcp(pi: any) {
	await rpc("initialize", {
		protocolVersion: "2025-11-25",
		capabilities: {},
		clientInfo: { name: "maxx-pi", version: "1.0" },
	});
	await notify("notifications/initialized");
	const listed = await rpc("tools/list");
	for (const tool of listed?.tools ?? []) {
		pi.registerTool({
			name: tool.name,
			label: tool.title ?? tool.name,
			description: tool.description ?? `Use the Maxx browser tool ${tool.name}`,
			parameters: Type.Unsafe(tool.inputSchema ?? { type: "object", properties: {} }),
			executionMode: "sequential",
			async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
				const result = await rpc("tools/call", { name: tool.name, arguments: params }, signal);
				const content = Array.isArray(result?.content) && result.content.length > 0
					? result.content
					: [{ type: "text", text: JSON.stringify(result?.structuredContent ?? result ?? null) }];
				return {
					content,
					details: result?.structuredContent ?? result,
				};
			},
		});
	}
}
