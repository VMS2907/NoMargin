let order = 0;
let leftMatrix;
let rightMatrix;

self.onmessage = ({ data }) => {
  if (data.type === "initialize") {
    order = data.order;
    leftMatrix = data.left;
    rightMatrix = data.right;
    self.postMessage({ type: "ready" });
    return;
  }

  if (data.type !== "run") return;
  const { id, rowStart, rowEnd } = data;
  const output = new Float64Array((rowEnd - rowStart) * order);
  for (let row = rowStart; row < rowEnd; row += 1) {
    const outputBase = (row - rowStart) * order;
    const leftBase = row * order;
    for (let inner = 0; inner < order; inner += 1) {
      const leftValue = leftMatrix[leftBase + inner];
      const rightBase = inner * order;
      for (let column = 0; column < order; column += 1) {
        output[outputBase + column] += leftValue * rightMatrix[rightBase + column];
      }
    }
  }
  self.postMessage({ type: "complete", id, rowStart, buffer: output.buffer }, [output.buffer]);
};
