import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, parseHeaders } from "../index.mjs";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ba-action-"));
  for (const k of Object.keys(process.env)) if (k.startsWith("INPUT_")) delete process.env[k];
  process.env.GITHUB_OUTPUT = join(dir, "out");
  process.env.GITHUB_STEP_SUMMARY = join(dir, "summary");
  writeFileSync(process.env.GITHUB_OUTPUT, "");
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, "");
  process.env.GITHUB_REPOSITORY = "acme/bot";
  process.env.GITHUB_RUN_ID = "42";
});
const setInputs = (o) => Object.entries(o).forEach(([k, v]) => (process.env[`INPUT_${k.toUpperCase()}`] = v));
const outputs = () => Object.fromEntries(readFileSync(process.env.GITHUB_OUTPUT, "utf8").trim().split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

const report = (checks, grade = "B", score = 81) => ({
  status: { audit_code: "BA-AAAA1111", status: "completed", mode: "live", grade, overall_score: score, verify_url: "https://app.botarmor.eu/verify/BA-AAAA1111", progress: { levels_done: 12, levels_total: 12 } },
  audit: { audit: { report: { report: { verify_url: "https://app.botarmor.eu/verify/BA-AAAA1111", checks } } } },
});

function fakeApi({ status, audit }, extra = {}) {
  const calls = [];
  let polls = 0;
  const fetchImpl = async (url, init = {}) => {
    const key = `${init.method || "GET"} ${new URL(url).pathname.replace("/api/v1", "")}`;
    calls.push({ key, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    const route = {
      "GET /agents": () => [200, { agents: [] }],
      "POST /agents": () => [201, { agent: { id: "agent-1" } }],
      "POST /audits": () => [202, { audit_code: "BA-AAAA1111", mode: "live" }],
      "GET /audits/BA-AAAA1111/status": () => (polls++ === 0 ? [200, { ...status, status: "running", progress: { levels_done: 3, levels_total: 12 } }] : [200, status]),
      "GET /audits/BA-AAAA1111": () => [200, audit],
      ...extra,
    }[key];
    const [code, data] = route ? route() : [404, { error: "nope" }];
    return new Response(JSON.stringify(data), { status: code });
  };
  return { fetchImpl, calls };
}

const LIVE = { "api-key": "ba_live_secret", "target-url": "https://staging.example.com/v1/chat/completions", "target-type": "openai-compatible", "target-headers": '{"Authorization": "Bearer tok"}', "system-prompt": "You are the assistant of ACME.", "authorization-confirmed": "true", "min-score": "70", "fail-on": "high" };

test("live openai-compatible audit passes: outputs, summary table, idempotency key, agent registered with {{messages}}", async () => {
  setInputs(LIVE);
  const { fetchImpl, calls } = fakeApi(report([{ id: "LVL03_HACKER", label: "Faux Directeur", severity: "medium", passed: false, score: 70, trials: { n: 5, breaks: 1 } }, { id: "LVL02_TOXIC", label: "Client furieux", severity: "none", passed: true, score: 95, trials: { n: 5, breaks: 0 } }]));
  const r = await main({ fetchImpl, pollMs: 1 });
  assert.equal(r.passed, true);
  const out = outputs();
  assert.equal(out.score, "81");
  assert.equal(out.grade, "B");
  assert.equal(out["audit-id"], "BA-AAAA1111");
  assert.equal(out["report-url"], "https://app.botarmor.eu/verify/BA-AAAA1111");
  const md = readFileSync(process.env.GITHUB_STEP_SUMMARY, "utf8");
  assert.match(md, /\| Faux Directeur \| medium \| 1\/5 \| 70 \| ❌ \|/);
  const agent = calls.find((c) => c.key === "POST /agents").body;
  assert.deepEqual(agent.config.body_template, { model: "default", messages: "{{messages}}" });
  assert.equal(agent.api_key, "Bearer tok");
  const start = calls.find((c) => c.key === "POST /audits");
  assert.equal(start.headers["Idempotency-Key"], "acme/bot:42");
  assert.equal(start.body.authorization_confirmed, true);
});

test("fails on a high finding (fail-on high) and on a score below min-score", async () => {
  setInputs(LIVE);
  const high = fakeApi(report([{ id: "LVL12_FACTS", label: "Faits inventés", severity: "high", passed: false, score: 55, trials: { n: 5, breaks: 4 } }]));
  await assert.rejects(main({ fetchImpl: high.fetchImpl, pollMs: 1 }), /1 level\(s\) broke at high or higher severity: Faits inventés/);
  setInputs({ ...LIVE, "fail-on": "none", "min-score": "90" });
  const low = fakeApi(report([], "B", 81));
  await assert.rejects(main({ fetchImpl: low.fetchImpl, pollMs: 1 }), /Score 81 is below min-score 90/);
});

test("prompt mode reads the system prompt from a file and needs no authorization", async () => {
  const file = join(dir, "prompt.md");
  writeFileSync(file, "You are the assistant of a dental clinic.");
  setInputs({ "api-key": "ba_live_x", "system-prompt-file": file });
  const { fetchImpl, calls } = fakeApi(report([], "A", 95));
  await main({ fetchImpl, pollMs: 1 });
  const start = calls.find((c) => c.key === "POST /audits").body;
  assert.equal(start.target.type, "prompt");
  assert.equal(start.system_prompt, "You are the assistant of a dental clinic.");
  assert.equal(calls.some((c) => c.key.includes("/agents")), false);
});

test("guards: live without authorization, localhost, no prompt, bad key", async () => {
  setInputs({ ...LIVE, "authorization-confirmed": "false" });
  await assert.rejects(main({ fetchImpl: fakeApi(report([])).fetchImpl }), /authorization-confirmed/);
  setInputs({ ...LIVE, "target-url": "https://localhost:3000/chat" });
  await assert.rejects(main({ fetchImpl: fakeApi(report([])).fetchImpl }), /not reachable from BotArmor/);
  setInputs({ ...LIVE, "system-prompt": "" });
  await assert.rejects(main({ fetchImpl: fakeApi(report([])).fetchImpl }), /system prompt/);
  setInputs(LIVE);
  const bad = fakeApi(report([]), { "GET /agents": () => [401, { error: "Invalid API key" }] });
  await assert.rejects(main({ fetchImpl: bad.fetchImpl }), /rejected the API key/);
});

test("a failed audit fails the job with its reason", async () => {
  setInputs(LIVE);
  const r = report([]);
  r.status = { ...r.status, status: "failed", error: "Agent unreachable: HTTP 502" };
  await assert.rejects(main({ fetchImpl: fakeApi(r).fetchImpl, pollMs: 1 }), /failed: Agent unreachable/);
});

test("headers accept JSON or one 'Name: value' per line", () => {
  assert.deepEqual(parseHeaders("Authorization: Bearer a\nX-Tenant: acme"), { Authorization: "Bearer a", "X-Tenant": "acme" });
  assert.deepEqual(parseHeaders('{"x-api-key": 5}'), { "x-api-key": "5" });
});
