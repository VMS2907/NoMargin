const sizeRange = document.querySelector("#sizeRange");
const sizeOutput = document.querySelector("#sizeOutput");
const workerRange = document.querySelector("#workerRange");
const workerOutput = document.querySelector("#workerOutput");
const workerMaxLabel = document.querySelector("#workerMaxLabel");
const hardwareNote = document.querySelector("#hardwareNote");
const runButton = document.querySelector("#runButton");
const cancelButton = document.querySelector("#cancelButton");
const runStatus = document.querySelector("#runStatus");
const statusText = document.querySelector("#statusText");
const progressWrap = document.querySelector("#progressWrap");
const progressBar = document.querySelector("#progressBar");
const progressLabel = document.querySelector("#progressLabel");
const chartEmpty = document.querySelector("#chartEmpty");
const chartResults = document.querySelector("#chartResults");
const chartSubtitle = document.querySelector("#chartSubtitle");
const historySection = document.querySelector("#historySection");
const historyRows = document.querySelector("#historyRows");
const downloadButton = document.querySelector("#downloadButton");

const reportedCores = Number(navigator.hardwareConcurrency) || 4;
const maximumWorkers = Math.min(8, Math.max(2, reportedCores));
workerRange.max = String(maximumWorkers);
workerRange.value = String(Math.min(4, maximumWorkers));
workerMaxLabel.textContent = `${maximumWorkers}`;
hardwareNote.textContent = navigator.hardwareConcurrency
  ? `Browser reports ${reportedCores} logical processor${reportedCores === 1 ? "" : "s"}; browser scheduling can vary.`
  : "This browser does not report a processor count; worker choices are capped at 4.";

let currentRun = null;
let latestResult = null;
const sessionHistory = [];

function selectedRounds() {
  return Number(document.querySelector('input[name="rounds"]:checked').value);
}

function updateControls() {
  sizeOutput.textContent = `${sizeRange.value} × ${sizeRange.value}`;
  const count = Number(workerRange.value);
  workerOutput.textContent = `${count} worker${count === 1 ? "" : "s"}`;
  document.querySelector("#legendWorkers").textContent = `${count} worker${count === 1 ? "" : "s"}`;
  const ratio = ((Number(sizeRange.value) - Number(sizeRange.min)) / (Number(sizeRange.max) - Number(sizeRange.min))) * 100;
  sizeRange.style.background = `linear-gradient(to right, #89b65a ${ratio}%, #e3e8df ${ratio}%)`;
  const workerRatio = ((count - 2) / Math.max(1, maximumWorkers - 2)) * 100;
  workerRange.style.background = `linear-gradient(to right, #89b65a ${workerRatio}%, #e3e8df ${workerRatio}%)`;
  for (const preset of document.querySelectorAll(".preset")) {
    preset.classList.toggle("active", Number(preset.dataset.size) === Number(sizeRange.value));
  }
}

sizeRange.addEventListener("input", updateControls);
workerRange.addEventListener("input", updateControls);
for (const preset of document.querySelectorAll(".preset")) {
  preset.addEventListener("click", () => {
    sizeRange.value = preset.dataset.size;
    updateControls();
  });
}
updateControls();

function makeSeededMatrices(order) {
  const left = new Float64Array(order * order);
  const right = new Float64Array(order * order);
  let state = (0x6d2b79f5 ^ Math.imul(order, 0x45d9f3b)) >>> 0;
  const nextValue = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 8) / 0x800000) - 1;
  };
  for (let i = 0; i < left.length; i += 1) {
    left[i] = nextValue();
    right[i] = nextValue();
  }
  return { left, right };
}

class WorkerClient {
  constructor(register) {
    this.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    this.nextId = 0;
    this.pending = new Map();
    let readyResolve;
    let readyReject;
    this.ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    this.worker.onmessage = ({ data }) => {
      if (data.type === "ready") {
        readyResolve();
        return;
      }
      if (data.type !== "complete") return;
      const task = this.pending.get(data.id);
      if (!task) return;
      this.pending.delete(data.id);
      task.resolve({ rowStart: data.rowStart, values: new Float64Array(data.buffer) });
    };
    this.worker.onerror = (event) => {
      const error = event.error || new Error(event.message || "A benchmark worker failed.");
      readyReject(error);
      for (const task of this.pending.values()) task.reject(error);
      this.pending.clear();
    };
    register(this);
  }

  initialize(order, left, right) {
    this.worker.postMessage({ type: "initialize", order, left, right });
    return this.ready;
  }

