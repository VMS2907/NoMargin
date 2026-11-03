import { BenchmarkSession, JOB_SIZES, amdahl, runScalingExperiment, runSizeExperiment, slicesFor } from "./benchmark.js";
import { columnChart, lineChart } from "./charts.js";

const $ = (selector) => document.querySelector(selector);

const reportedCores = Number(navigator.hardwareConcurrency) || 0;
const maximumWorkers = Math.min(16, Math.max(2, reportedCores || 4));
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const GRID_SIZE = 32;
const REPLAY_MS = 6000;

const state = { session: null, result: null, selected: null, sizeResult: null };

/* ---------- Formatting ---------- */

const number = (value, digits = 0) => value.toLocaleString("en", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

function formatMs(value) {
  if (value < 1) return `${number(value, 3)} ms`;
  if (value < 100) return `${number(value, 1)} ms`;
  return `${number(value)} ms`;
}

function formatSteps(order) {
  const steps = order ** 3;
  return steps >= 1e9 ? `${number(steps / 1e9, 2)} billion` : `${number(steps / 1e6)} million`;
}

/* ---------- Matrix drawing (hero, split demo, race) ---------- */

function drawMatrix(canvas, { workers, progress, color }) {
  const context = canvas.getContext("2d");
  const size = canvas.clientWidth;
  if (!size) return;
  const ratio = devicePixelRatio || 1;
  if (canvas.width !== Math.round(size * ratio)) {
    canvas.width = Math.round(size * ratio);
    canvas.height = Math.round(size * ratio);
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, size, size);

  const styles = getComputedStyle(document.documentElement);
  const empty = styles.getPropertyValue("--cell-empty");
  const fill = styles.getPropertyValue(color);
  const slices = slicesFor(GRID_SIZE, workers);
  const bandGap = workers > 1 ? Math.max(2, size * 0.012) : 0;
  const gap = Math.max(1, size * 0.005);
  const cell = (size - gap * (GRID_SIZE - 1) - bandGap * (workers - 1)) / GRID_SIZE;

  slices.forEach((slice, band) => {
    const rows = slice.end - slice.start;
    const done = Math.floor(progress * rows * GRID_SIZE + 1e-6);
    for (let row = 0; row < rows; row += 1) {
      const top = (slice.start + row) * (cell + gap) + band * bandGap;
      for (let column = 0; column < GRID_SIZE; column += 1) {
        const left = column * (cell + gap);
        const filled = row * GRID_SIZE + column < done;
        context.fillStyle = filled ? fill : empty;
        context.globalAlpha = filled && band % 2 === 1 ? 0.72 : 1;
        context.fillRect(left, top, cell, cell);
      }
    }
  });
  context.globalAlpha = 1;
}

const hero = {
  sequential: $("#heroSequential"),
  parallel: $("#heroParallel"),
  visible: true,
  started: performance.now(),
};

function drawHero(now) {
  const elapsed = (now - hero.started) % 8000;
  // Illustrative only: 4 workers at a little under 4× to hint at overhead.
  drawMatrix(hero.sequential, { workers: 1, progress: Math.min(1, elapsed / 6500), color: "--sequential" });
  drawMatrix(hero.parallel, { workers: 4, progress: Math.min(1, elapsed / 2000), color: "--parallel" });
}

function heroLoop(now) {
  // Nothing animates during a benchmark, so the page doesn't disturb its own timings.
  if (hero.visible && !state.session) drawHero(now);
  requestAnimationFrame(heroLoop);
}

new IntersectionObserver(([entry]) => { hero.visible = entry.isIntersecting; }).observe($(".hero-race"));

function drawHeroStill() {
  drawMatrix(hero.sequential, { workers: 1, progress: 0.3, color: "--sequential" });
  drawMatrix(hero.parallel, { workers: 4, progress: 1, color: "--parallel" });
}

function setRangeFill(input) {
  const ratio = ((Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100;
  input.style.setProperty("--fill", `${ratio}%`);
}

/* ---------- Controls ---------- */

const workerRange = $("#workerRange");
const runButton = $("#runButton");
const cancelButton = $("#cancelButton");
const sizeRunButton = $("#sizeRunButton");

workerRange.max = String(maximumWorkers);
workerRange.value = String(Math.min(8, maximumWorkers));
$("#hardwareNote").textContent = reportedCores
  ? `Your browser reports ${plural(reportedCores, "logical processor")}.`
  : "Your browser doesn't report a processor count, so this is capped at 4.";
$("#deviceLine").textContent = reportedCores
  ? `This device reports ${plural(reportedCores, "logical processor")}. Everything runs in your browser and nothing you measure is uploaded.`
  : "Everything runs in your browser and nothing you measure is uploaded.";

const selectedOrder = () => Number($('input[name="order"]:checked').value);
const selectedRounds = () => Number($('input[name="rounds"]:checked').value);

function updateControls() {
  const workers = Number(workerRange.value);
  $("#workerOutput").textContent = plural(workers, "worker");
  $("#sizeNote").textContent = `${formatSteps(selectedOrder())} multiply-add steps per run.`;
  setRangeFill(workerRange);
}
workerRange.addEventListener("input", updateControls);
for (const input of document.querySelectorAll('input[name="order"]')) input.addEventListener("change", updateControls);

function setRunning(running, mainExperiment) {
  runButton.hidden = running && mainExperiment;
  cancelButton.hidden = !(running && mainExperiment);
  runButton.disabled = running;
  $("#heroRunButton").disabled = running;
  sizeRunButton.disabled = running;
  sizeRunButton.textContent = running && !mainExperiment ? "Testing…" : state.sizeResult ? "Run the test again" : "Run the small-job test";
  for (const input of document.querySelectorAll("#labForm input")) input.disabled = running;
}

/* ---------- Experiment 1: scaling ---------- */

function renderLights(total, active) {
  const lights = $("#coreLights");
  if (lights.children.length !== total) lights.innerHTML = "<i></i>".repeat(total);
  [...lights.children].forEach((light, index) => light.classList.toggle("on", index < active));
}

function describeProgress({ phase, round, rounds, active }) {
  if (phase === "prepare") return "Generating the matrices and starting the workers";
  if (phase === "warmup") return "Warming up. This part isn't timed";
  return `Round ${round} of ${rounds}: timing ${plural(active, "worker")}`;
}

async function runExperiment() {
  if (state.session) return;
  const config = { order: selectedOrder(), maxWorkers: Number(workerRange.value), rounds: selectedRounds() };
  stopRace();
  const session = new BenchmarkSession(config.maxWorkers);
  state.session = session;
  setRunning(true, true);
  $("#labError").hidden = true;
  $("#progressPanel").hidden = false;

  try {
    const result = await runScalingExperiment(session, config, (progress) => {
      $("#progressTitle").textContent = describeProgress(progress);
      $("#progressBar").style.width = `${progress.fraction * 100}%`;
      renderLights(config.maxWorkers, progress.active);
    });
    session.close();
    state.session = null;
    state.result = result;
    state.selected = bestRow(result).workers;
    $("#progressPanel").hidden = true;
    showResults();
  } catch (error) {
    session.close();
    state.session = null;
    $("#progressPanel").hidden = true;
    if (!session.cancelled) {
      $("#labError").textContent = "The experiment couldn't finish. Reload the page and try a smaller job.";
      $("#labError").hidden = false;
      console.error(error);
    }
  } finally {
    setRunning(false, true);
  }
}

const parallelRows = (result) => result.rows.filter((row) => row.workers > 1);
const bestRow = (result) => parallelRows(result).reduce((best, row) => (row.speedup > best.speedup ? row : best));

function sweetSpot(result) {
  const best = bestRow(result);
  return parallelRows(result).find((row) => row.speedup >= best.speedup * 0.9) || best;
}

const selectedRow = () => state.result.rows.find((row) => row.workers === state.selected);

function showResults() {
  $("#preview").hidden = true;
  $("#results").hidden = false;
  renderVerdict();
  renderChips();
  renderSelection();
  renderDataTable();
  renderFindings();
}

function renderVerdict() {
  const { rows } = state.result;
  const best = bestRow(state.result);
  const spot = sweetSpot(state.result);
  const sequential = rows[0];
  if (best.speedup <= 1) {
    $("#verdictText").innerHTML = `Splitting the work <strong>didn't help</strong> on this run: ${plural(best.workers, "worker")} took ${formatMs(best.milliseconds)} against ${formatMs(sequential.milliseconds)} for one.`;
    $("#verdictNote").textContent = "Overhead outweighed the gain. Close other apps and try a larger job.";
    return;
  }
  $("#verdictText").innerHTML = `${plural(best.workers, "worker").replace(/^./, (letter) => letter.toUpperCase())} finished the job <strong>${number(best.speedup, 1)}× faster</strong>, taking ${formatMs(best.milliseconds)} instead of ${formatMs(sequential.milliseconds)}.`;
  $("#verdictNote").textContent = spot.workers < best.workers
    ? `The sweet spot is ${plural(spot.workers, "worker")}. Going beyond it added less than 10% more speedup.`
    : `Speedup peaked at ${plural(best.workers, "worker")}, where each one was ${number(best.efficiency * 100)}% efficient.`;
}

function renderChips() {
  $("#workerChips").innerHTML = parallelRows(state.result)
    .map((row) => `<button type="button" class="chip" data-workers="${row.workers}" aria-pressed="false">${row.workers}</button>`)
    .join("");
}
$("#workerChips").addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (chip) selectWorkers(Number(chip.dataset.workers));
});

function selectWorkers(workers) {
  if (workers < 2 || workers === state.selected) return;
  state.selected = workers;
  renderSelection();
}

function renderSelection() {
  const row = selectedRow();
  const sequential = state.result.rows[0];
  for (const chip of document.querySelectorAll(".chip")) {
    chip.setAttribute("aria-pressed", String(Number(chip.dataset.workers) === row.workers));
  }
  $("#timeValue").textContent = formatMs(row.milliseconds);
  $("#timeNote").textContent = `${plural(row.workers, "worker")}, against ${formatMs(sequential.milliseconds)} for 1`;
  $("#speedupValue").textContent = `${number(row.speedup, 2)}×`;
  $("#speedupNote").textContent = `${formatMs(sequential.milliseconds)} ÷ ${formatMs(row.milliseconds)}`;
  $("#efficiencyValue").textContent = `${number(row.efficiency * 100)}%`;
  $("#efficiencyNote").textContent = `${number(row.speedup, 2)}× ÷ ${plural(row.workers, "worker")}`;
  const allMatch = state.result.rows.every((entry) => entry.match.matches);
  $("#matchValue").textContent = allMatch ? "✓ Identical" : "✕ Mismatch";
  $("#matchValue").classList.toggle("is-bad", !allMatch);
  $("#matchNote").textContent = allMatch
    ? `All ${state.result.rows.length} worker counts gave the same matrix`
    : "A worker count produced a different matrix";
  renderResultCharts();
  startRace(sequential.milliseconds, row.milliseconds, row.workers);
}

function renderResultCharts() {
  const { rows, serialFraction } = state.result;
  const counts = rows.map((row) => row.workers);
  const selectedIndex = state.selected - 1;
  const best = bestRow(state.result);
  const yMax = Math.max(rows.length, ...rows.map((row) => row.speedup));
  const tooltip = (index) => {
    const row = rows[index];
    return `<strong>${plural(row.workers, "worker")}</strong><span>Time ${formatMs(row.milliseconds)}</span><span>Speedup ${number(row.speedup, 2)}×</span><span>Efficiency ${number(row.efficiency * 100)}%</span>`;
  };
  const onSelect = (index) => selectWorkers(index + 1);

  lineChart($("#speedupChart"), {
    label: "Measured speedup compared with perfect scaling",
    height: 360,
    xValues: counts,
    xLabel: "Number of workers",
    yMax,
    yFormat: (value) => `${number(value, Number.isInteger(value) ? 0 : 1)}×`,
    series: [
      { style: "ideal", values: counts },
      { style: "fit", values: counts.map((count) => amdahl(serialFraction, count)) },
      { style: "measured", values: rows.map((row) => row.speedup) },
    ],
    directLabels: [{ index: best.workers - 1, value: best.speedup, text: `${number(best.speedup, 1)}×`, position: "below", anchor: best.workers === rows.length ? "end" : "middle" }],
    selectedIndex,
    tooltip,
    onSelect,
  });

  columnChart($("#timeChart"), {
    label: "Median execution time at each worker count",
    height: 280,
    xValues: counts,
    xLabel: "Number of workers",
    values: rows.map((row) => row.milliseconds),
    yMax: rows[0].milliseconds * 1.15,
    yFormat: (value, exact) => (exact ? formatMs(value) : value >= 1000 ? `${number(value / 1000, value % 1000 ? 1 : 0)}K` : number(value)),
    barClass: (index) => (index === 0 ? "c-bar-sequential" : "c-bar-parallel"),
    labelled: [0, selectedIndex],
    selectedIndex,
    tooltip,
    onSelect,
  });

  columnChart($("#efficiencyChart"), {
    label: "Parallel efficiency at each worker count",
    height: 280,
    xValues: counts,
    xLabel: "Number of workers",
    values: rows.map((row) => row.efficiency * 100),
    yMax: Math.max(100, ...rows.map((row) => row.efficiency * 100)),
    yFormat: (value) => `${number(value)}%`,
    barClass: (index) => (index === 0 ? "c-bar-sequential" : "c-bar-parallel"),
    labelled: [selectedIndex],
    selectedIndex,
    tooltip,
    onSelect,
  });
}

/* ---------- Race replay ---------- */

const race = { frame: 0 };

function stopRace() {
  cancelAnimationFrame(race.frame);
  race.frame = 0;
}

function startRace(sequentialMs, parallelMs, workers) {
  stopRace();
  const slowest = Math.max(sequentialMs, parallelMs);
  const slowdown = REPLAY_MS / slowest;
  $("#raceWorkers").textContent = plural(workers, "worker");
  $("#raceNote").textContent = slowdown > 1
    ? `Measured times, slowed down ${number(slowdown)}× so you can watch them.`
    : "Measured times, shown at real speed.";
  const paint = (replayed) => {
    const sequentialElapsed = Math.min(sequentialMs, replayed / slowdown);
    const parallelElapsed = Math.min(parallelMs, replayed / slowdown);
    drawMatrix($("#raceSequential"), { workers: 1, progress: sequentialElapsed / sequentialMs, color: "--sequential" });
    drawMatrix($("#raceParallel"), { workers, progress: parallelElapsed / parallelMs, color: "--parallel" });
    $("#raceSequentialTime").textContent = formatMs(sequentialElapsed);
    $("#raceParallelTime").textContent = formatMs(parallelElapsed);
  };
  if (reducedMotion) {
    paint(REPLAY_MS);
    return;
  }
  const started = performance.now();
  const tick = (now) => {
    const replayed = Math.min(REPLAY_MS, now - started);
    paint(replayed);
    race.frame = replayed < REPLAY_MS && !state.session ? requestAnimationFrame(tick) : 0;
  };
  race.frame = requestAnimationFrame(tick);
}

$("#replayButton").addEventListener("click", () => {
  const row = selectedRow();
  startRace(state.result.rows[0].milliseconds, row.milliseconds, row.workers);
});

/* ---------- Tables and export ---------- */

function renderDataTable() {
  $("#dataRows").innerHTML = state.result.rows.map((row) => `<tr>
    <td>${row.workers}</td>
    <td>${formatMs(row.milliseconds)}</td>
    <td>${number(row.speedup, 2)}×</td>
    <td>${number(row.efficiency * 100)}%</td>
    <td class="muted-cell">${row.times.map((time) => number(time, 1)).join(", ")}</td>
    <td>${row.match.matches ? "✓ Match" : "✕ Differs"}</td>
  </tr>`).join("");
}

$("#downloadButton").addEventListener("click", () => {
  const result = state.result;
  const rows = [
    ["timestamp_utc", result.timestamp.toISOString()],
    ["matrix_order", result.order],
    ["multiply_add_steps", result.order ** 3],
    ["measured_rounds", result.rounds],
    ["amdahl_fit_serial_fraction", result.serialFraction],
    [],
    ["workers", "median_ms", "speedup", "efficiency_percent", "outputs_match", "max_relative_difference", "round_times_ms"],
    ...result.rows.map((row) => [row.workers, row.milliseconds, row.speedup, row.efficiency * 100, row.match.matches, row.match.maximumRelativeDifference, row.times.join(" | ")]),
  ];
  const csv = rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `parallel-lab-${result.order}x${result.order}-${result.timestamp.toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
});

/* ---------- Preview chart (theory only, before any run) ---------- */

function renderPreview() {
  const counts = Array.from({ length: Number(workerRange.value) }, (_, index) => index + 1);
  lineChart($("#previewChart"), {
    label: "Perfect scaling, before any measurement",
    height: 300,
    xValues: counts,
    xLabel: "Number of workers",
    yMax: counts.length,
    yFormat: (value) => `${number(value, Number.isInteger(value) ? 0 : 1)}×`,
    series: [{ style: "ideal", values: counts }],
    directLabels: [{ index: counts.length - 1, value: counts.length, text: "Perfect scaling", position: "below", anchor: "end", dx: -10 }],
    tooltip: (index) => `<strong>${plural(counts[index], "worker")}</strong><span>Perfect scaling would be ${counts[index]}× faster</span>`,
    message: "No measurements yet. Press <b>Run the experiment</b>.",
  });
}
workerRange.addEventListener("input", renderPreview);

/* ---------- Experiment 2: job size ---------- */

async function runSizeTest() {
  if (state.session) return;
  stopRace();
  const workers = Math.min(4, maximumWorkers);
  const session = new BenchmarkSession(workers);
  state.session = session;
  setRunning(true, false);
  $("#sizeProgress").hidden = false;
  $("#sizeVerdict").hidden = true;
  try {
    state.sizeResult = await runSizeExperiment(session, { workers }, ({ fraction }) => {
      $("#sizeProgressBar").style.width = `${fraction * 100}%`;
    });
    session.close();
    state.session = null;
    renderSizeResult();
    renderFindings();
  } catch (error) {
    session.close();
    state.session = null;
    $("#sizeVerdict").textContent = "The test couldn't finish. Reload the page and try again.";
    $("#sizeVerdict").hidden = false;
    console.error(error);
  } finally {
    $("#sizeProgress").hidden = true;
    setRunning(false, false);
  }
}

// The smallest size from which parallel wins at this size and every larger one.
function breakEven(rows) {
  let index = rows.length;
  while (index > 0 && rows[index - 1].speedup > 1) index -= 1;
  return index < rows.length ? rows[index] : null;
}

function renderSizeResult() {
  const { rows, workers } = state.sizeResult;
  const smallest = rows[0];
  const largest = rows[rows.length - 1];
  const turning = breakEven(rows);
  let verdict;
  if (!turning) {
    verdict = `With ${workers} workers, parallel never beat sequential at these sizes on this run.`;
  } else if (turning === smallest) {
    verdict = `With ${workers} workers, parallel won at every size, but the gain shrank from ${number(largest.speedup, 1)}× at ${largest.order} × ${largest.order} to ${number(smallest.speedup, 1)}× at ${smallest.order} × ${smallest.order}.`;
  } else {
    verdict = `With ${workers} workers, parallel only pays off from about ${turning.order} × ${turning.order}. At ${smallest.order} × ${smallest.order} it is ${number(1 / smallest.speedup, 1)}× slower than one worker.`;
  }
  $("#sizeVerdict").textContent = verdict;
  $("#sizeVerdict").hidden = false;
  columnChart($("#sizeChart"), {
    label: "Speedup at each matrix size",
    height: 280,
    xValues: JOB_SIZES,
    xLabel: "Matrix size (n × n)",
    values: rows.map((row) => row.speedup),
    yMax: Math.max(1.5, ...rows.map((row) => row.speedup)) * 1.15,
    yFormat: (value, exact) => `${number(value, exact || !Number.isInteger(value) ? 1 : 0)}×`,
    barClass: (index) => (rows[index].speedup >= 1 ? "c-bar-parallel" : "c-bar-sequential"),
    labelled: rows.map((_, index) => index),
    reference: { value: 1 },
    tooltip: (index) => `<strong>${rows[index].order} × ${rows[index].order}</strong><span>1 worker ${formatMs(rows[index].sequentialMedian)}</span><span>${workers} workers ${formatMs(rows[index].parallelMedian)}</span><span>Speedup ${number(rows[index].speedup, 2)}×</span>`,
  });
}

/* ---------- Findings, written from the data ---------- */

const GENERIC_BENEFITS = [
  "Heavy calculations can finish in a fraction of the time on the same chip.",
  "The answer stays correct, because splitting by row doesn't change the arithmetic.",
  "Hardware that would otherwise sit idle gets used.",
];

const GENERIC_LIMITATIONS = [
  "Speedup falls short of the worker count, and each extra worker tends to help less.",
  "Any part of a program that must run serially caps the maximum speedup (Amdahl's law).",
  "On small jobs, coordination overhead can make parallel slower than sequential.",
];

function renderFindings() {
  const benefits = [...GENERIC_BENEFITS];
  const limitations = [...GENERIC_LIMITATIONS];
  const { result, sizeResult } = state;

  if (result) {
    const best = bestRow(result);
    const first = result.rows[1];
    const last = result.rows[result.rows.length - 1];
    const allMatch = result.rows.every((row) => row.match.matches);
    $("#findingsLede").textContent = best.speedup > 1
      ? `On this device, parallel processing made a ${result.order} × ${result.order} matrix multiplication ${number(best.speedup, 1)}× faster. It also stopped well short of perfect, for reasons you can see in the data.`
      : `On this device, for a ${result.order} × ${result.order} matrix multiplication, parallel processing didn't beat one worker on this run. Try a larger job to see where it starts to pay off.`;
    benefits[0] = best.speedup > 1
      ? `Time fell from ${formatMs(result.rows[0].milliseconds)} to ${formatMs(best.milliseconds)} using ${plural(best.workers, "worker")}, a ${number((1 - best.milliseconds / result.rows[0].milliseconds) * 100)}% saving.`
      : `Time stayed at about ${formatMs(result.rows[0].milliseconds)}, so this job gained nothing from splitting on this run.`;
    benefits[1] = allMatch
      ? `All ${result.rows.length} worker counts produced the same matrix, so the speed didn't cost any accuracy.`
      : "At least one worker count produced a different matrix, which needs investigating before trusting the speedup.";
    limitations[0] = result.rows.length > 2
      ? `Efficiency went from ${number(first.efficiency * 100)}% at ${plural(first.workers, "worker")} to ${number(last.efficiency * 100)}% at ${plural(last.workers, "worker")}.`
      : `Efficiency was ${number(first.efficiency * 100)}% at ${plural(first.workers, "worker")}, not 100%.`;
    const serialPercent = result.serialFraction * 100;
    limitations[1] = result.serialFraction > 0.002
      ? `Your results fit Amdahl's law with about ${number(serialPercent, serialPercent < 10 ? 1 : 0)}% acting as if serial, which would cap speedup near ${number(1 / result.serialFraction)}×.`
      : "Your results show almost no serial limit across this range, so test more workers or a different job to find it.";
  }

  if (sizeResult) {
    const largest = sizeResult.rows[sizeResult.rows.length - 1];
    const smallest = sizeResult.rows[0];
    limitations[2] = `With ${sizeResult.workers} workers, speedup went from ${number(largest.speedup, 1)}× at ${largest.order} × ${largest.order} to ${number(smallest.speedup, 1)}× at ${smallest.order} × ${smallest.order}, because overhead doesn't shrink with the job.`;
  }

  const toList = (items) => items.map((item) => `<li>${item}</li>`).join("");
  $("#benefitsList").innerHTML = toList(benefits);
  $("#limitationsList").innerHTML = toList(limitations);
}

/* ---------- Wire up ---------- */

runButton.addEventListener("click", runExperiment);
cancelButton.addEventListener("click", () => state.session?.cancel());
sizeRunButton.addEventListener("click", runSizeTest);
$("#heroRunButton").addEventListener("click", () => {
  $("#lab").scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth" });
  runExperiment();
});

updateControls();
renderPreview();
renderFindings();
if (reducedMotion) drawHeroStill();
else requestAnimationFrame(heroLoop);
