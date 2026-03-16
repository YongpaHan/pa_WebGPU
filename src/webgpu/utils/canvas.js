export function createCanvas({ id, className, parent = document.body } = {}) {
  const canvas = document.createElement("canvas");
  if (id) canvas.id = id;
  if (className) canvas.className = className;

  canvas.style.display = "block";
  canvas.style.width = "100vw";
  canvas.style.height = "100vh";

  parent.appendChild(canvas);
  return canvas;
}