  run(rowStart, rowEnd) {
    const id = ++this.nextId;
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.worker.postMessage({ type: "run", id, rowStart, rowEnd });
    return promise;
  }

  terminate() {
    this.worker.terminate();
    const error = new Error("Benchmark cancelled.");
    for (const task of this.pending.values()) task.reject(error);
    this.pending.clear();
  }
}

async function preparePool(workerCount, order, matrices, run) {
  const setupStarted = performance.now();
  const clients = Array.from({ length: workerCount }, () => new WorkerClient((client) => run.clients.push(client)));
  await Promise.all(clients.map((client) => client.initialize(order, matrices.left, matrices.right)));
  return { clients, setupMs: performance.now() - setupStarted };
}

function guarded(promise, run) {
  return Promise.race([promise, run.abortPromise]);
}

function slicesFor(order, workerCount) {
  return Array.from({ length: workerCount }, (_, index) => ({
    start: Math.floor((index * order) / workerCount),
    end: Math.floor(((index + 1) * order) / workerCount),
  }));
}

async function executeSequential(pool, order, run) {
  const started = performance.now();
  const chunk = await guarded(pool.clients[0].run(0, order), run);
  const output = new Float64Array(order * order);
  output.set(chunk.values, chunk.rowStart * order);
  return { milliseconds: performance.now() - started, output };
}

async function executeParallel(pool, order, run, onWorkerComplete) {
  const started = performance.now();
  const slices = slicesFor(order, pool.clients.length);
  let complete = 0;
  const chunks = await guarded(Promise.all(pool.clients.map((client, index) =>
    client.run(slices[index].start, slices[index].end).then((result) => {
      complete += 1;
      onWorkerComplete?.(complete, pool.clients.length);
      return result;
    }),
  )), run);
  const output = new Float64Array(order * order);
  for (const chunk of chunks) output.set(chunk.values, chunk.rowStart * order);
  return { milliseconds: performance.now() - started, output };
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function compareOutputs(expected, actual) {
  let maximumAbsoluteDifference = 0;
  let maximumRelativeDifference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    const difference = Math.abs(expected[index] - actual[index]);
    maximumAbsoluteDifference = Math.max(maximumAbsoluteDifference, difference);
    maximumRelativeDifference = Math.max(maximumRelativeDifference, difference / Math.max(1, Math.abs(expected[index])));
  }
  return {
    matches: maximumRelativeDifference <= 1e-12,
    maximumAbsoluteDifference,
    maximumRelativeDifference,
  };
}

function formatMilliseconds(value) {
  if (value < 1) return `${value.toFixed(3)} ms`;
  if (value < 100) return `${value.toFixed(2)} ms`;
  return `${value.toFixed(1)} ms`;
}

function setStatus(kind, message) {
  runStatus.className = `run-status ${kind}`.trim();
  statusText.textContent = message;
}

function setProgress(percent, message) {
  progressWrap.hidden = false;
  progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  progressLabel.textContent = message;
}

function setRunning(isRunning) {
  runButton.disabled = isRunning;
  runButton.querySelector("span").textContent = isRunning ? "Running benchmark…" : "Run benchmark";
  cancelButton.hidden = !isRunning;
  sizeRange.disabled = isRunning;
  workerRange.disabled = isRunning;
  for (const input of document.querySelectorAll('input[name="rounds"]')) input.disabled = isRunning;
  for (const preset of document.querySelectorAll(".preset")) preset.disabled = isRunning;
}

function setEmptyResults() {
  chartEmpty.hidden = false;
  chartResults.hidden = true;
  chartSubtitle.textContent = "Median of measured rounds · milliseconds";
  for (const id of ["speedupValue", "efficiencyValue", "savedValue", "correctnessValue"]) document.getElementById(id).textContent = "—";
  document.querySelector("#speedupNote").textContent = "Sequential time ÷ parallel time";
  document.querySelector("#correctnessNote").textContent = "Output check runs after timing";
  document.querySelector("#setupInfo").innerHTML = '<span class="setup-icon">◷</span> Worker startup, data copy and warm-up are reported separately from measured rounds.';
  downloadButton.disabled = true;
}

