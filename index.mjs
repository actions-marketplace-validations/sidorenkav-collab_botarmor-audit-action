// BotArmor audit GitHub Action: start an audit through the BotArmor API v1, poll it, write a Job Summary, set
// outputs and fail the job on a low score or a serious finding. No dependencies: GitHub's runner protocol is
// environment variables (INPUT_*, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY) and stdout commands.
import { appendFileSync, readFileSync } from "node:fs";

const SEVERITY = ["none", "low", "medium", "high", "critical"];
const LOCAL_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|127(\.\d+){3}|0\.0\.0\.0|10(\.\d+){3}|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2}|\[?::1\]?)$/i;
const SECRET_HEADER = /^(authorization|x-api-key|api-key|apikey|x-auth-token|x-access-token)$/i;

const input = (name) => (process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const mask = (value) => value && console.log(`::add-mask::${value}`);

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value ?? ""}\n`);
}
function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}
class Failure extends Error {}

export function parseHeaders(raw) {
  if (!raw) return {};
  if (raw.startsWith("{")) {
    try {
      return Object.fromEntries(Object.entries(JSON.parse(raw)).map(([k, v]) => [k, String(v)]));
    } catch {
      throw new Failure("target-headers is not valid JSON.");
    }
  }
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export function makeApi(baseUrl, apiKey, fetchImpl = fetch) {
  return async function api(method, path, body, headers = {}) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(`${baseUrl}${path}`, {
          method,
          headers: { authorization: `Bearer ${apiKey}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...headers },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        if (attempt < 3) { await sleep(5000 * (attempt + 1)); continue; }
        throw new Failure(`Cannot reach the BotArmor API: ${err.message}`);
      }
      const text = await res.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 200) }; }
      if (res.ok) return data;
      if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(Number(res.headers.get("retry-after") || 10) * 1000); continue; }
      const why = data.error || res.statusText;
      if (res.status === 401) throw new Failure("BotArmor rejected the API key: check the api-key secret.");
      if (res.status === 402) throw new Failure(`No BotArmor audit credit left (${why}).`);
      if (res.status === 403) throw new Failure(`BotArmor refused the audit: ${why}. Set authorization-confirmed: "true" only if you own the target bot or hold written permission.`);
      const err = new Failure(`BotArmor API error ${res.status}: ${why}`);
      err.status = res.status;
      throw err;
    }
  };
}

async function ensureAgent(api, { url, type, headers, model, name }) {
  const { agents = [] } = await api("GET", "/agents");
  const existing = agents.find((a) => a.endpoint_url === url && a.platform === "webhook");
  if (existing) return existing.id;
  const plain = {};
  let secret = null;
  for (const [k, v] of Object.entries(headers)) {
    if (!secret && SECRET_HEADER.test(k)) secret = { header: k, value: v };
    else plain[k] = v;
  }
  const config = { headers: plain, ...(secret ? { auth: { header: secret.header, prefix: "" } } : {}) };
  if (type === "openai-compatible") Object.assign(config, { body_template: { model: model || "default", messages: "{{messages}}" }, response_path: "choices.0.message.content" });
  const created = await api("POST", "/agents", { name: name || `${new URL(url).host} (GitHub Action)`, endpoint_url: url, ...(secret ? { api_key: secret.value } : {}), config });
  return created.agent?.id ?? created.id;
}

function failedLevels(checks, failOn) {
  if (failOn === "none") return [];
  const floor = failOn === "any" ? 1 : SEVERITY.indexOf(failOn);
  if (floor < 0) throw new Failure('fail-on must be critical, high, any or none.');
  return checks.filter((c) => c.passed === false && SEVERITY.indexOf(c.severity ?? "none") >= floor);
}

function summaryMarkdown(report, status, failing, minScore) {
  const checks = [...(report.checks ?? [])].filter((c) => c.trials || c.severity).sort((a, b) => SEVERITY.indexOf(b.severity ?? "none") - SEVERITY.indexOf(a.severity ?? "none"));
  return [
    `## BotArmor audit ${status.audit_code}: grade ${status.grade} (${status.overall_score}/100)`,
    `Mode: ${status.mode}. Minimum score: ${minScore}. [Signed report](${report.verify_url ?? status.verify_url})`,
    "",
    "| Level | Severity | Breaks | Score | Passed |",
    "|---|---|---|---|---|",
    ...checks.map((c) => `| ${c.label ?? c.id} | ${c.severity ?? "none"} | ${c.trials ? `${c.trials.breaks}/${c.trials.n}` : "-"} | ${c.score ?? "-"} | ${c.passed ? "✅" : "❌"} |`),
    "",
    failing.length ? `**${failing.length} level(s) at or above the fail-on severity.** The fixes to paste into the system prompt are in the dashboard report.` : "No level at or above the fail-on severity.",
  ].join("\n");
}

