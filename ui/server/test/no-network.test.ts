// S8: the setup file refuses every real network call, so the cloud proxy can never attach the
// finos/prd Doppler token or the owner's Neon-Connection-String to a request from a test.
import { request } from "node:http";
import { connect as netConnect, createServer, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { neon, neonConfig } from "@neondatabase/serverless";
import { describe, expect, it } from "vitest";
import { NETWORK_REFUSED, PROXY_PORTS, takeViolations } from "./no-network.js";

describe("the network guard", () => {
  it("refuses a bare fetch and fails the test", async () => {
    await expect(fetch("https://api.doppler.com/")).rejects.toThrow(NETWORK_REFUSED);

    // The guard also fails the test after it ends; take the record so this proof passes.
    expect(takeViolations()).toEqual(["fetch"]);
  });

  it("refuses a bare Neon query and fails the test", async () => {
    const sql = neon("postgresql://finos_ui:x@ep-a-1.c-2.r.aws.neon.tech/neondb?sslmode=require");

    await expect(sql.query("select 1")).rejects.toThrow(NETWORK_REFUSED);
    expect(takeViolations()).toEqual(["neonConfig.fetchFunction"]);
  });

  const failure = (socket: Socket) => new Promise<Error>((resolve) => socket.once("error", resolve));

  it("refuses a TCP, TLS or HTTP connection to another host, however it is opened", async () => {
    const tcp = await failure(netConnect({ host: "api.doppler.com", port: 443 }));
    const byPort = await failure(netConnect(443, "192.0.2.1"));
    const tls = await failure(tlsConnect({ host: "api.doppler.com", port: 443 }));
    const http = await new Promise<Error>((resolve) => {
      request({ host: "example.com", port: 80, path: "/" }).once("error", resolve).end();
    });

    for (const error of [tcp, byPort, tls, http]) expect(error.message).toContain(NETWORK_REFUSED);
    expect(takeViolations()).toEqual([
      "socket to api.doppler.com", "socket to 192.0.2.1", "socket to api.doppler.com", "socket to example.com",
    ]);
  });

  it.skipIf(PROXY_PORTS.size === 0)("refuses a loopback connection to the proxy port", async () => {
    const [port] = [...PROXY_PORTS];

    const error = await failure(netConnect({ host: "127.0.0.1", port: port! }));

    expect(error.message).toContain(NETWORK_REFUSED);
    expect(takeViolations()).toEqual(["socket to a proxy port"]);
  });

  it("allows a loopback connection", async () => {
    const server = createServer((socket) => socket.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };

    const text = await new Promise<string>((resolve, reject) => {
      let got = "";
      netConnect({ host: "127.0.0.1", port })
        .on("data", (d) => (got += d))
        .on("end", () => resolve(got))
        .on("error", reject);
    });
    server.close();

    expect(text).toBe("ok");
    expect(takeViolations()).toEqual([]);
  });

  it("puts the Neon stub back before each test", () => {
    expect(String(neonConfig.fetchFunction)).toContain("refuse");
  });
});