function updateResultView(result) {
  const maxTime = Math.max(result.sequentialMedian, result.parallelMedian);
  chartEmpty.hidden = true;
  chartResults.hidden = false;
  chartSubtitle.textContent = `Median of ${result.rounds} measured rounds · milliseconds`;
  document.querySelector("#sequentialBar").style.width = `${Math.max(1, (result.sequentialMedian / maxTime) * 100)}%`;
  document.querySelector("#parallelBar").style.width = `${Math.max(1, (result.parallelMedian / maxTime) * 100)}%`;
  document.querySelector("#sequentialTime").textContent = formatMilliseconds(result.sequentialMedian);
  document.querySelector("#parallelTime").textContent = formatMilliseconds(result.parallelMedian);
  document.querySelector("#parallelWorkerLabel").textContent = `${result.workers} workers`;
  document.querySelector("#legendWorkers").textContent = `${result.workers} workers`;
  document.querySelector("#chartWorkload").textContent = `${result.order} × ${result.order} · ${result.operations.toLocaleString()} multiply-accumulate steps per output matrix`;
  document.querySelector("#chartRoundLabel").textContent = `MEDIAN · ${result.rounds} ROUNDS`;

  const speedup = result.sequentialMedian / result.parallelMedian;
  const efficiency = (speedup / result.workers) * 100;
  const saved = ((result.sequentialMedian - result.parallelMedian) / result.sequentialMedian) * 100;
  document.querySelector("#speedupValue").textContent = speedup.toFixed(2);
  document.querySelector("#efficiencyValue").textContent = efficiency.toFixed(0);
  document.querySelector("#savedValue").textContent = saved.toFixed(1);
  document.querySelector("#speedupNote").textContent = speedup >= 1
    ? `Parallel ran ${speedup.toFixed(2)}× as fast in this run.`
    : `Parallel was ${(1 / speedup).toFixed(2)}× slower in this run.`;
  document.querySelector("#savedNote").textContent = saved >= 0
    ? "Less time than sequential median"
    : "More time than sequential median";
  document.querySelector("#correctnessValue").textContent = result.validation.matches ? "MATCH" : "MISMATCH";
  document.querySelector("#correctnessNote").textContent = result.validation.matches
    ? `Max relative error ${result.validation.maximumRelativeDifference.toExponential(1)}`
    : `Max relative error ${result.validation.maximumRelativeDifference.toExponential(1)}`;
  const setup = `Setup (excluded): 1 worker ${result.singleSetupMs.toFixed(0)} ms · ${result.workers} workers ${result.parallelSetupMs.toFixed(0)} ms. Warm-up ${result.warmupMs.toFixed(0)} ms. Timings include worker dispatch, returned results and output assembly.`;
  document.querySelector("#setupInfo").innerHTML = `<span class="setup-icon">◷</span> ${setup}`;
  downloadButton.disabled = false;
  renderHistory();
}

function renderHistory() {
  if (sessionHistory.length === 0) {
    historySection.hidden = true;
    return;
  }
  historySection.hidden = false;
  historyRows.innerHTML = sessionHistory.map((entry, index) => {
    const speedup = entry.sequentialMedian / entry.parallelMedian;
    return `<tr><td>${sessionHistory.length - index}</td><td>${entry.order} × ${entry.order}</td><td>${entry.workers}</td><td>${formatMilliseconds(entry.sequentialMedian)}</td><td>${formatMilliseconds(entry.parallelMedian)}</td><td>${speedup.toFixed(2)}×</td></tr>`;
  }).join("");
}

