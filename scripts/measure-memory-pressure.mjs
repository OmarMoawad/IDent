#!/usr/bin/env node
/**
 * Phase 1 session 22, item 7 — settle the memory-pressure question with a
 * measurement instead of an inference.
 *
 * Session 21 asserted that the 8B model occupying ~93% of available memory
 * *caused* its latency. That was a guess from wall-clock timing. This
 * script samples macOS's own paging counters (`vm_stat`, `sysctl
 * vm.swapusage`) either side of a generation, so the claim can be
 * confirmed, refuted, or left open on evidence.
 *
 * What counts as confirmation: a run that drives swap-ins, swap-outs, or
 * compressor activity substantially above the idle baseline, while a
 * smaller model doing the same work does not. What counts as refutation:
 * the large model running slowly with paging counters flat, which would
 * point at compute rather than memory.
 *
 * Usage:
 *   node scripts/measure-memory-pressure.mjs --models llama3.2:3b,llama3.1:8b
 */
import { execFileSync } from "node:child_process";

const HOST = process.env.OLLAMA_HOST?.replace(/\/$/, "") || "http://127.0.0.1:11434";
const TIMEOUT_MS = Number(process.env.BENCHMARK_TIMEOUT_MS || 180_000);
const PROMPT = "Answer with a single word only. What is the capital city of France?";

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const MODELS = (arg("models") || "llama3.2:3b,llama3.1:8b").split(",").map((m) => m.trim()).filter(Boolean);

const PAGE_SIZE = 16384; // Apple Silicon

/** Parse the counters that indicate real memory pressure, not just usage. */
function vmStat() {
  const raw = execFileSync("vm_stat", { encoding: "utf8" });
  const read = (label) => {
    const match = raw.match(new RegExp(`${label}:\\s+(\\d+)`));
    return match ? Number(match[1]) : 0;
  };
  const swap = execFileSync("sysctl", ["-n", "vm.swapusage"], { encoding: "utf8" }).trim();
  const used = swap.match(/used\s*=\s*([\d.]+)M/);
  return {
    swapins: read("Swapins"),
    swapouts: read("Swapouts"),
    compressions: read("Compressor_page_count|Pages occupied by compressor"),
    pageins: read("Pageins"),
    pageouts: read("Pageouts"),
    compressorPagesMiB: Math.round((read("Pages occupied by compressor") * PAGE_SIZE) / 1024 ** 2),
    freePagesMiB: Math.round((read("Pages free") * PAGE_SIZE) / 1024 ** 2),
    swapUsedMiB: used ? Number(used[1]) : 0,
  };
}

const delta = (before, after) =>
  Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]]));

async function generate(model) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetch(`${HOST}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: PROMPT, stream: false, options: { temperature: 0, seed: 42, num_ctx: 4096, num_predict: 16 } }),
      signal: controller.signal,
    });
    // Ollama reports an out-of-memory or load failure as a non-2xx with a
    // JSON body. Without this check a failed run reads as a successful one
    // with empty timings — which is exactly how the first attempt at this
    // measurement produced meaningless zeroes.
    if (!response.ok) {
      const body = await response.text();
      return { ok: false, wallClockS: Number(((Date.now() - started) / 1000).toFixed(2)), error: `HTTP ${response.status}: ${body.slice(0, 300)}` };
    }
    const json = await response.json();
    if (json.error) {
      return { ok: false, wallClockS: Number(((Date.now() - started) / 1000).toFixed(2)), error: String(json.error).slice(0, 300) };
    }
    if (!json.eval_count) {
      return { ok: false, wallClockS: Number(((Date.now() - started) / 1000).toFixed(2)), error: `no tokens generated; raw: ${JSON.stringify(json).slice(0, 300)}` };
    }
    return {
      ok: true,
      wallClockS: Number(((Date.now() - started) / 1000).toFixed(2)),
      generationTokensPerS: json.eval_duration ? Number(((json.eval_count ?? 0) / (json.eval_duration / 1e9)).toFixed(2)) : null,
      loadS: Number(((json.load_duration ?? 0) / 1e9).toFixed(2)),
    };
  } catch (error) {
    return { ok: false, wallClockS: Number(((Date.now() - started) / 1000).toFixed(2)), error: error.name === "AbortError" ? `timed out after ${TIMEOUT_MS} ms` : String(error.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const idleA = vmStat();
  await new Promise((r) => setTimeout(r, 5_000));
  const idleB = vmStat();
  const baseline = delta(idleA, idleB);
  console.log("## Idle baseline over 5 s (what the machine does when asked nothing)");
  console.log(JSON.stringify(baseline, null, 1));

  for (const model of MODELS) {
    // Evict so each model starts from the same place.
    await fetch(`${HOST}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: "", keep_alive: 0 }),
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 3_000));

    const before = vmStat();
    const result = await generate(model);
    const after = vmStat();

    console.log(`\n## ${model}`);
    console.log("result:", JSON.stringify(result));
    console.log("paging delta during the run:", JSON.stringify(delta(before, after), null, 1));
    console.log("free memory after (MiB):", after.freePagesMiB, "| swap used (MiB):", after.swapUsedMiB);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
