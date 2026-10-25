// E5.3: the Playwright smoke test of the UI, in Chromium, against the fake backend
// (ui/server/dist/fake.js: the real app over the synthetic golden record and a scripted fake
// Claude). Run it with `npm --prefix ui run e2e` in a cloud session; it builds both trees first.
// It never runs on the laptop, and it never starts the real server (CLAUDE.md).
//
// Playwright is not a dependency: the container has 1.63.0 under NODE_PATH and its browsers in
// PLAYWRIGHT_BROWSERS_PATH. An ES-module `import` does not read NODE_PATH, so it is loaded with
// createRequire. Never `playwright install`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer, request } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const FAKE = fileURLToPath(new URL("../server/dist/fake.js", import.meta.url));
const TIMEOUT = 20_000;

const steps = [];
const step = (name) => steps.push(name);

/** A free loopback port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createSocketServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Start the fake backend; resolves with its launch link (the one line it prints). */
async function startFake(port) {
  // A clean environment: only PATH. The fake needs nothing else, and has no secret to get.
  const child = spawn(process.execPath, [FAKE, "--port", String(port)], {
    env: { PATH: process.env.PATH ?? "" }, stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  let timer;
  const link = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const found = /^Fake backend: (http:\/\/127\.0\.0\.1:\d+\/auth\?t=\S+)$/m.exec(out);
      if (found) resolve(found[1]);
    });
    exited.then((code) => reject(new Error(`The fake backend stopped with ${code}: ${stderr.trim()}`)));
    timer = setTimeout(() => reject(new Error("The fake backend did not start in time.")), TIMEOUT);
  }).catch((error) => {
    child.kill(); // a failed start-up never leaves the child running
    throw error;
  }).finally(() => clearTimeout(timer));
  return { child, exited, link };
}

/** One HTTP request with any Host header (a browser would not send some of these). */
function raw(port, path, host) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode));
    });
    req.once("error", reject);
    req.end();
  });
}

