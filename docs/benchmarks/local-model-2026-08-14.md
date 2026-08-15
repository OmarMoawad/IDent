# Local model benchmark — 2026-08-14

Session 22, items 5–7. This replaces session 21's "39 s versus 4.1 s",
which was a pair of single cold wall-clock runs of a three-token reply with
no stated method — not a capacity benchmark, and not reproducible by
anyone else.

Reproduce with:

```bash
node scripts/benchmark-local-model.mjs --runs 5 --json out.json
```

## Method

| Parameter | Value |
| --- | --- |
| Prompt | `Answer with a single word only. What is the capital city of France?` |
| Expected answer | contains `paris`, checked on every run — a fast wrong answer is not a faster model |
| Sampling | `temperature: 0`, `seed: 42`, `num_ctx: 4096`, `num_predict: 16` |
| Request timeout | 120 000 ms |
| Runs per model | 1 cold + 5 warm |
| Cold start | model evicted with `keep_alive: 0`, then 1.5 s settle, then measured |
| Timing source | Ollama's own `total_duration` / `load_duration` / `prompt_eval_duration` / `eval_duration` (ns) — **not** wall-clock inference |
| Reported as | median with full min–max range |

`num_ctx` is pinned because context size changes both memory footprint and
prompt-eval time; leaving it at the model default would make the figures
unreproducible.

## Environment

| | |
| --- | --- |
| Machine | MacBookAir10,1, Apple M1 |
| Memory | 8 GiB **unified memory** — shared CPU/GPU. Apple Silicon has no separate VRAM pool; session 21's use of "VRAM" was wrong. |
| macOS | 15.7.9 (24G830) |
| Ollama | 0.32.9 |
| Measured at | 2026-08-14T15:38:25Z |

## Results

### llama3.2:3b — digest `a80c4f17acd5`, 3.2B, Q4_K_M, 1.88 GiB

| Phase | Median | Range |
| --- | --- | --- |
| Cold total | 8.078 s | single run (6.578 s of it weight loading) |
| Warm total | 0.716 s | 0.527 – 1.116 |
| Warm load | 0.560 s | 0.356 – 0.922 |
| Warm prompt eval | 0.053 s | 0.047 – 0.064 |
| Warm generation | 0.113 s | 0.094 – 0.138 |
| Generation throughput | **26.49 tok/s** | 21.77 – 31.93 |
| Prompt-eval throughput | 748.25 tok/s | 627.32 – 848.32 |

5/5 warm runs correct.

### llama3.1:8b — digest `46e0c10c039e`, 8.0B, Q4_K_M, 4.58 GiB

| Phase | Median | Range |
| --- | --- | --- |
| Cold total | **timed out at 120 s** | — |
| Warm total | 67.47 s | 66.877 – 70.641 |
| Warm load | 13.29 s | 10.593 – 13.99 |
| Warm prompt eval | 20.276 s | 14.943 – 22.035 |
| Warm generation | 33.118 s | 26.913 – 34.052 |
| Generation throughput | **0.09 tok/s** | 0.09 – 0.11 |
| Prompt-eval throughput | 1.23 tok/s | 1.13 – 1.67 |

5/5 warm runs correct — the 8B is not wrong, it is unusable on this
hardware.

## What this establishes

**The default stands, on better evidence than before.** `llama3.2:3b`
answers this prompt in 0.72 s warm against the 8B's 67 s, and both answer
it correctly every time. The 3B default costs nothing in accuracy on this
task and is ~94× faster end to end.

**The gap is not explained by model size alone.** The 8B has 2.5× the
parameters and 2.4× the weight bytes, but generates at **1/294th** the
throughput. A purely compute-bound difference would predict something near
the parameter ratio. 0.09 tok/s is ~11 seconds per token, which is not
what arithmetic on 8B parameters costs on this chip.

**The 8B never stays resident.** Its "warm" runs still pay 10.6–14.0 s of
`load_duration` on *every* call, back to back. The 3B's warm load is
0.36–0.92 s. Ollama is re-reading the 8B's weights each time because it
cannot keep 4.58 GiB resident alongside everything else on an 8 GiB
machine. The paging measurement below confirms this directly.

## Item 7 — the "93% memory occupancy caused the latency" claim

Session 21 asserted this as fact on the strength of wall-clock timing
alone, which the review correctly called an inference rather than a
measurement. It has now been **measured, and it is confirmed.**

`scripts/measure-memory-pressure.mjs` samples macOS's own paging counters
(`vm_stat`, `sysctl vm.swapusage`) either side of a single generation. Run
at 2026-08-14T15:58Z, with the Docker daemon stopped so the machine had
more headroom than during the benchmark above:

| Counter, delta across one generation | llama3.2:3b | llama3.1:8b |
| --- | --- | --- |
| Swap-ins (pages) | 92 | **340 255** |
| Swap-outs (pages) | **0** | **458 944** |
| Page-ins | 111 995 | 580 305 |
| Swap in use, after | 1 314 MiB | **3 148 MiB** (+1 835 MiB during the run) |
| Generation throughput | 22.62 tok/s | 1.06 tok/s |

At the 16 KiB page size of this machine, the 8B run wrote roughly **7.0 GiB
to swap and read back 5.2 GiB — during one reply of a few tokens.** The 3B
run, doing identical work, swapped out nothing at all.

That is the causal link session 21 lacked. The 8B's latency is paging: the
model cannot be held in 8 GiB of unified memory alongside a running OS, so
each forward pass faults its weights back off disk. The claim can now be
stated as measured rather than hypothesised — the specific figure "93%
occupancy", though, was never the measurement and should not be repeated;
what is established is that the 8B thrashes and the 3B does not.

Two honest caveats:

- These are whole-machine counters, not per-process. Nothing else was
  driving significant load, and the 3B control run isolates the model as
  the variable, but this is not process-attributed accounting.
- Getting here took three attempts. The first silently recorded zeroes
  because the script did not check `response.ok` (fixed — an error from
  Ollama read as a successful run with empty timings). The second failed
  with Ollama's Metal backend reporting `XPC_ERROR_CONNECTION_INVALID`
  after the earlier memory exhaustion; restarting `ollama serve` cleared
  it. Both failures are worth knowing about before trusting a quiet result
  from this script.

Related, and not a controlled measurement but worth recording: running the
8B benchmark earlier in this session exhausted memory badly enough to kill
the machine's Docker daemon, which had been up for ten hours. The 76
Receiptless test failures seen at 18:55 were that daemon's absence, not a
code regression — see RECEIPTLESS_STATE.md's evidence ledger.

## Why the numbers differ from session 21's

Session 21 reported 39 s (8B) and 4.1 s (3B). This run reports a 120 s
timeout and 8.1 s for the same cold comparison. The old figures did not
record whether the model was resident, what the context size was, what the
prompt was, or how many tokens were generated — so the two are not
comparable, and that is the point. Only the figures in this file, produced
by the committed script under the method above, should be cited.
