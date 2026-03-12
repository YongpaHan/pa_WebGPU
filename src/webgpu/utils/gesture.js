import gestureCore, {
  doubleClick,
  pan,
  rotate,
  zoom,
} from "../lib/gesture";

function touchVec4(touch) {
  return [touch?.x ?? 0, touch?.y ?? 0, touch?.active ?? 0, 0];
}

function feature(factory, options) {
  if (options === false) return null;
  if (options == null || options === true) return factory();
  return factory(options);
}

function getUniforms(controller, canvas, maxTouches = 5) {
  const rect = canvas.getBoundingClientRect();
  const state = controller.getUVState(rect);
  const touches = controller.getTouchUVState(maxTouches, rect);

  return {
    gestureTransform: [
      state.centerX,
      state.centerY,
      state.zoom,
      state.angle,
    ],
    gestureState: [
      state.dragging ? 1 : 0,
      state.pinching ? 1 : 0,
      state.isPressed ? 1 : 0,
      0,
    ],
    touches: [
      touchVec4(touches[0]),
      touchVec4(touches[1]),
      touchVec4(touches[2]),
      touchVec4(touches[3]),
      touchVec4(touches[4]),
    ],
  };
}

export function createGesture(
  canvas,
  {
    maxTouches = 5,
    pan: panOptions = {},
    rotate: rotateOptions = {},
    zoom: zoomOptions = {},
    doubleClick: doubleClickOptions = { reset: {} },
  } = {}
) {
  const controller = gestureCore(
    canvas,
    ...[
      feature(pan, panOptions),
      feature(rotate, rotateOptions),
      feature(zoom, zoomOptions),
      feature(doubleClick, doubleClickOptions),
    ].filter(Boolean)
  );

  return {
    controller,
    get uniforms() {
      return getUniforms(controller, canvas, maxTouches);
    },
    destroy() {
      controller.destroy();
    },
  };
}
