#!/usr/bin/env node
/**
 * Phase 1 session 22 — a reproducible local-model benchmark.
 *
 * Session 21 recorded "39 s versus 4.1 s" and used it to pick the default
 * local model. Those were single cold wall-clock runs of a three-token
 * reply, which is not a capacity measurement, and the accompanying claim
 * that ~93% memory occupancy *caused* the latency was an inference from
 * wall-clock rather than anything measured. This script exists so the
 * numbers can be re-derived by someone else on their own hardware.
 *
 * What it records, per the method the review asked for:
 *   - hardware, total unified memory (Apple Silicon has no separate VRAM)
 *   - macOS and Ollama versions
 *   - model digest, parameter size, quantization
 *   - the prompt and the expected answer, checked not just timed
 *   - context size (num_ctx) and sampling settings
 *   - cold start (model evicted first) versus warm runs, separately
 *   - prompt-eval and generation durations separately, from Ollama's own
 *     timing fields rather than inferred from wall-clock
 *   - tokens/second for prompt eval and for generation
 *   - the request timeout used
 *   - N runs, reported as median and full range
 *
 * Usage:
 *   node scripts/benchmark-local-model.mjs                    # default models
 *   node scripts/benchmark-local-model.mjs --models llama3.2:3b --runs 5
 *   node scripts/benchmark-local-model.mjs --json out.json
 *
 * Requires a running Ollama (`ollama serve`) with the models pulled.
 */
import { execFileSync } from "node:child_process";
import { totalmem } from "node:os";
import { writeFileSync } from "node:fs";

const HOST = process.env.OLLAMA_HOST?.replace(/\/$/, "") || "http://127.0.0.1:11434";
const TIMEOUT_MS = Number(process.env.BENCHMARK_TIMEOUT_MS || 120_000);

/**
 * A fixed, checkable prompt. The expected answer matters as much as the
 * timing: a model that is fast because it answered the wrong question is
 * not a faster model. Kept deliberately short and unambiguous so that
 * "correct" is not a judgement call.
 */
const PROMPT = "Answer with a single word only. What is the capital city of France?";
const EXPECTED = "paris";

/**
 * Sampling is pinned so runs are comparable. Temperature 0 removes
 * sampling variance from the measurement; num_ctx is stated because a
 * larger context changes both memory footprint and prompt-eval time, and
 * leaving it at the model default would make the figure unreproducible.
 */
const OPTIONS = { temperature: 0, seed: 42, num_ctx: 4096, num_predict: 16 };

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const MODELS = (arg("models") || "llama3.2:3b,llama3.1:8b").split(",").map((m) => m.trim()).filter(Boolean);
const RUNS = Number(arg("runs", "5"));
const JSON_OUT = arg("json");

const ns = (value) => (value ?? 0) / 1e9;
const round = (value, places = 2) => Number(value.toFixed(places));

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function shell(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
}

