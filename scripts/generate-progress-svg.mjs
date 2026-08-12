#!/usr/bin/env node
// Regenerates docs/progress.svg from the phase/session data below. Run
// after any session that changes phase or session-cadence progress:
//
//   node scripts/generate-progress-svg.mjs
//
// Only PHASES and CURRENT below should need editing session to session —
// bump `sessionsDone` on the current phase, flip a phase's status to
// "done" and add the next one as "current" when a phase actually
// finishes. Phase list mirrors ROADMAP.md's own "## Phase N" headings —
// keep the two in sync if ROADMAP.md's phase list ever changes.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const PHASES = [
  { name: "Identity Core & Platform Foundation", status: "done" },
  { name: "Communications Hub", status: "current", sessionsDone: 3, sessionsTotal: 8 },
  { name: "Productivity & Real-Time Comms", status: "pending" },
  { name: "Documents, Credentials & Ed. Profile", status: "pending" },
  { name: "Health Profile", status: "pending" },
  { name: "Finance", status: "pending" },
  { name: "Physical World & Devices", status: "pending" },
  { name: "Life Logistics", status: "pending" },
  { name: "Personal & Discovery", status: "pending" },
  { name: "Deviceless / Alternative Access", status: "pending" },
  { name: "Telecommunications", status: "pending" },
];

const PROJECT_NAME = "IDent";
const TAGLINE = "Everything-app";
const ACCENT_LIGHT = "#4351c9";
const ACCENT_DARK = "#93a2ff";

writeFileSync(resolveOutPath(), renderSvg({ projectName: PROJECT_NAME, tagline: TAGLINE, phases: PHASES, accentLight: ACCENT_LIGHT, accentDark: ACCENT_DARK }));
console.log(`Wrote ${resolveOutPath()}`);

function resolveOutPath() {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../docs/progress.svg");
}

function computeOverallPercent(phases) {
  const total = phases.length;
  let doneUnits = 0;
  for (const phase of phases) {
    if (phase.status === "done") doneUnits += 1;
    else if (phase.status === "current") doneUnits += phase.sessionsDone / phase.sessionsTotal;
  }
  return (doneUnits / total) * 100;
}

function escapeXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderSvg({ projectName, tagline, phases, accentLight, accentDark }) {
  const width = 680;
  const barX = 24;
  const barWidth = width - 48;
  const barY = 74;
  const barHeight = 10;
  const segGap = 3;
  const segWidth = (barWidth - segGap * (phases.length - 1)) / phases.length;

  const overallPercent = computeOverallPercent(phases);
  const current = phases.find((p) => p.status === "current");
  const caption = current
    ? `Phase ${phases.indexOf(current)} of ${phases.length - 1} · "${current.name}" · ${current.sessionsDone}/${current.sessionsTotal} sessions`
    : "";

  const segments = phases
    .map((phase, i) => {
      const x = barX + i * (segWidth + segGap);
      const bg = `<rect x="${x.toFixed(2)}" y="${barY}" width="${segWidth.toFixed(2)}" height="${barHeight}" rx="3" class="seg-bg" />`;
      if (phase.status === "done") {
        return bg + `<rect x="${x.toFixed(2)}" y="${barY}" width="${segWidth.toFixed(2)}" height="${barHeight}" rx="3" class="seg-done" />`;
      }
      if (phase.status === "current") {
        const fillW = Math.max(segWidth * (phase.sessionsDone / phase.sessionsTotal), 3);
        return bg + `<rect x="${x.toFixed(2)}" y="${barY}" width="${fillW.toFixed(2)}" height="${barHeight}" rx="3" class="seg-current" />`;
      }
      return bg;
    })
    .join("\n    ");

  const height = 100;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeXml(projectName)} roadmap progress: ${overallPercent.toFixed(0)}%">
  <style>
    .bg { fill: #f6f4ef; }
    .card-border { stroke: #dedad2; }
    .ink { fill: #1b1d24; }
    .ink-soft { fill: #5b5f6e; }
    .ink-faint { fill: #8b8e9c; }
    .seg-bg { fill: #ece8e0; }
    .seg-done { fill: #2f8f5b; }
    .seg-current { fill: ${accentLight}; }
    .pct { fill: ${accentLight}; }
    text { font-family: -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif; }
    .serif { font-family: Georgia, "Times New Roman", serif; }
    @media (prefers-color-scheme: dark) {
      .bg { fill: #131318; }
      .card-border { stroke: #2c2d38; }
      .ink { fill: #edecf1; }
      .ink-soft { fill: #a3a3b4; }
      .ink-faint { fill: #6f7180; }
      .seg-bg { fill: #232430; }
      .seg-done { fill: #5fcf93; }
      .seg-current { fill: ${accentDark}; }
      .pct { fill: ${accentDark}; }
    }
  </style>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" class="bg card-border" stroke-width="1" />
  <text x="24" y="34" class="serif ink" font-size="19" font-weight="600">${escapeXml(projectName)}</text>
  <text x="24" y="50" class="ink-faint" font-size="11">${escapeXml(tagline)} · ${phases.length} phases</text>
  <text x="${width - 24}" y="42" text-anchor="end" class="serif pct" font-size="26" font-weight="600">${overallPercent.toFixed(0)}%</text>
  ${segments}
  <text x="24" y="94" class="ink-soft" font-size="11">${escapeXml(caption)}</text>
</svg>
`;
}
