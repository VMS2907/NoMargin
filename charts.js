const MARGIN = { top: 18, right: 20, bottom: 50, left: 54 };

const resizeObserver = new ResizeObserver((entries) => {
  for (const { target } of entries) {
    if (target.chartRender && target.clientWidth !== target.chartWidth) target.chartRender();
  }
});

function niceStep(rough) {
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normal = rough / magnitude;
  return (normal <= 1 ? 1 : normal <= 2 ? 2 : normal <= 2.5 ? 2.5 : normal <= 5 ? 5 : 10) * magnitude;
}

function ticksFor(maximum, count) {
  const step = niceStep(maximum / count);
  const ticks = [];
  for (let value = 0; value < maximum + step * 0.999; value += step) ticks.push(Number(value.toFixed(6)));
  return ticks;
}

function frame(host, options) {
  const width = Math.max(260, host.clientWidth);
  const height = options.height || 320;
  const plotRight = width - MARGIN.right;
  const plotBottom = height - MARGIN.bottom;
  const ticks = ticksFor(options.yMax, options.yTicks || 4);
  const top = ticks[ticks.length - 1];
  const y = (value) => plotBottom - (value / top) * (plotBottom - MARGIN.top);
  const count = options.xValues.length;
  const inset = options.bars ? 0 : 10;
  const band = (plotRight - MARGIN.left - inset * 2) / (options.bars ? count : Math.max(1, count - 1));
  const x = (index) => (options.bars ? MARGIN.left + band * (index + 0.5) : MARGIN.left + inset + band * index);
  const labelEvery = Math.ceil(30 / band);

  let svg = "";
  for (const tick of ticks) {
    svg += `<line class="c-grid" x1="${MARGIN.left}" x2="${plotRight}" y1="${y(tick)}" y2="${y(tick)}"></line>`;
    svg += `<text class="c-tick" x="${MARGIN.left - 10}" y="${y(tick) + 4}" text-anchor="end">${options.yFormat(tick)}</text>`;
  }
  options.xValues.forEach((value, index) => {
    if (index % labelEvery !== 0) return;
    svg += `<text class="c-tick" x="${x(index)}" y="${plotBottom + 20}" text-anchor="middle">${value}</text>`;
  });
  svg += `<text class="c-title" x="${(MARGIN.left + plotRight) / 2}" y="${height - 8}" text-anchor="middle">${options.xLabel}</text>`;
  if (options.reference) {
    const ref = y(options.reference.value);
    svg += `<line class="c-reference" x1="${MARGIN.left}" x2="${plotRight}" y1="${ref}" y2="${ref}"></line>`;
  }
  return { width, height, plotRight, plotBottom, x, y, band, svg };
}

function hitLayer(geometry, options) {
  const { x, band, plotBottom, height } = geometry;
  const interactive = Boolean(options.onSelect);
  return options.xValues.map((value, index) => {
    const label = options.tooltip(index).replace(/<[^>]+>/g, " ");
    const role = interactive ? 'role="button"' : 'role="img"';
    return `<rect class="c-hit" data-index="${index}" x="${x(index) - band / 2}" y="0" width="${band}" height="${height}" tabindex="0" ${role} aria-label="${label}"></rect>`;
  }).join("") + `<line class="c-crosshair" y1="${MARGIN.top}" y2="${plotBottom}" hidden></line>`;
}

function mount(host, geometry, content, options) {
  const { width, height } = geometry;
  host.classList.add("chart-host");
  host.chartWidth = host.clientWidth;
  host.innerHTML = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="group" aria-label="${options.label}">${geometry.svg}${content}${hitLayer(geometry, options)}</svg><div class="c-tooltip" hidden></div>${options.message ? `<div class="c-message"><p>${options.message}</p></div>` : ""}`;

  const tooltip = host.querySelector(".c-tooltip");
  const crosshair = host.querySelector(".c-crosshair");
  const show = (index) => {
    const px = geometry.x(index);
    tooltip.innerHTML = options.tooltip(index);
    tooltip.hidden = false;
    const flip = px > width - 190;
    tooltip.style.left = `${flip ? px - tooltip.offsetWidth - 14 : px + 14}px`;
    tooltip.style.top = `${MARGIN.top}px`;
    crosshair.setAttribute("x1", px);
    crosshair.setAttribute("x2", px);
    crosshair.hidden = false;
    crosshair.removeAttribute("hidden");
  };
  const hide = () => {
    tooltip.hidden = true;
    crosshair.setAttribute("hidden", "");
  };
  for (const rect of host.querySelectorAll(".c-hit")) {
    const index = Number(rect.dataset.index);
    rect.addEventListener("pointerenter", () => show(index));
    rect.addEventListener("focus", () => show(index));
    rect.addEventListener("blur", hide);
    if (options.onSelect) {
      rect.addEventListener("click", () => options.onSelect(index));
      rect.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          options.onSelect(index);
        }
      });
    }
  }
  host.querySelector("svg").addEventListener("pointerleave", hide);
}

function register(host, render) {
  host.chartRender = render;
  resizeObserver.observe(host);
  render();
}

export function lineChart(host, options) {
  register(host, () => {
    const geometry = frame(host, options);
    const { x, y } = geometry;
    let content = "";
    for (const series of options.series) {
      const points = series.values.map((value, index) => (value == null ? null : [x(index), y(value)])).filter(Boolean);
      if (!points.length) continue;
      content += `<polyline class="c-line c-line-${series.style}" points="${points.map((point) => point.join(",")).join(" ")}"></polyline>`;
      if (series.style === "measured") {
        series.values.forEach((value, index) => {
          if (value == null) return;
          const selected = options.selectedIndex === index;
          content += `<circle class="c-dot${selected ? " is-selected" : ""}" cx="${x(index)}" cy="${y(value)}" r="${selected ? 7 : 4.5}"></circle>`;
        });
      }
    }
    for (const label of options.directLabels || []) {
      const below = label.position === "below";
      content += `<text class="c-direct" x="${x(label.index) + (label.dx || 0)}" y="${y(label.value) + (below ? 22 : -12)}" text-anchor="${label.anchor || "middle"}">${label.text}</text>`;
    }
    mount(host, geometry, content, options);
  });
}

export function columnChart(host, options) {
  const values = options.values;
  register(host, () => {
    const geometry = frame(host, { ...options, bars: true });
    const { x, y, plotBottom, band } = geometry;
    const barWidth = Math.min(26, band - 4);
    let content = "";
    values.forEach((value, index) => {
      const left = x(index) - barWidth / 2;
      const top = y(value);
      const radius = Math.min(4, barWidth / 2, plotBottom - top);
      const selected = options.selectedIndex === index;
      content += `<path class="c-bar ${options.barClass(index)}${selected ? " is-selected" : ""}" d="M${left},${plotBottom}V${top + radius}Q${left},${top} ${left + radius},${top}H${left + barWidth - radius}Q${left + barWidth},${top} ${left + barWidth},${top + radius}V${plotBottom}Z"></path>`;
      if ((options.labelled || []).includes(index)) {
        content += `<text class="c-direct" x="${x(index)}" y="${top - 8}" text-anchor="middle">${options.yFormat(value, true)}</text>`;
      }
    });
    mount(host, geometry, content, options);
  });
}
