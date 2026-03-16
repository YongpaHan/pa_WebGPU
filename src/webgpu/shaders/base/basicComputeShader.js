import { buildComputeShader } from "../../engine/shaders/ShaderBuilder";

// Copy this file when starting a new compute shader and edit only this object.
// - global uniform is always available as `global`
// - local uniform is available as `local` only when `uniforms` is set
// - sampled textures use `<name>` + `<name>Sampler`
// - storage textures are declared via `storageTextures`
// - do not write `@compute` / `@workgroup_size` manually in shader body
export const basicComputeShader = buildComputeShader({
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
    PI: 3.141592,
    TWO_PI: 6.283184,
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
    0.5 + 0.5 * sin(src.r * TWO_PI + t),
    0.5 + 0.5 * sin(src.g * TWO_PI + t * 1.37),
    0.5 + 0.5 * sin(src.b * TWO_PI + t * 0.73)
  );

  textureStore(simWrite, vec2i(gid.xy), vec4f(color, 1.0));
}
`,
});

export const basicBuiltComputeShader = basicComputeShader;
export const basicComputeShaderCode = basicComputeShader.code;
export const basicComputeShaderContract = basicComputeShader.contract;
export const basicComputeDispatch = basicComputeShader.dispatch;