async function ollama(path, body, { timeoutMs = TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${HOST}${path}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Total unified memory. On Apple Silicon this is shared with the GPU. */
function hardware() {
  const brand = shell("sysctl", ["-n", "machdep.cpu.brand_string"]);
  const model = shell("sysctl", ["-n", "hw.model"]);
  const macos = shell("sw_vers", ["-productVersion"]);
  const build = shell("sw_vers", ["-buildVersion"]);
  return {
    cpu: brand,
    model,
    totalMemoryGiB: round(totalmem() / 1024 ** 3),
    memoryNote: "Unified memory on Apple Silicon — shared CPU/GPU, not a separate VRAM pool.",
    macos: `${macos} (${build})`,
  };
}

async function modelFacts(model) {
  const tags = await ollama("/api/tags");
  const entry = tags.models?.find((m) => m.name === model || m.model === model);
  if (!entry) return { name: model, present: false };
  return {
    name: model,
    present: true,
    digest: entry.digest?.slice(0, 12) ?? null,
    sizeGiB: round((entry.size ?? 0) / 1024 ** 3),
    parameterSize: entry.details?.parameter_size ?? null,
    quantization: entry.details?.quantization_level ?? null,
    contextLength: entry.details?.context_length ?? null,
  };
}

/**
 * Evicting the model before the cold run is the difference between
 * measuring load time and measuring inference. `keep_alive: 0` unloads it;
 * Ollama then has to read the weights back from disk on the next call,
 * which is what `load_duration` captures.
 */
async function evict(model) {
  try {
    await ollama("/api/generate", { model, prompt: "", keep_alive: 0 }, { timeoutMs: 30_000 });
  } catch {
    /* Eviction is best-effort; a failure only means the run is less cold. */
  }
  await new Promise((resolve) => setTimeout(resolve, 1_500));
}

async function runOnce(model) {
  const startedAt = Date.now();
  let response;
  try {
    response = await ollama("/api/generate", { model, prompt: PROMPT, stream: false, options: OPTIONS });
  } catch (error) {
    return { ok: false, error: error.name === "AbortError" ? `timed out after ${TIMEOUT_MS} ms` : String(error.message ?? error) };
  }
  const wallClockS = (Date.now() - startedAt) / 1000;

  const answer = (response.response ?? "").trim();
  const promptEvalS = ns(response.prompt_eval_duration);
  const evalS = ns(response.eval_duration);

  return {
    ok: true,
    // Correctness first — a fast wrong answer is not a faster model.
    correct: answer.toLowerCase().includes(EXPECTED),
    answer,
    wallClockS: round(wallClockS, 3),
    totalS: round(ns(response.total_duration), 3),
    // The field session 21 never looked at: time spent reading weights
    // into memory, which is most of a cold run and none of a warm one.
    loadS: round(ns(response.load_duration), 3),
    promptEvalTokens: response.prompt_eval_count ?? 0,
    promptEvalS: round(promptEvalS, 3),
    promptEvalTokensPerS: promptEvalS > 0 ? round((response.prompt_eval_count ?? 0) / promptEvalS) : null,
    generatedTokens: response.eval_count ?? 0,
    generationS: round(evalS, 3),
    generationTokensPerS: evalS > 0 ? round((response.eval_count ?? 0) / evalS) : null,
  };
}

function summarize(runs) {
  const ok = runs.filter((run) => run.ok);
  if (ok.length === 0) return { runs: runs.length, succeeded: 0 };
  const stat = (key) => {
    const values = ok.map((run) => run[key]).filter((value) => typeof value === "number");
    if (values.length === 0) return null;
    return { median: round(median(values), 3), min: round(Math.min(...values), 3), max: round(Math.max(...values), 3) };
  };
  return {
    runs: runs.length,
    succeeded: ok.length,
    allCorrect: ok.every((run) => run.correct),
    totalS: stat("totalS"),
    loadS: stat("loadS"),
    promptEvalS: stat("promptEvalS"),
    generationS: stat("generationS"),
    generationTokensPerS: stat("generationTokensPerS"),
    promptEvalTokensPerS: stat("promptEvalTokensPerS"),
  };
}

async function main() {
  const version = await ollama("/api/version").catch(() => ({ version: "unavailable" }));
  const env = hardware();

  const report = {
    method: {
      prompt: PROMPT,
      expectedAnswer: EXPECTED,
      samplingOptions: OPTIONS,
      timeoutMs: TIMEOUT_MS,
      runsPerModel: RUNS,
      coldStart: "Model evicted with keep_alive:0 before run 1; runs 2..N are warm.",
      timingSource: "Ollama's own total/load/prompt_eval/eval duration fields (ns), not wall-clock inference.",
    },
    environment: { ...env, ollama: version.version, host: HOST, measuredAt: new Date().toISOString() },
    models: {},
  };

  for (const model of MODELS) {
    const facts = await modelFacts(model);
    process.stderr.write(`\n== ${model} ==\n`);
    if (!facts.present) {
      process.stderr.write(`  not pulled; skipping\n`);
      report.models[model] = { facts, skipped: "not pulled on this machine" };
      continue;
    }

    await evict(model);
    process.stderr.write(`  cold run...\n`);
    const cold = await runOnce(model);
    process.stderr.write(`  cold: ${cold.ok ? `${cold.totalS}s total, ${cold.loadS}s load` : cold.error}\n`);

    const warm = [];
    for (let i = 0; i < RUNS; i += 1) {
      process.stderr.write(`  warm run ${i + 1}/${RUNS}...\n`);
      const run = await runOnce(model);
      process.stderr.write(`  warm ${i + 1}: ${run.ok ? `${run.totalS}s total, ${run.generationTokensPerS} tok/s` : run.error}\n`);
      warm.push(run);
    }

    report.models[model] = { facts, cold, warm, warmSummary: summarize(warm) };
  }

  const serialized = JSON.stringify(report, null, 2);
  if (JSON_OUT) {
    writeFileSync(JSON_OUT, serialized);
    process.stderr.write(`\nWrote ${JSON_OUT}\n`);
  } else {
    process.stdout.write(serialized + "\n");
  }
}

main().catch((error) => {
  process.stderr.write(`benchmark failed: ${error.message}\n`);
  process.exit(1);
});
