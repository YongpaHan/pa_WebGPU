import { RenderPass } from "../../../webgpu/engine/RenderPass";

export function createPass({ shader = null, shaderCode = null } = {}) {
  const positions = new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]);
  const geometry = {
    topology: "triangle-list",
    attributes: [
      {
        data: positions,
        arrayStride: 8,
        attributes: [{ location: 0, format: "float32x2", offset: 0 }],
      },
    ],
    index: [0, 1, 2, 0, 2, 3],
  };

  const pass = new RenderPass({
    label: "BasicPass",
    shader,
    shaderCode,
    geometry,
  });

  return { pass, geometry };
}