async function runBenchmark() {
  if (currentRun) return;
  let abortReject;
  const run = {
    cancelled: false,
    clients: [],
    abortPromise: new Promise((_, reject) => { abortReject = reject; }),
    cancel() {
      if (this.cancelled) return;
      this.cancelled = true;
      for (const client of this.clients) client.terminate();
      abortReject(new Error("Benchmark cancelled."));
    },
  };
  currentRun = run;
  const order = Number(sizeRange.value);
  const workers = Number(workerRange.value);
  const rounds = selectedRounds();
  setRunning(true);
  setStatus("running", "Preparing worker pools");
  setProgress(3, "Generating the same seeded matrices for both paths…");

  try {
    const matrices = makeSeededMatrices(order);
    const singlePromise = preparePool(1, order, matrices, run);
    const parallelPromise = preparePool(workers, order, matrices, run);
    const [singlePool, parallelPool] = await guarded(Promise.all([singlePromise, parallelPromise]), run);

    setStatus("running", "Warming up worker pools");
    setProgress(12, "Warming up both paths; warm-up is not included in the timings…");
    const warmupStart = performance.now();
    await guarded(singlePool.clients[0].run(0, order), run);
    await guarded(Promise.all(parallelPool.clients.map((client, index) => {
      const slice = slicesFor(order, parallelPool.clients.length)[index];
      return client.run(slice.start, slice.end);
    })), run);
    const warmupMs = performance.now() - warmupStart;

    const sequentialTimes = [];
    const parallelTimes = [];
    let validation = null;
    let completedJobs = 0;
    const jobCount = rounds * 2;
    const report = (fraction, label) => {
      setProgress(18 + ((completedJobs + fraction) / jobCount) * 82, label);
    };

    for (let index = 0; index < rounds; index += 1) {
      const roundLabel = `Measured round ${index + 1} of ${rounds}`;
      setStatus("running", roundLabel);
      let sequential;
      let parallel;
      if (index % 2 === 0) {
        report(0, `${roundLabel} · sequential`);
        sequential = await executeSequential(singlePool, order, run);
        sequentialTimes.push(sequential.milliseconds);
        completedJobs += 1;
        report(0, `${roundLabel} · parallel workers`);
        parallel = await executeParallel(parallelPool, order, run, (done, total) => {
          report(done / total, `${roundLabel} · ${done}/${total} worker results returned`);
        });
        parallelTimes.push(parallel.milliseconds);
        completedJobs += 1;
      } else {
        report(0, `${roundLabel} · parallel workers`);
        parallel = await executeParallel(parallelPool, order, run, (done, total) => {
          report(done / total, `${roundLabel} · ${done}/${total} worker results returned`);
        });
        parallelTimes.push(parallel.milliseconds);
        completedJobs += 1;
        report(0, `${roundLabel} · sequential`);
        sequential = await executeSequential(singlePool, order, run);
        sequentialTimes.push(sequential.milliseconds);
        completedJobs += 1;
      }
      if (index === 0) validation = compareOutputs(sequential.output, parallel.output);
    }

    const result = {
      timestamp: new Date(),
      order,
      workers,
      rounds,
      sequentialTimes,
      parallelTimes,
      sequentialMedian: median(sequentialTimes),
      parallelMedian: median(parallelTimes),
      validation,
      operations: order * order * order,
      singleSetupMs: singlePool.setupMs,
      parallelSetupMs: parallelPool.setupMs,
      warmupMs,
    };
    latestResult = result;
    sessionHistory.unshift(result);
    updateResultView(result);
    setProgress(100, "Measurement complete; output comparison finished.");
    setStatus(validation.matches ? "complete" : "error", validation.matches ? "Run complete · outputs matched" : "Run complete · output mismatch detected");
  } catch (error) {
    if (run.cancelled) {
      progressWrap.hidden = true;
      setStatus("", "Run cancelled");
    } else {
      progressWrap.hidden = true;
      setStatus("error", "Benchmark could not finish");
      statusText.title = error.message;
      console.error(error);
    }
  } finally {
    for (const client of run.clients) client.terminate();
    currentRun = null;
    setRunning(false);
  }
}

runButton.addEventListener("click", runBenchmark);
cancelButton.addEventListener("click", () => currentRun?.cancel());
document.querySelector("#clearButton").addEventListener("click", () => {
  sessionHistory.length = 0;
  latestResult = null;
  renderHistory();
  setEmptyResults();
  progressWrap.hidden = true;
  setStatus("", "Ready when you are");
});

downloadButton.addEventListener("click", () => {
  if (!latestResult) return;
  const result = latestResult;
  const rows = [
    ["metric", "value"],
    ["timestamp_utc", result.timestamp.toISOString()],
    ["matrix_order", result.order],
    ["matrix_outputs", result.order * result.order],
    ["multiply_accumulate_steps_per_output", result.operations],
    ["parallel_workers", result.workers],
    ["measured_rounds", result.rounds],
    ["sequential_median_ms", result.sequentialMedian],
    ["parallel_median_ms", result.parallelMedian],
    ["speedup", result.sequentialMedian / result.parallelMedian],
    ["parallel_efficiency_percent", (result.sequentialMedian / result.parallelMedian / result.workers) * 100],
    ["outputs_match", result.validation.matches],
    ["max_absolute_difference", result.validation.maximumAbsoluteDifference],
    ["max_relative_difference", result.validation.maximumRelativeDifference],
    ["sequential_worker_setup_ms_excluded", result.singleSetupMs],
    ["parallel_worker_setup_ms_excluded", result.parallelSetupMs],
    ["warmup_ms_excluded", result.warmupMs],
    ["sequential_rounds_ms", result.sequentialTimes.join(" | ")],
    ["parallel_rounds_ms", result.parallelTimes.join(" | ")],
  ];
  const csv = rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `parallel-lab-${result.order}x${result.order}-${result.timestamp.toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
});

setEmptyResults();
