import { buildShader } from "../../engine/shaders/ShaderBuilder";

// Copy this file when starting a new shader and edit only this object.
// - global uniform is always available as `global`
// - local uniform is available as `local` only when `uniforms` is set
// - textures use `<name>` + `<name>Sampler`
export const basicShader = buildShader({
  includes: [
    // "math",
  ],
  uniforms: {
    // exposure: "f32",
    // tint: "vec3f",
  },
  textures: [
    // "mainTex",
    // { name: "noiseTex", as: "noise" },
  ],
  defines: {
    // USE_FOG: true,
    // STEPS: 16,
    PI: 3.141592,
    TWO_PI: 6.283184,
  },
  validate: true,
  shader: /* wgsl */ `
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vertexMain(@location(0) pos: vec2f) -> VertexOut {
  var out: VertexOut;
  out.position = vec4f(pos, 0.0, 1.0);
  out.uv = pos * 0.5 + vec2f(0.5);
  return out;
}

@fragment
fn fragmentMain(in: VertexOut) -> @location(0) vec4f {
  let rs = max(global.resolution.xy, vec2f(1.0));
  let aspect = rs / min(rs.x, rs.y);
  let cuv = (in.uv - 0.5) * aspect;
  let time = global.time;

  // Example when using local uniforms:
  // let exposure = local.exposure;
  // let tint = local.tint;

  // Example when using textures:
  // let tex = textureSample(mainTex, mainTexSampler, in.uv);
  // return vec4f(tex.rgb, 1.0);

  let pulse = 0.5 + 0.5 * sin(time);
  let vignette = 1.0 - smoothstep(0.1, 0.9, length(cuv));
  let color = vec3f(in.uv, pulse);

  return vec4f(color * vignette, 1.0);
}
`,
});

export const basicBuiltShader = basicShader;
export const basicShaderCode = basicShader.code;
export const basicShaderContract = basicShader.contract;