async function main() {
  const port = await freePort();
  const otherPort = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const fake = await startFake(port);
  // A page on another port of 127.0.0.1: it gets the session cookie (cookies ignore ports) but
  // never the second value, which lives in the port-scoped sessionStorage.
  const other = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end("<!doctype html><title>other</title><p>another page</p>");
  });
  await new Promise((resolve) => other.listen(otherPort, "127.0.0.1", resolve));

  // --no-sandbox: the cloud container runs as root. Only loopback pages are opened.
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ colorScheme: "light" });
    context.setDefaultTimeout(TIMEOUT);

    // 6: no request leaves 127.0.0.1 (data: and blob: URLs are not requests to a host).
    const outside = [];
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "127.0.0.1") return route.continue();
      outside.push(url.href);
      return route.abort();
    });
    await context.addInitScript(() => {
      window.__csp = [];
      document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective));
    });
    const problems = [];
    const watch = (page) => {
      page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
      page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
    };

    const page = await context.newPage();
    watch(page);

    // 1: the launch link signs in; the hash is cleared at once.
    await page.goto(fake.link);
    await page.getByRole("heading", { name: "Data health" }).waitFor();
    assert.equal(new URL(page.url()).hash, "#/dashboard");
    step("launch link signs in, hash cleared");

    // 2: the dashboard with the golden figures (synthetic record, September 2026).
    const tile = (label) => page.getByRole("group", { name: label, exact: true });
    for (const [label, value] of [
      ["Income", "₹1,51,200.50"], ["Expenses", "₹75,155.75"],
      ["Savings", "₹76,044.75"], ["Investments", "₹20,000.00"],
    ]) {
      await tile(label).first().waitFor();
      assert.match(await tile(label).first().innerText(), new RegExp(value.replace(/[.]/g, "\\.")), label);
    }
    step("four KPI tiles with the golden figures");

    const chart = page.getByRole("img", { name: "Income, expenses and savings by month (chart)" });
    await chart.waitFor();
    await page.locator(".recharts-bar-rectangle").first().waitFor();
    assert.ok((await page.locator(".recharts-bar-rectangle").count()) >= 3, "trend bars are drawn");
    const trend = page.getByRole("table", { name: "Income, expenses and savings by month", includeHidden: true });
    assert.match(await trend.innerText(), /Aug 2026/);
    step("trend chart drawn, with its data table");

    const categories = page.getByRole("table", { name: "Spending by category" });
    await categories.waitFor();
    const categoryText = await categories.innerText();
    assert.match(categoryText, /Groceries/);
    assert.match(categoryText, /₹3,456\.75/);
    step("category table");

    const goals = page.getByRole("group", { name: "ZQX Goal Hill Trip" });
    await goals.waitFor();
    const goalText = await goals.innerText();
    assert.match(goalText, /₹50,000\.00/);
    assert.match(goalText, /₹3,456\.75/);
    assert.match(goalText, /₹46,543\.25/);
    step("goals");

    const spreads = page.getByRole("table", { name: "Spreads" });
    await spreads.waitFor();
    assert.match(await spreads.innerText(), /d6fbe62a[\s\S]*₹40,000\.00/);
    step("spreads");

    const health = page.getByRole("heading", { name: "Data health" }).locator("..");
    const healthText = await health.innerText();
    assert.match(healthText, /1 row waits for review, ₹15,000\.00/);
    assert.match(healthText, /\$2\.35 of \$100\.00 this month/);
    assert.match(healthText, /Schema version 0009_ai_usage_text/);
    assert.match(healthText, /sbi-card ••04/);
    step("data health");

    // 3: the chat. KPI tiles render from the tool result, then the closing text.
    await page.getByRole("link", { name: "Chat" }).click();
    await page.getByRole("textbox", { name: "Your question" }).fill("How did September go?");
    await page.getByRole("button", { name: "Send" }).click();
    const result = page.locator(".tool-result");
    await result.waitFor();
    assert.match(await result.innerText(), /Key figures for 2026-09/);
    for (const [label, value] of [["Income", "₹1,51,200.50"], ["Savings", "₹76,044.75"]]) {
      assert.match(await result.getByRole("group", { name: label }).innerText(), new RegExp(value.replace(/[.]/g, "\\.")));
    }
    await page.getByText("These are the key figures for 2026-09 from the sample record.").waitFor();
    await page.getByRole("button", { name: "Send" }).waitFor();
    await page.getByText(/AI spend this month: \$0\.0[0-9]+ of \$100\.00 limit/).waitFor();
    step("chat: KPI tiles from the tool result, then the closing text, then the spend line");

    // 5: nothing of the chat is stored.
    const stored = await page.evaluate(async () => ({
      local: localStorage.length,
      session: Object.keys(sessionStorage),
      databases: (await indexedDB.databases()).length,
    }));
    assert.equal(stored.local, 0, "localStorage is empty");
    assert.deepEqual(stored.session, ["finos.session"]);
    assert.equal(stored.databases, 0, "no IndexedDB database");
    step("localStorage empty, sessionStorage holds only finos.session, no IndexedDB");

    // 4: a page on another port cannot use the API: the cookie goes along, the second value does
    // not, so the server answers 403. The browser hides the answer from that page; Playwright
    // sees it. A wrong Host gets 421 before routing, with and without a session.
    const stranger = await context.newPage();
    // Its own console error (CORS) is the point of the check, so it is not watched.
    await stranger.goto(`http://127.0.0.1:${otherPort}/`);
    const outcome = await stranger.evaluate(
      (url) => fetch(url, { credentials: "include" }).then(() => "read", () => "refused"),
      `${origin}/api/summary`,
    );
    assert.equal(outcome, "refused", "the other page cannot read the answer");
    // What that page's request carries: the context's cookie, and no X-Finos-Session. The
    // browser hides the status from that page (and from Playwright's page events); the
    // context's request client sends the same cookie and shows it.
    assert.equal((await context.request.get(`${origin}/api/summary`)).status(), 403);
    assert.equal((await context.request.get(`${origin}/api/summary`, { headers: { "x-finos-session": "x" } })).status(), 403);
    assert.equal(await raw(port, "/api/summary", "localhost:" + port), 421);
    assert.equal(await raw(port, "/api/summary", "evil.test"), 421);
    assert.equal(await raw(port, "/", "127.0.0.1"), 421);
    step("another port: 403; wrong Host: 421");
    await stranger.close();

    // 6: no CSP violation, no console error, no request outside 127.0.0.1.
    assert.deepEqual(await page.evaluate(() => window.__csp), [], "no CSP violation");
    assert.deepEqual(problems, [], "no console error");
    assert.deepEqual(outside, [], "no request leaves 127.0.0.1");
    step("no console error, no CSP violation, no request outside 127.0.0.1");

    // The launch link is for one use: a second use stops the fake backend, as the real server.
    assert.equal(await raw(port, new URL(fake.link).pathname + new URL(fake.link).search, `127.0.0.1:${port}`), 403);
    assert.equal(await fake.exited, 1, "the second use of the link stops the server");
    step("a second use of the launch link stops the server");
  } finally {
    await browser.close();
    fake.child.kill();
    await new Promise((resolve) => other.close(resolve));
  }
}

try {
  await main();
  console.log(`e2e ok (${steps.length} checks)`);
  for (const name of steps) console.log(`  ${name}`);
} catch (error) {
  console.error(`e2e failed after: ${steps.at(-1) ?? "start"}`);
  console.error(error);
  process.exitCode = 1;
}
