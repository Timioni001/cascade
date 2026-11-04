/**
 * A small Model Context Protocol server: JSON-RPC 2.0 over stdio, one JSON
 * message per line, implementing what tool servers need (initialize, ping,
 * tools/list, tools/call). No dependencies.
 * Spec: https://modelcontextprotocol.io/specification
 */

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  /** Read-only tools are marked so clients can run them without asking. */
  readOnly?: boolean;
  run(args: Record<string, unknown>): Promise<unknown>;
}

type Id = string | number;
interface Request {
  jsonrpc: "2.0";
  id?: Id;
  method: string;
  params?: Record<string, unknown>;
}

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/** An error a tool reports to the model (as a tool result, not a protocol error). */
export class ToolError extends Error {
  override name = "ToolError";
}

export class McpServer {
  constructor(
    readonly info: { name: string; title: string; version: string },
    readonly tools: Tool[],
    readonly instructions?: string,
  ) {}

  /** Handle one JSON-RPC message; returns the response, or null for notifications. */
  async handle(msg: unknown): Promise<object | null> {
    const req = msg as Request;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: req?.id ?? null, error: { code, message } });
    if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string") return fail(-32600, "invalid request");
    if (req.id === undefined) return null; // notification (initialized, cancelled...)

    switch (req.method) {
      case "initialize": {
        const asked = String(req.params?.protocolVersion ?? "");
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: this.info,
          ...(this.instructions ? { instructions: this.instructions } : {}),
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: this.tools.map((t) => ({
            name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
            annotations: { title: t.title, readOnlyHint: !!t.readOnly, openWorldHint: true },
          })),
        });
      case "tools/call": {
        const name = String(req.params?.name ?? "");
        const tool = this.tools.find((t) => t.name === name);
        if (!tool) return fail(-32602, `unknown tool: ${name}`);
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          const out = await tool.run(args);
          const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
          return reply({ content: [{ type: "text", text }], ...(typeof out === "object" && out !== null ? { structuredContent: out } : {}) });
        } catch (e) {
          // Tool failures go back to the model as results it can read and act on.
          return reply({ content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
        }
      }
      default:
        return fail(-32601, `method not found: ${req.method}`);
    }
  }

  /** Serve on stdin/stdout. Logs go to stderr (stdout carries only protocol messages). */
  serveStdio(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
    let buf = "";
    const queue: Promise<void>[] = [];
    return new Promise((resolve) => {
      input.setEncoding?.("utf8");
      input.on("data", (chunk: string) => {
        buf += chunk;
        for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          queue.push(
            (async () => {
              let msg: unknown;
              try {
                msg = JSON.parse(line);
              } catch {
                output.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
                return;
              }
              const res = await this.handle(msg);
              if (res) output.write(JSON.stringify(res) + "\n");
            })(),
          );
        }
      });
      input.on("end", () => void Promise.all(queue).then(() => resolve()));
    });
  }
}

// ------------------------------------------------------------ argument helpers

export function str(a: Record<string, unknown>, k: string, required = true): string | undefined {
  const v = a[k];
  if (v === undefined || v === null || v === "") {
    if (required) throw new ToolError(`${k} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new ToolError(`${k} must be a string`);
  return v;
}

export function num(a: Record<string, unknown>, k: string): number | undefined {
  const v = a[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ToolError(`${k} must be a number`);
  return v;
}

/** "12.5" or 12.5 dollars -> USDC base units. */
export function dollars(v: unknown, k: string): bigint {
  const s = typeof v === "number" ? v.toFixed(6) : typeof v === "string" ? v.trim() : "";
  const m = /^(\d+)(?:\.(\d{1,6})\d*)?$/.exec(s);
  if (!m) throw new ToolError(`${k} must be an amount in dollars, like "12.50"`);
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}

export const fmt = (units: string | bigint) => (Number(units) / 1e6).toFixed(2);
