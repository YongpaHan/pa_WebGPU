export const globalUniformWgsl = /* wgsl */ `

struct GlobalUniforms {
  resolution: vec2f,
  time: f32,
  deltaTime: f32,
  mouse: vec4f,
  gestureTransform: vec4f, // x, y, zoom, angle
  gestureState: vec4f,     // dragging, pinching, isPressed, reserved
  touches: array<vec4f, 5>, // xy = uv, z = active, w = reserved
};

@group(0) @binding(0)
var<uniform> global: GlobalUniforms;

`;
