import { buildShader } from "../../../../webgpu/engine/shaders/ShaderBuilder";

// Copy this file when starting a new shader and edit only this object.
// - global uniform is always available as `global`
// - local uniform is available as `local` only when `uniforms` is set
// - textures use `<name>` + `<name>Sampler`
// - storages use `var<storage, access> <as>: <type>`
export const shader = buildShader({
  includes: ["math", "sdf", "gesture"],
  uniforms: {
    // gain: "f32",
  },
  textures: [
    "test_tex",
    // { name: "noiseTex", as: "noise" },
  ],
  storages: {
    // glyphs: {
    //   struct: { pos: "vec2f", size: "vec2f" },
    // },
  },
  defines: {
    // USE_FOG: true,
    // STEPS: 16,
    PI: 3.141592,
    TWO_PI: 6.283184,
  },
  validate: false,
  shader: /* wgsl */ `
struct vOut {
  @builtin(position) fragCoord: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vertexMain(@location(0) pos: vec2f) -> vOut {
  var out: vOut;
  out.fragCoord = vec4f(pos, 0.0, 1.0);
  out.uv = pos * 0.5 + vec2f(0.5);
  return out;
}

@fragment
fn fragmentMain(in: vOut) -> @location(0) vec4f {
  let time = global.time;
  let rs = global.resolution.xy;
  let ratio = rs.xy / min(rs.x, rs.y);

  let center = global.gestureTransform.xy * ratio;
  let zoom = global.gestureTransform.z;
  let angle = global.gestureTransform.w;

  var uv = (in.uv - 0.5) * ratio;
  uv = rotate2d(uv / zoom, -angle);
  uv += center;

  let c = textureSample(test_tex, test_texSampler, uv+0.5);
  let dst = median(c.r, c.g, c.b);

  let dx = dpdx(dst);
  let dy = dpdy(dst);
  let pixelWidth = length(vec2f(dx, dy));

  let alpha = smoothstep(0.5 - pixelWidth, 0.5 + pixelWidth, dst);
  var col = mix(c.rgb*(cos(time)*0.5+0.5), vec3f(1, 1, 1)*sin(time)*0.5+0.5, alpha);

  let screenUv = vec2f(in.uv.x, 1.0 - in.uv.y);

  var marker = 0.0;
  for(var i = 0; i < MAX_TOUCHES; i++) {
    if (!touchActive(i)) {
      continue;
    }
    let touchPos = touchPos(i);
    let d = abs(sdCircle(screenUv * ratio - touchPos * ratio, 0.1));
    marker = max(marker, 1.0 - smoothstep(0.001, 0.002, d));
  }
  col = mix(col, vec3f(1), marker);

  return vec4f(col, 1);
}
`,
});
