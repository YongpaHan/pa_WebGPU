import { buildComputeShader } from "../../../../webgpu/engine/shaders/ShaderBuilder";

// Copy this file when starting a new compute shader and edit only this object.
// - global uniform is always available as `global`
// - local uniform is available as `local` only when `uniforms` is set
// - sampled textures use `<name>` + `<name>Sampler`
// - storage textures use `textureStore(<storageTextureName>, ...)`
//
// Quick usage in sketch.js:
//   import { ComputePass } from "../../../webgpu/engine/ComputePass";
//   import { computeShader } from "./shaders/computeShader";
//
//   const computePass = new ComputePass({
//     shader: computeShader,
//     workgroups: ({ renderer }) =>
//       computeShader.dispatch.for2D(renderer.size.width, renderer.size.height),
//   });
//
//   const texA = await renderer.createTexture("simA", {
//     format: "rgba16float",
//     usage:
//       GPUTextureUsage.TEXTURE_BINDING |
//       GPUTextureUsage.STORAGE_BINDING |
//       GPUTextureUsage.RENDER_ATTACHMENT,
//   });
//   const texB = await renderer.createTexture("simB", {
//     format: "rgba16float",
//     usage:
//       GPUTextureUsage.TEXTURE_BINDING |
//       GPUTextureUsage.STORAGE_BINDING |
//       GPUTextureUsage.RENDER_ATTACHMENT,
//   });
//
//   let readTex = texA;
//   let writeTex = texB;
//
//   // each frame (before renderer.renderFrame)
//   computePass.setTexture("simRead", readTex);
//   computePass.setStorageTexture("simWrite", writeTex);
//
//   // compute should run before render pass that samples writeTex
//   renderer.addPass(computePass);
//   // renderer.addPass(scenePass);
//
//   // each frame (after renderer.renderFrame)
//   [readTex, writeTex] = [writeTex, readTex];
export const computeShader = buildComputeShader({
  includes: [
    // "math",
  ],
  uniforms: {
    // gain: "f32",
  },
  textures: [
    "simRead",
    // { name: "noiseTex", as: "noise" },
  ],
  storageTextures: [
    {
      name: "simWrite",
      access: "write",
      format: "rgba16float",
      viewDimension: "2d",
    },
  ],
  storages: {
    // particles: {
    //   struct: { pos: "vec2f", vel: "vec2f" },
    //   access: "read_write",
    // },
  },
  defines: {
    // PI: 3.141592,
  },
  workgroupSize: [8, 8, 1],
  validate: true,
  shader: /* wgsl */ `
fn computeMain(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(simWrite);
  if (gid.x >= size.x || gid.y >= size.y) {
    return;
  }

  let uv = (vec2f(gid.xy) + 0.5) / vec2f(size);
  let src = textureSample(simRead, simReadSampler, uv);
  let t = global.time;

  let color = vec3f(
    0.5 + 0.5 * sin(src.r * 6.283184 + t),
    0.5 + 0.5 * sin(src.g * 6.283184 + t * 1.37),
    0.5 + 0.5 * sin(src.b * 6.283184 + t * 0.73)
  );

  textureStore(simWrite, vec2i(gid.xy), vec4f(color, 1.0));
}
`,
});

export const builtComputeShader = computeShader;
export const computeShaderCode = computeShader.code;
export const computeShaderContract = computeShader.contract;
export const computeDispatch = computeShader.dispatch;
