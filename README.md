# Parallel Lab

An interactive, static browser app for comparing sequential and parallel matrix multiplication. It is designed for the COA activity on parallelism, speedup, and efficiency, and for desktop and laptop screens.

## What it measures

- A seeded pair of square `Float64Array` matrices is generated in the browser.
- The sequential path runs the multiplication kernel in one Web Worker. The parallel path partitions output rows over several workers running the same kernel.
- The main experiment times every worker count from 1 up to the chosen limit, using one warmed-up pool. Worker startup, input copying, and warm-up are not timed.
- Each measured time includes worker dispatch, returning results, and assembling the output matrix. The median of 3 or 5 alternating-order rounds is shown.
- Every worker count's output is compared with the sequential output after timing. Measurements and matrix data remain on the user's device.
- A least-squares fit to Amdahl's law estimates how much of the run behaved as if serial.
- A second test shrinks the job from 512 × 512 to 16 × 16 at 4 workers to expose coordination overhead. Small jobs are repeated within each round because they finish faster than the browser's timer can resolve.

Speedup is `sequential median ÷ parallel median`. Efficiency is `speedup ÷ worker count × 100`. This is an educational browser comparison. Timing depends on the device, browser, background load, and thermal state; repeat runs when comparing settings.

## Run locally

Serve this directory over HTTP because the app uses an ES module Web Worker. For example, with Node.js installed:

```sh
npx serve .
```

Then open the local URL printed by the server. The site has no runtime dependencies or backend.

## Host the site

This is a static site with no build step or backend. On a static host, publish the repository root as the site directory; connect the `main` branch if you want later pushes to deploy automatically.
