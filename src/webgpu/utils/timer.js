export function createTimer() {
  let last = performance.now();

  return {
    tick() {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      return dt;
    },
    reset() {
      last = performance.now();
    },
  };
}
