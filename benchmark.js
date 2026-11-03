export function slicesFor(rows, workerCount) {
  return Array.from({ length: workerCount }, (_, index) => ({
    start: Math.floor((index * rows) / workerCount),
    end: Math.floor(((index + 1) * rows) / workerCount),
  }));
}

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
  constructor() {
    this.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    this.nextId = 0;
    this.pending = new Map();
    this.worker.onmessage = ({ data }) => {
      const task = this.pending.get(data.id);
      if (!task) return;
      this.pending.delete(data.id);
      task.resolve(data);
    };
    this.worker.onerror = (event) => this.failAll(event.error || new Error(event.message || "A benchmark worker failed."));
  }

  call(message) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id });
    });
  }

  initialize(order, left, right) {
    return this.call({ type: "initialize", order, left, right });
  }

  run(rowStart, rowEnd) {
    return this.call({ type: "run", rowStart, rowEnd });
  }

  failAll(error) {
    for (const task of this.pending.values()) task.reject(error);
    this.pending.clear();
  }

  terminate() {
    this.worker.terminate();
    this.failAll(new Error("Benchmark cancelled."));
  }
}

export function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function compareOutputs(expected, actual) {
  let maximumRelativeDifference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    const difference = Math.abs(expected[index] - actual[index]);
    maximumRelativeDifference = Math.max(maximumRelativeDifference, difference / Math.max(1, Math.abs(expected[index])));
  }
  return { matches: maximumRelativeDifference <= 1e-12, maximumRelativeDifference };
}

// Amdahl says T(p) / T(1) = f + (1 - f) / p. That is a straight line in 1/p, so
// the serial fraction f has a closed-form least-squares fit.
export function fitSerialFraction(rows) {
  let numerator = 0;
  let denominator = 0;
  for (const row of rows) {
    if (row.workers < 2) continue;
    const x = 1 / row.workers;
    numerator += (1 / row.speedup - x) * (1 - x);
    denominator += (1 - x) ** 2;
  }
  return denominator ? Math.min(1, Math.max(0, numerator / denominator)) : 0;
}

export function amdahl(serialFraction, workers) {
  return 1 / (serialFraction + (1 - serialFraction) / workers);
}

// A cancellable session that owns one worker pool. Workers beyond the count being
// tested stay idle, so every worker count shares the same warmed-up pool.
export class BenchmarkSession {
  constructor(workerCount) {
    this.cancelled = false;
    this.clients = Array.from({ length: workerCount }, () => new WorkerClient());
    this.abort = new Promise((_, reject) => { this.rejectAbort = reject; });
    this.abort.catch(() => {});
  }

  guarded(promise) {
    return Promise.race([promise, this.abort]);
  }

  async load(order) {
    const { left, right } = makeSeededMatrices(order);
    await this.guarded(Promise.all(this.clients.map((client) => client.initialize(order, left, right))));
    this.order = order;
  }

  // Runs a slice of the job on every worker so the JIT has compiled the kernel
  // everywhere before anything is timed.
  async warmUp() {
    const rows = Math.max(Math.min(this.order, 8), Math.floor(this.order / 4));
    await this.guarded(Promise.all(this.clients.map((client) => client.run(0, rows))));
  }

  // Time covers dispatching work, computing, returning results and assembling the
  // final matrix: everything a real parallel program pays for.
  async timeJob(workerCount, repeats = 1) {
    const slices = slicesFor(this.order, workerCount);
    const output = new Float64Array(this.order * this.order);
    const started = performance.now();
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const chunks = await this.guarded(Promise.all(slices.map((slice, index) => this.clients[index].run(slice.start, slice.end))));
      for (const chunk of chunks) output.set(new Float64Array(chunk.buffer), chunk.rowStart * this.order);
    }
    return { milliseconds: (performance.now() - started) / repeats, output };
  }

  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.close();
    this.rejectAbort(new Error("Benchmark cancelled."));
  }

  close() {
    for (const client of this.clients) client.terminate();
  }
}

// Experiment 1: the same job at every worker count from 1 to maxWorkers.
export async function runScalingExperiment(session, { order, maxWorkers, rounds }, onProgress) {
  const counts = Array.from({ length: maxWorkers }, (_, index) => index + 1);
  onProgress({ phase: "prepare", fraction: 0.02, active: 0 });
  await session.load(order);
  onProgress({ phase: "warmup", fraction: 0.06, active: maxWorkers });
  await session.warmUp();

  const times = new Map(counts.map((count) => [count, []]));
  const matches = new Map([[1, { matches: true, maximumRelativeDifference: 0 }]]);
  let baseline = null;
  let completed = 0;
  const total = rounds * counts.length;

  for (let round = 0; round < rounds; round += 1) {
    // Alternating direction stops slow drift (heat, background load) from always
    // penalising the same worker counts. Round 0 runs 1 worker first for the check.
    const sequence = round % 2 === 0 ? counts : [...counts].reverse();
    for (const count of sequence) {
      onProgress({ phase: "measure", round: round + 1, rounds, active: count, fraction: 0.08 + (completed / total) * 0.92 });
      const { milliseconds, output } = await session.timeJob(count);
      times.get(count).push(milliseconds);
      if (round === 0) {
        if (count === 1) baseline = output;
        else matches.set(count, compareOutputs(baseline, output));
      }
      completed += 1;
    }
  }

  const sequentialMedian = median(times.get(1));
  const rows = counts.map((workers) => {
    const milliseconds = median(times.get(workers));
    const speedup = sequentialMedian / milliseconds;
    return { workers, milliseconds, speedup, efficiency: speedup / workers, times: times.get(workers), match: matches.get(workers) };
  });
  return { order, rounds, maxWorkers, rows, serialFraction: fitSerialFraction(rows), timestamp: new Date() };
}

// Experiment 2: 1 worker against many as the job shrinks, to expose overhead.
export const JOB_SIZES = [16, 32, 64, 128, 256, 512];

export async function runSizeExperiment(session, { workers, rounds = 5 }, onProgress) {
  const rows = [];
  for (let index = 0; index < JOB_SIZES.length; index += 1) {
    const order = JOB_SIZES[index];
    onProgress({ order, active: workers, fraction: index / JOB_SIZES.length });
    await session.load(order);
    await session.warmUp();
    // Tiny jobs finish faster than the browser's timer can resolve, so they are
    // repeated and averaged within each round.
    const repeats = Math.max(1, Math.min(300, Math.round(3e7 / order ** 3)));
    const sequential = [];
    const parallel = [];
    for (let round = 0; round < rounds; round += 1) {
      const pair = round % 2 === 0 ? [1, workers] : [workers, 1];
      for (const count of pair) {
        const { milliseconds } = await session.timeJob(count, repeats);
        (count === 1 ? sequential : parallel).push(milliseconds);
      }
    }
    const sequentialMedian = median(sequential);
    const parallelMedian = median(parallel);
    rows.push({ order, sequentialMedian, parallelMedian, speedup: sequentialMedian / parallelMedian });
  }
  return { workers, rows };
}