export async function main({ fetchImpl = fetch, pollMs = 20_000 } = {}) {
  const apiKey = input("api-key");
  if (!apiKey) throw new Failure("api-key is required (use a repository secret).");
  mask(apiKey);
  const headers = parseHeaders(input("target-headers"));
  Object.values(headers).forEach(mask);
  const url = input("target-url");
  const type = input("target-type") || (url ? "webhook" : "prompt");
  if (!["prompt", "webhook", "openai-compatible"].includes(type)) throw new Failure("target-type must be prompt, webhook or openai-compatible.");
  const promptFile = input("system-prompt-file");
  const systemPrompt = promptFile ? readFileSync(promptFile, "utf8") : input("system-prompt");
  if (!systemPrompt.trim()) throw new Failure("Give the agent's system prompt: system-prompt-file (path in the repository) or system-prompt.");
  const minScore = Number(input("min-score") || 0);
  const failOn = (input("fail-on") || "high").toLowerCase();
  const levels = input("levels").split(",").map((s) => s.trim()).filter(Boolean);
  const api = makeApi(input("api-url") || "https://app.botarmor.eu/api/v1", apiKey, fetchImpl);

  const body = {
    system_prompt: systemPrompt.slice(0, 8000),
    lang: input("lang") || "en",
    ...(levels.length ? { levels } : {}),
  };
  if (type === "prompt") {
    body.target = { type: "prompt", name: input("name") || process.env.GITHUB_REPOSITORY || "GitHub Action" };
  } else {
    if (!url) throw new Failure("target-url is required for a live audit.");
    const u = new URL(url);
    if (LOCAL_HOST.test(u.hostname)) throw new Failure(`${u.host} is not reachable from BotArmor's servers. Audit a deployed URL (staging), or use target-type: prompt.`);
    if (u.protocol !== "https:") throw new Failure("target-url must use https.");
    if (input("authorization-confirmed") !== "true") throw new Failure('A live audit needs authorization-confirmed: "true" (you own the bot or hold written permission).');
    body.target = { type: "webhook", agent_id: await ensureAgent(api, { url, type, headers, model: input("target-model"), name: input("name") }) };
    body.authorization_confirmed = true;
  }

  // One audit per run attempt: a network retry of the same request never bills twice.
  const idem = [process.env.GITHUB_REPOSITORY, process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT, process.env.GITHUB_JOB].filter(Boolean).join(":");
  const deadline = Date.now() + Number(input("timeout-minutes") || 40) * 60_000;
  let started;
  for (;;) {
    try {
      started = await api("POST", "/audits", body, idem ? { "Idempotency-Key": idem.slice(0, 200) } : {});
      break;
    } catch (err) {
      // One running audit per account: another job may hold it. Wait for it instead of failing.
      if (err.status === 409 && Date.now() < deadline) { log("Another audit is running on this account, waiting..."); await sleep(pollMs * 3); continue; }
      throw err;
    }
  }
  const code = started.audit_code;
  setOutput("audit-id", code);
  log(`BotArmor audit ${code} started (${started.mode}).`);

  let status;
  for (;;) {
    status = await api("GET", `/audits/${code}/status`);
    if (status.status !== "running") break;
    if (Date.now() > deadline) throw new Failure(`Audit ${code} still running after ${input("timeout-minutes") || 40} minutes. It continues on BotArmor; see the dashboard.`);
    const p = status.progress;
    log(p?.levels_total ? `… ${p.levels_done}/${p.levels_total} levels` : "… running");
    await sleep(pollMs);
  }
  setOutput("report-url", status.verify_url);
  if (status.status === "failed") throw new Failure(`Audit ${code} failed: ${status.error}`);

  const { audit } = await api("GET", `/audits/${code}`);
  const report = audit?.report?.report ?? {};
  const failing = failedLevels(report.checks ?? [], failOn);
  const scoreOk = (status.overall_score ?? 0) >= minScore;
  const passed = scoreOk && failing.length === 0;
  setOutput("score", status.overall_score);
  setOutput("grade", status.grade);
  setOutput("report-url", report.verify_url ?? status.verify_url);
  setOutput("passed", String(passed));
  summary(summaryMarkdown(report, status, failing, minScore));
  log(`Grade ${status.grade} (${status.overall_score}/100). ${report.verify_url ?? status.verify_url}`);
  if (!scoreOk) throw new Failure(`Score ${status.overall_score} is below min-score ${minScore}.`);
  if (failing.length) throw new Failure(`${failing.length} level(s) broke at ${failOn === "any" ? "any" : `${failOn} or higher`} severity: ${failing.map((c) => c.label ?? c.id).join(", ")}.`);
  return { code, passed };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  main().catch((err) => {
    console.log(`::error::${err.message}`);
    process.exitCode = 1;
  });
}
