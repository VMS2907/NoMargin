# Parallel Lab

An interactive, static browser app for comparing sequential and parallel matrix multiplication. It is designed for the COA activity on parallelism, speedup, and efficiency.

## What it measures

- A seeded pair of square `Float64Array` matrices is generated in the browser.
- The sequential path runs the same multiplication kernel in one Web Worker.
- The parallel path partitions output rows over the selected number of Web Workers.
- Both pools are initialized and warmed up before measured rounds. Startup, input copying, and warm-up are shown separately.
- Each measured time includes worker dispatch, returning results, and assembling the output matrix. The median of 3 or 5 alternating-order rounds is shown.
- Outputs from the sequential and parallel paths are compared after timing. Measurements and matrix data remain on the user's device.

Speedup is `sequential median ÷ parallel median`. Efficiency is `speedup ÷ worker count × 100`. This is an educational browser comparison. Timing depends on the device, browser, background load, and thermal state; repeat runs when comparing settings.

## Run locally

Serve this directory over HTTP because the app uses an ES module Web Worker. For example, with Node.js installed:

```sh
npx serve .
```

Then open the local URL printed by the server. The site has no runtime dependencies or backend.

## Deploy

Import this repository in Vercel as a static site. It needs no build command and uses the repository root as its output directory. Subsequent pushes to the connected branch can trigger automatic deployments.
