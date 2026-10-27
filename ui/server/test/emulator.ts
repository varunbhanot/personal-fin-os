// Answers Neon's HTTPS SQL protocol on a real Postgres, as NeonEmulator in tests/conftest.py
// does: POST {query, params} or {queries: [...]}, text parameters, raw text results, HTTP 400
// with {message, code} on an error. Each request runs "set role finos_ui_access" first (unless
// role is null), so the queries have the UI role's grants; a batch runs in one transaction,
// read only when Neon-Batch-Read-Only is "true". It records what each request carried.
import pg from "pg";

type NeonQuery = { query: string; params: (string | null)[] };
export type SeenRequest = { url: string; headers: Headers; body: unknown; init: RequestInit };

const RAW = { getTypeParser: () => (value: string) => value };

export class NeonEmulator {
  readonly requests: SeenRequest[] = [];

  constructor(
    private readonly config: pg.ClientConfig,
    private readonly role: string | null = "finos_ui_access",
  ) {}

  readonly fetchFunction = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    const body = JSON.parse(String(init.body));
    this.requests.push({ url, headers, body, init });
    const batch = Array.isArray(body.queries);
    const queries: NeonQuery[] = batch ? body.queries : [body];
    const client = new pg.Client(this.config);
    await client.connect();
    try {
      if (this.role) await client.query(`set role ${this.role}`);
      if (batch) {
        const readOnly = headers.get("neon-batch-read-only") === "true";
        await client.query(readOnly ? "begin read only" : "begin");
      }
      const results = [];
      for (const q of queries) {
        try {
          const result = await client.query({
            text: q.query, values: q.params, rowMode: "array", types: RAW,
          });
          results.push({
            fields: result.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
            rows: result.rows,
            command: result.command,
            rowCount: result.rowCount,
          });
        } catch (error) {
          if (batch) await client.query("rollback");
          const { message, code } = error as { message: string; code?: string };
          return Response.json({ message, code }, { status: 400 });
        }
      }
      if (batch) await client.query("commit");
      return Response.json(batch ? { results } : results[0]);
    } finally {
      await client.end();
    }
  };
}
