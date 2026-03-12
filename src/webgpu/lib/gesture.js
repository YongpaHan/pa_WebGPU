const FEATURE_TOKEN = Symbol("pa_gesture.feature");
const EVENT_TYPES = [
  "click",
  "doubleClick",
  "dragStart",
  "dragMove",
  "dragEnd",
];
const DEFAULT_TRANSFORM = Object.freeze({
  x: 0,
  y: 0,
  zoom: 1,
  angle: 0,
});
const DEFAULT_UV_TRANSFORM = Object.freeze({
  centerX: 0,
  centerY: 0,
});
const DEFAULT_RESET_OPTIONS = Object.freeze({
  immediate: false,
  damping: {
    pan: 0.1,
    rotate: 0.1,
    zoom: 0.1,
  },
  only: null,
});
const DEFAULT_RESET_PATCH = Object.freeze({
  ...DEFAULT_TRANSFORM,
  ...DEFAULT_UV_TRANSFORM,
});
const RESET_PATCH_KEYS = Object.freeze([
  "x",
  "y",
  "zoom",
  "angle",
  "centerX",
  "centerY",
]);
const EPSILON = 0.0001;
const RESET_MOTION_PROFILE = Object.freeze({
  curve: 0.25,
  maxStepRatio: 0.5,
  reference: Object.freeze({
    viewportFraction: 2,
    quarterTurn: Math.PI * 0.25,
    zoomOctave: Math.log(3),
  }),
});

class EventEmitter {
  constructor() {
    this.listeners = new Map();
  }

  on(type, handler) {
    if (typeof handler !== "function") {
      throw new TypeError("Event handler must be a function.");
    }

    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }

    const set = this.listeners.get(type);
    set.add(handler);
    return () => this.off(type, handler);
  }

  off(type, handler) {
    const set = this.listeners.get(type);
    if (!set) {
      return this;
    }

    set.delete(handler);
    if (set.size === 0) {
      this.listeners.delete(type);
    }
    return this;
  }

  emit(type, payload) {
    const set = this.listeners.get(type);
    if (!set || set.size === 0) {
      return;
    }

    for (const handler of Array.from(set)) {
      handler(payload);
    }
  }

  clear() {
    this.listeners.clear();
  }
}

export class Controller {
  constructor(target, features = []) {
    if (!isElement(target)) {
      throw new TypeError("Controller target must be an HTMLElement.");
    }

    this.target = target;
    this._window = getWindow(target);
    this._emitter = new EventEmitter();
    this._destroyed = false;
    this._rafId = 0;
    this._animationOverride = null;
    this._animationOverrideSource = null;
    this._activePointers = new Map();
    this._primarySession = null;
    this._pendingClick = null;
    this._lastTap = null;
    this._managedStyleRestore = null;
    this._uvTouchActionManaged = false;
    this._resetOptions = { ...DEFAULT_RESET_OPTIONS };

    this._current = { ...DEFAULT_TRANSFORM };
    this._target = { ...DEFAULT_TRANSFORM };
    this._uvCurrent = { ...DEFAULT_UV_TRANSFORM };
    this._uvTarget = { ...DEFAULT_UV_TRANSFORM };
    this._state = {
      dragging: false,
      pinching: false,
      isPressed: false,
      lastClickAt: 0,
      pointerX: 0,
      pointerY: 0,
    };

    this._featureSet = normalizeFeatureSet(features);
    this._dragFeature = pickLastFeature(this._featureSet.drag);
    this._clickFeature = pickLastFeature(this._featureSet.click);
    this._doubleClickFeature = pickLastFeature(this._featureSet.doubleClick);
    this._panFeature = pickLastFeature(this._featureSet.pan);
    this._rotateFeature = pickLastFeature(this._featureSet.rotate);
    this._zoomFeature = pickLastFeature(this._featureSet.zoom);
    this._cssVarsFeatures = this._featureSet.cssVars;
    this._managedCssVarsFeature = pickLastFeature(this._featureSet.cssVars);

    this._bindPublicMethods();
    this._bindHandlers();
    this._setupManagedStyles();
    this._bindEvents();
    this._applyOutputs();
  }

  getState() {
    return createStateSnapshot(this._current, this._state);
  }

  getUVState(rect = null) {
    this._ensureUVTouchAction();
    return createUVStateSnapshot(
      this._current,
      this._uvCurrent,
      this._state,
      rect ?? this.target.getBoundingClientRect()
    );
  }

  getTouchUVState(maxTouches = 5, rect = null) {
    ensureNotDestroyed(this);
    return createTouchUVStateSnapshot(
      this._activePointers,
      normalizeTouchCount(maxTouches),
      rect ?? this.target.getBoundingClientRect()
    );
  }

  setState(patch = {}, options = {}) {
    ensureNotDestroyed(this);
    applyTransformPatch(this._target, patch, this._zoomFeature);
    applyUVTransformPatch(this._uvTarget, patch);
    const immediate = options.immediate ?? true;

    if (immediate) {
      this._clearAnimationOverride();
      applyTransformPatch(this._current, patch, this._zoomFeature);
      applyUVTransformPatch(this._uvCurrent, patch);
      this._applyOutputs();
      return this;
    }

    this._animationOverride = createAnimationOverride(options.damping);
    this._animationOverrideSource = options.animationSource ?? null;
    this._requestFrame();
    return this;
  }

  setResetOptions(options = {}) {
    ensureNotDestroyed(this);
    if (!options || typeof options !== "object") {
      throw new TypeError(
        "Controller.setResetOptions() options must be an object."
      );
    }

    this._resetOptions = {
      ...this._resetOptions,
      ...options,
    };
    return this;
  }

  setResetDamping(damping) {
    return this.setResetOptions({ damping });
  }

  reset(next = {}, options = {}) {
    if (looksLikeGesturePayload(next)) {
      next = {};
      options = {};
    }

    const resetOptions = {
      ...this._resetOptions,
      ...options,
    };
    const resetKeys = resolveResetKeys(resetOptions.only);
    delete resetOptions.only;
    if (resetOptions.immediate !== true) {
      resetOptions.animationSource = "reset";
    }

    const resetPatch = {
      ...DEFAULT_RESET_PATCH,
      ...next,
    };
    if (resetOptions.immediate !== true && isFiniteNumber(resetPatch.angle)) {
      resetPatch.angle = resolveNearestAngleTarget(
        this._current.angle,
        resetPatch.angle
      );
    }

    return this.setState(
      resetKeys ? pickPatchByKeys(resetPatch, resetKeys) : resetPatch,
      resetOptions
    );
  }

  on(type, handler) {
    ensureNotDestroyed(this);
    return this._emitter.on(type, handler);
  }

  off(type, handler) {
    ensureNotDestroyed(this);
    this._emitter.off(type, handler);
    return this;
  }

  destroy() {
    if (this._destroyed) {
      return;
    }

    this._destroyed = true;
    this.target.removeEventListener("pointerdown", this._onPointerDown);
    this._window.removeEventListener("pointermove", this._onPointerMove);
    this._window.removeEventListener("pointerup", this._onPointerUp);
    this._window.removeEventListener("pointercancel", this._onPointerCancel);

    if (this._zoomFeature?.options.wheel) {
      this.target.removeEventListener("wheel", this._onWheelZoom);
    }

    if (this._rafId) {
      cancelFrame(this._rafId, this._window);
      this._rafId = 0;
    }

    this._clearPendingClick();
    this._activePointers.clear();
    this._primarySession = null;
    this._emitter.clear();

    this._restoreManagedStyles();
  }

  _bindPublicMethods() {
    this.getState = this.getState.bind(this);
    this.getUVState = this.getUVState.bind(this);
    this.getTouchUVState = this.getTouchUVState.bind(this);
    this.setState = this.setState.bind(this);
    this.setResetOptions = this.setResetOptions.bind(this);
    this.setResetDamping = this.setResetDamping.bind(this);
    this.reset = this.reset.bind(this);
    this.on = this.on.bind(this);
    this.off = this.off.bind(this);
    this.destroy = this.destroy.bind(this);
  }

  _bindHandlers() {
    this._onPointerDown = this._handlePointerDown.bind(this);
    this._onPointerMove = this._handlePointerMove.bind(this);
    this._onPointerUp = this._handlePointerUp.bind(this);
    this._onPointerCancel = this._handlePointerCancel.bind(this);
    this._onWheelZoom = this._handleWheelZoom.bind(this);
    this._onFrame = this._tick.bind(this);
  }

  _setupManagedStyles() {
    if (!this._managedCssVarsFeature) {
      return;
    }

    const options = this._managedCssVarsFeature.options;
    const manageTouchAction = shouldManageTouchAction(this, options);
    const manageCursor = shouldManageCursor(this, options);
    const manageTransform = shouldManageTransform(this, options);
    const manageDraggingAttr = Boolean(options.draggingAttr);

    if (
      !manageTouchAction &&
      !manageCursor &&
      !manageTransform &&
      !manageDraggingAttr
    ) {
      return;
    }

    this._managedStyleRestore = {
      touchAction: manageTouchAction ? this.target.style.touchAction : null,
      cursor: manageCursor ? this.target.style.cursor : null,
      transform: manageTransform ? this.target.style.transform : null,
      transformBase: manageTransform
        ? readComputedTransform(this.target, this._window)
        : "",
      hadDraggingAttr: manageDraggingAttr
        ? hasAttribute(this.target, "data-pa-dragging")
        : false,
      draggingAttrValue: manageDraggingAttr
        ? getAttribute(this.target, "data-pa-dragging")
        : null,
    };

    if (manageTouchAction) {
      this.target.style.touchAction = "none";
    }
  }

  _ensureUVTouchAction() {
    if (this._uvTouchActionManaged) {
      return;
    }

    if (!shouldManageUVTouchAction(this)) {
      return;
    }

    if (!this._managedStyleRestore) {
      this._managedStyleRestore = {
        touchAction: this.target.style.touchAction,
        cursor: null,
        transform: null,
        transformBase: "",
        hadDraggingAttr: false,
        draggingAttrValue: null,
      };
    } else if (this._managedStyleRestore.touchAction === null) {
      this._managedStyleRestore.touchAction = this.target.style.touchAction;
    }

    this.target.style.touchAction = "none";
    this._uvTouchActionManaged = true;
  }

  _bindEvents() {
    this.target.addEventListener("pointerdown", this._onPointerDown);
    this._window.addEventListener("pointermove", this._onPointerMove);
    this._window.addEventListener("pointerup", this._onPointerUp);
    this._window.addEventListener("pointercancel", this._onPointerCancel);

    if (this._zoomFeature?.options.wheel) {
      this.target.addEventListener("wheel", this._onWheelZoom, {
        passive: false,
      });
    }
  }

  _handlePointerDown(event) {
    if (this._destroyed) {
      return;
    }

    if (!this._acceptsPointerStart(event)) {
      return;
    }

    this._cancelResetAnimationOverride();

    this._updatePointerState(event);
    this._setPointerRecord(event.pointerId, event);
    this._state.isPressed = true;

    if (typeof this.target.setPointerCapture === "function") {
      try {
        this.target.setPointerCapture(event.pointerId);
      } catch {
        // Ignore browsers that reject capture for non-active pointers.
      }
    }

    if (this._activePointers.size === 1) {
      this._primarySession = this._createPrimarySession(event);
    } else if (this._activePointers.size === 2) {
      this._promoteToPinch(event);
    } else if (this._primarySession) {
      this._primarySession.suppressClick = true;
    }

    this._requestFrame();
  }

  _handlePointerMove(event) {
    if (this._destroyed) {
      return;
    }

    const pointer = this._activePointers.get(event.pointerId);
    if (!pointer) {
      return;
    }

    pointer.x = event.clientX;
    pointer.y = event.clientY;
    this._updatePointerState(event);

    if (this._activePointers.size >= 2) {
      this._handlePinchMove(event);
      this._syncPointerPrevToCurrent();
      this._requestFrame();
      return;
    }

    if (
      !this._primarySession ||
      this._primarySession.pointerId !== event.pointerId
    ) {
      this._primarySession = this._createSessionFromPointer(pointer, event);
    }

    this._handlePrimaryMove(event, pointer);
    pointer.prevX = pointer.x;
    pointer.prevY = pointer.y;
    this._requestFrame();
  }

  _handlePointerUp(event) {
    this._finalizePointer(event, false);
  }

  _handlePointerCancel(event) {
    this._finalizePointer(event, true);
  }

  _finalizePointer(event, cancelled) {
    if (this._destroyed) {
      return;
    }

    const pointer = this._activePointers.get(event.pointerId);
    if (!pointer) {
      return;
    }

    this._updatePointerState(event);

    const session = this._primarySession;
    const endingPrimary = session && session.pointerId === event.pointerId;
    const wasPinching = this._activePointers.size >= 2;
    this._state.isPressed = this._activePointers.size > 1;

    if (endingPrimary) {
      const totalX = event.clientX - session.startX;
      const totalY = event.clientY - session.startY;
      const totalDistance = getDistance(totalX, totalY);
      const duration = getEventTime(event) - session.startTime;

      if (session.dragEmitting) {
        this._emit("dragEnd", event, {
          dx: 0,
          dy: 0,
          totalX,
          totalY,
        });
      }

      this._handleTapRecognition(
        event,
        session,
        totalDistance,
        duration,
        cancelled
      );
    }

    this._activePointers.delete(event.pointerId);

    if (typeof this.target.releasePointerCapture === "function") {
      try {
        this.target.releasePointerCapture(event.pointerId);
      } catch {
        // Ignore browsers that auto-release capture.
      }
    }

    if (wasPinching && this._activePointers.size < 2) {
      this._state.pinching = false;
      this._state.dragging = false;
      this._syncPointerPrevToCurrent();
      this._primarySession = this._seedSessionFromRemainingPointer(event);
    } else if (this._activePointers.size === 0) {
      this._state.pinching = false;
      this._state.dragging = false;
      this._primarySession = null;
    } else if (endingPrimary) {
      this._primarySession = this._seedSessionFromRemainingPointer(event);
      this._state.dragging = false;
    }

    this._state.isPressed = this._activePointers.size > 0;
    this._requestFrame();
  }

  _handleWheelZoom(event) {
    if (!this._zoomFeature?.options.wheel || this._destroyed) {
      return;
    }

    this._cancelResetAnimationOverride();

    if (event.cancelable) {
      event.preventDefault();
    }

    this._state.pointerX = event.clientX;
    this._state.pointerY = event.clientY;

    const factor = Math.exp(-event.deltaY * 0.001);
    const nextZoom = clampZoom(
      this._target.zoom * factor,
      this._zoomFeature.options
    );
    this._target.zoom = nextZoom;
    this._requestFrame();
  }

  _handlePrimaryMove(event, pointer) {
    const session = this._primarySession;
    const dx = pointer.x - pointer.prevX;
    const dy = pointer.y - pointer.prevY;
    const totalX = pointer.x - session.startX;
    const totalY = pointer.y - session.startY;
    const totalDistance = getDistance(totalX, totalY);
    const motionThreshold = this._getMotionThreshold();
    const rect = this.target.getBoundingClientRect();
    const previousAngle = this._target.angle;
    const previousZoom = this._target.zoom;
    let nextAngle = previousAngle;
    let nextZoom = previousZoom;

    if (
      this._canEmitDrag() &&
      !session.dragEmitting &&
      totalDistance >= motionThreshold
    ) {
      session.dragEmitting = true;
      this._state.dragging = true;
      this._emit("dragStart", event, {
        dx,
        dy,
        totalX,
        totalY,
      });
    }

    if (session.dragEmitting) {
      this._state.dragging = true;
      this._emit("dragMove", event, {
        dx,
        dy,
        totalX,
        totalY,
      });
    } else if (
      this._hasSinglePointerMotion() &&
      totalDistance >= motionThreshold
    ) {
      this._state.dragging = true;
    }

    if (this._panFeature) {
      applyPanDelta(this._target, dx, dy, this._panFeature.options.axis);
    } else if (this._rotateFeature) {
      nextAngle += this._measureSinglePointerRotation(pointer, rect);
      this._target.angle = nextAngle;
    }

    this._applyUvAnchor(
      pointer.prevX,
      pointer.prevY,
      pointer.x,
      pointer.y,
      rect,
      previousAngle,
      previousZoom,
      nextAngle,
      nextZoom
    );

    if (
      (this._panFeature || this._rotateFeature) &&
      event.pointerType !== "mouse"
    ) {
      if (event.cancelable) {
        event.preventDefault();
      }
    }

    session.lastX = pointer.x;
    session.lastY = pointer.y;
  }

  _handlePinchMove(event) {
    const pointers = this._activePointers.values();
    const first = pointers.next().value;
    const second = pointers.next().value;
    if (!first || !second) {
      return;
    }

    const metrics = measurePinch(first, second);
    this._state.pinching = true;
    this._state.dragging = false;
    const previousAngle = this._target.angle;
    const previousZoom = this._target.zoom;
    let nextAngle = previousAngle;
    let nextZoom = previousZoom;

    if (this._panFeature) {
      applyPanDelta(
        this._target,
        metrics.panDelta.x,
        metrics.panDelta.y,
        this._panFeature.options.axis
      );
    }

    if (this._rotateFeature) {
      nextAngle += metrics.angleDelta;
      this._target.angle = nextAngle;
    }

    if (this._zoomFeature?.options.pinch) {
      nextZoom = clampZoom(
        previousZoom * metrics.zoomFactor,
        this._zoomFeature.options
      );
      this._target.zoom = nextZoom;
    }

    const rect = this.target.getBoundingClientRect();
    this._applyUvAnchor(
      metrics.prevCenter.x,
      metrics.prevCenter.y,
      metrics.currentCenter.x,
      metrics.currentCenter.y,
      rect,
      previousAngle,
      previousZoom,
      nextAngle,
      nextZoom
    );

    if (event.cancelable) {
      event.preventDefault();
    }
  }

  _handleTapRecognition(event, session, totalDistance, duration, cancelled) {
    if (
      cancelled ||
      session.suppressClick ||
      (session.pointerType === "pen" && event.button < 0)
    ) {
      return;
    }

    const button = normalizeButton(event);
    const clickOptions = this._clickFeature?.options;
    const doubleOptions = this._doubleClickFeature?.options;
    const clickAllowed =
      clickOptions &&
      matchesButton(button, clickOptions.button) &&
      totalDistance <= clickOptions.maxDistance &&
      duration <= clickOptions.maxDelay;
    const doubleAllowed =
      doubleOptions &&
      matchesButton(button, doubleOptions.button) &&
      totalDistance <= doubleOptions.maxDistance;

    if (!clickAllowed && !doubleAllowed) {
      return;
    }

    const payload = this._buildPayload(event, {
      type: "click",
      dx: 0,
      dy: 0,
      totalX: 0,
      totalY: 0,
    });

    if (doubleAllowed) {
      const now = getEventTime(event);
      const lastTap = this._lastTap;
      const isDouble =
        lastTap &&
        lastTap.button === button &&
        now - lastTap.time <= doubleOptions.delay &&
        getDistance(payload.x - lastTap.x, payload.y - lastTap.y) <=
          doubleOptions.maxDistance;

      if (isDouble) {
        this._clearPendingClick();
        this._lastTap = null;
        this._emit("doubleClick", event, {
          dx: 0,
          dy: 0,
          totalX: 0,
          totalY: 0,
        });
        this._applyDoubleClickReset(doubleOptions.reset);
        return;
      }

      this._lastTap = {
        x: payload.x,
        y: payload.y,
        time: now,
        button,
      };

      if (clickAllowed) {
        this._scheduleClick(event, payload, doubleOptions.delay);
      }
      return;
    }

    if (clickAllowed) {
      this._state.lastClickAt = getNow(this._window);
      this._emit("click", event, {
        dx: 0,
        dy: 0,
        totalX: 0,
        totalY: 0,
      });
    }
  }

  _scheduleClick(event, payload, delay) {
    this._clearPendingClick();
    const timer = this._window.setTimeout(() => {
      this._pendingClick = null;
      const now = getNow(this._window);
      this._state.lastClickAt = now;
      payload.state.lastClickAt = now;
      this._emitter.emit("click", payload);
    }, delay);

    this._pendingClick = {
      timer,
      payload,
      originalEvent: event,
    };
  }

  _clearPendingClick() {
    if (!this._pendingClick) {
      return;
    }

    this._window.clearTimeout(this._pendingClick.timer);
    this._pendingClick = null;
  }

  _applyDoubleClickReset(resetConfig) {
    const normalized = normalizeDoubleClickResetConfig(resetConfig);
    if (!normalized) {
      return;
    }

    this.reset(normalized.next, normalized.options);
  }

  _tick() {
    this._rafId = 0;

    if (this._destroyed) {
      return;
    }

    const animating = this._advanceTransform();
    this._applyOutputs();

    if (animating || this._state.dragging || this._state.pinching) {
      this._requestFrame();
    }
  }

  _cancelResetAnimationOverride() {
    if (this._animationOverrideSource !== "reset") {
      return;
    }
    this._syncTargetsToCurrent();
    this._clearAnimationOverride();
  }

  _clearAnimationOverride() {
    this._animationOverride = null;
    this._animationOverrideSource = null;
  }

  _syncTargetsToCurrent() {
    this._target.x = this._current.x;
    this._target.y = this._current.y;
    this._target.zoom = this._current.zoom;
    this._target.angle = this._current.angle;
    this._uvTarget.centerX = this._uvCurrent.centerX;
    this._uvTarget.centerY = this._uvCurrent.centerY;
  }

  _advanceTransform() {
    const panDamping =
      this._animationOverride?.pan ?? this._panFeature?.options.damping ?? 1;
    const rotateDamping =
      this._animationOverride?.rotate ??
      this._rotateFeature?.options.damping ??
      1;
    const zoomDamping =
      this._animationOverride?.zoom ?? this._zoomFeature?.options.damping ?? 1;
    const isResetAnimation = this._animationOverrideSource === "reset";
    const resetViewport = isResetAnimation
      ? getResetViewport(this.target)
      : null;
    const xResetChannel = isResetAnimation
      ? resolveResetChannel("x", resetViewport)
      : null;
    const yResetChannel = isResetAnimation
      ? resolveResetChannel("y", resetViewport)
      : null;
    const centerXResetChannel = isResetAnimation
      ? resolveResetChannel("centerX", resetViewport)
      : null;
    const centerYResetChannel = isResetAnimation
      ? resolveResetChannel("centerY", resetViewport)
      : null;
    const angleResetChannel = isResetAnimation
      ? resolveResetChannel("angle", resetViewport)
      : null;
    const zoomResetChannel = isResetAnimation
      ? resolveResetChannel("zoom", resetViewport)
      : null;
    const centerResetDamping = isResetAnimation
      ? panDamping / Math.sqrt(Math.max(this._current.zoom, 1))
      : panDamping;
    const xAnimating = isResetAnimation
      ? stepTowardReset(
          this._current,
          this._target,
          "x",
          panDamping,
          xResetChannel
        )
      : stepToward(this._current, this._target, "x", panDamping);
    const yAnimating = isResetAnimation
      ? stepTowardReset(
          this._current,
          this._target,
          "y",
          panDamping,
          yResetChannel
        )
      : stepToward(this._current, this._target, "y", panDamping);
    const centerXAnimating = isResetAnimation
      ? stepTowardReset(
          this._uvCurrent,
          this._uvTarget,
          "centerX",
          centerResetDamping,
          centerXResetChannel
        )
      : stepToward(this._uvCurrent, this._uvTarget, "centerX", panDamping);
    const centerYAnimating = isResetAnimation
      ? stepTowardReset(
          this._uvCurrent,
          this._uvTarget,
          "centerY",
          centerResetDamping,
          centerYResetChannel
        )
      : stepToward(this._uvCurrent, this._uvTarget, "centerY", panDamping);
    const angleAnimating = isResetAnimation
      ? stepTowardReset(
          this._current,
          this._target,
          "angle",
          rotateDamping,
          angleResetChannel
        )
      : stepToward(this._current, this._target, "angle", rotateDamping);
    const zoomAnimating = isResetAnimation
      ? stepTowardReset(
          this._current,
          this._target,
          "zoom",
          zoomDamping,
          zoomResetChannel
        )
      : stepTowardLog(this._current, this._target, "zoom", zoomDamping);

    const animating =
      xAnimating ||
      yAnimating ||
      centerXAnimating ||
      centerYAnimating ||
      angleAnimating ||
      zoomAnimating;
    if (!animating) {
      this._clearAnimationOverride();
    }

    return animating;
  }

  _applyOutputs() {
    if (this._cssVarsFeatures.length === 0) {
      return;
    }

    const style = this.target.style;
    const xValue = `${this._current.x}px`;
    const yValue = `${this._current.y}px`;
    const zoomValue = `${this._current.zoom}`;
    const angleDeg = `${(this._current.angle * 180) / Math.PI}deg`;
    for (const feature of this._cssVarsFeatures) {
      const { x, y, zoom, angle } = feature.options;
      setStyleProperty(style, x, xValue);
      setStyleProperty(style, y, yValue);
      setStyleProperty(style, zoom, zoomValue);
      setStyleProperty(style, angle, angleDeg);
    }

    if (!this._managedCssVarsFeature) {
      return;
    }

    const options = this._managedCssVarsFeature.options;
    if (shouldManageTransform(this, options)) {
      const transformValue = joinTransforms(
        this._managedStyleRestore?.transformBase,
        buildTransformExpression(options)
      );
      if (style.transform !== transformValue) {
        style.transform = transformValue;
      }
    }
    if (shouldManageCursor(this, options)) {
      const cursorValue = this._state.dragging ? "grabbing" : "grab";
      if (style.cursor !== cursorValue) {
        style.cursor = cursorValue;
      }
    }
    if (options.draggingAttr) {
      const draggingValue = this._state.dragging ? "true" : "false";
      if (getAttribute(this.target, "data-pa-dragging") !== draggingValue) {
        setAttribute(this.target, "data-pa-dragging", draggingValue);
      }
    }
  }

  _requestFrame() {
    if (this._destroyed || this._rafId) {
      return;
    }

    this._rafId = requestFrame(this._onFrame, this._window);
  }

  _updatePointerState(event) {
    this._state.pointerX = event.clientX;
    this._state.pointerY = event.clientY;
  }

  _applyUvAnchor(
    previousClientX,
    previousClientY,
    nextClientX,
    nextClientY,
    rect,
    previousAngle,
    previousZoom,
    nextAngle,
    nextZoom
  ) {
    const centerX = rect.left + rect.width * 0.5;
    const centerY = rect.top + rect.height * 0.5;
    const previousPointX = previousClientX - centerX;
    const previousPointY = centerY - previousClientY;
    const nextPointX = nextClientX - centerX;
    const nextPointY = centerY - nextClientY;
    const previousCos = Math.cos(previousAngle);
    const previousSin = Math.sin(previousAngle);
    const nextCos = Math.cos(nextAngle);
    const nextSin = Math.sin(nextAngle);
    const previousZoomSafe = Math.max(previousZoom, EPSILON);
    const nextZoomSafe = Math.max(nextZoom, EPSILON);
    const previousUvX =
      previousCos * previousPointX - previousSin * previousPointY;
    const previousUvY =
      previousSin * previousPointX + previousCos * previousPointY;
    const nextUvX = nextCos * nextPointX - nextSin * nextPointY;
    const nextUvY = nextSin * nextPointX + nextCos * nextPointY;

    this._uvTarget.centerX +=
      previousUvX / previousZoomSafe - nextUvX / nextZoomSafe;
    this._uvTarget.centerY +=
      previousUvY / previousZoomSafe - nextUvY / nextZoomSafe;
  }

  _setPointerRecord(pointerId, event) {
    this._activePointers.set(pointerId, {
      pointerId,
      pointerType: event.pointerType,
      button: normalizeButton(event),
      x: event.clientX,
      y: event.clientY,
      prevX: event.clientX,
      prevY: event.clientY,
    });
  }

  _syncPointerPrevToCurrent() {
    for (const pointer of this._activePointers.values()) {
      pointer.prevX = pointer.x;
      pointer.prevY = pointer.y;
    }
  }

  _acceptsPointerStart(event) {
    if (event.pointerType === "mouse" && event.button < 0) {
      return false;
    }

    const needsPrimaryButton =
      this._dragFeature ||
      this._clickFeature ||
      this._doubleClickFeature ||
      this._panFeature ||
      this._rotateFeature;

    if (!needsPrimaryButton || event.pointerType !== "mouse") {
      return true;
    }

    const button = normalizeButton(event);
    return (
      matchesConfiguredButton(this._dragFeature, button) ||
      matchesConfiguredButton(this._clickFeature, button) ||
      matchesConfiguredButton(this._doubleClickFeature, button) ||
      (!this._dragFeature &&
        !this._clickFeature &&
        !this._doubleClickFeature &&
        button === 0)
    );
  }

  _createPrimarySession(event) {
    return {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      button: normalizeButton(event),
      startX: event.clientX,
      startY: event.clientY,
      startTime: getEventTime(event),
      lastX: event.clientX,
      lastY: event.clientY,
      dragEmitting: false,
      suppressClick: false,
    };
  }

  _createSessionFromPointer(pointer, event) {
    return {
      pointerId: pointer.pointerId,
      pointerType: pointer.pointerType,
      button: pointer.button,
      startX: pointer.x,
      startY: pointer.y,
      startTime: getEventTime(event),
      lastX: pointer.x,
      lastY: pointer.y,
      dragEmitting: false,
      suppressClick: true,
    };
  }

  _seedSessionFromRemainingPointer(event) {
    const remaining = this._activePointers.values().next().value;
    if (!remaining) {
      return null;
    }
    return this._createSessionFromPointer(remaining, event);
  }

  _promoteToPinch(event) {
    if (this._primarySession?.dragEmitting) {
      this._emit("dragEnd", event, {
        dx: 0,
        dy: 0,
        totalX: 0,
        totalY: 0,
      });
    }

    if (this._primarySession) {
      this._primarySession.suppressClick = true;
    }

    this._state.dragging = false;
    this._state.pinching = true;
    this._syncPointerPrevToCurrent();
  }

  _measureSinglePointerRotation(pointer, rect) {
    const centerX = rect.left + rect.width * 0.5;
    const centerY = rect.top + rect.height * 0.5;
    const prevX = pointer.prevX - centerX;
    const prevY = pointer.prevY - centerY;
    const nextX = pointer.x - centerX;
    const nextY = pointer.y - centerY;
    const dot = prevX * nextX + prevY * nextY;
    const cross = prevX * nextY - prevY * nextX;
    return Math.atan2(cross, dot);
  }

  _getMotionThreshold() {
    if (this._dragFeature) {
      return this._dragFeature.options.threshold;
    }
    return 0;
  }

  _canEmitDrag() {
    return Boolean(this._dragFeature);
  }

  _hasSinglePointerMotion() {
    return Boolean(
      this._dragFeature || this._panFeature || this._rotateFeature
    );
  }

  _emit(type, originalEvent, data) {
    this._emitter.emit(
      type,
      this._buildPayload(originalEvent, { type, ...data })
    );
  }

  _buildPayload(originalEvent, data) {
    return {
      type: data.type,
      target: this.target,
      controller: this,
      state: this.getState(),
      x: this._state.pointerX,
      y: this._state.pointerY,
      originalEvent,
      ...data,
    };
  }

  _restoreManagedStyles() {
    if (!this._managedStyleRestore) {
      return;
    }

    if (this._managedStyleRestore.touchAction !== null) {
      this.target.style.touchAction = this._managedStyleRestore.touchAction;
    }
    if (this._managedStyleRestore.cursor !== null) {
      this.target.style.cursor = this._managedStyleRestore.cursor;
    }
    if (this._managedStyleRestore.transform !== null) {
      this.target.style.transform = this._managedStyleRestore.transform;
    }
    if (this._managedStyleRestore.hadDraggingAttr) {
      setAttribute(
        this.target,
        "data-pa-dragging",
        this._managedStyleRestore.draggingAttrValue ?? ""
      );
    } else {
      removeAttribute(this.target, "data-pa-dragging");
    }

    this._managedStyleRestore = null;
    this._uvTouchActionManaged = false;
  }
}

export class ControllerGroup {
  constructor(targets, features = []) {
    this._controllers = targets.map(
      (target) => new Controller(target, features)
    );
    this.targets = this._controllers.map((controller) => controller.target);
    this.size = this._controllers.length;
    this._byTarget = new Map(
      this._controllers.map((controller) => [controller.target, controller])
    );
    this._emitter = new EventEmitter();
    this._forwardUnsubscribers = [];

    for (const controller of this._controllers) {
      for (const type of EVENT_TYPES) {
        this._forwardUnsubscribers.push(
          controller.on(type, (payload) => {
            this._emitter.emit(type, {
              ...payload,
              controller,
            });
          })
        );
      }
    }

    this._bindPublicMethods();
  }

  _bindPublicMethods() {
    this.get = this.get.bind(this);
    this.getState = this.getState.bind(this);
    this.getUVState = this.getUVState.bind(this);
    this.setState = this.setState.bind(this);
    this.setResetOptions = this.setResetOptions.bind(this);
    this.setResetDamping = this.setResetDamping.bind(this);
    this.reset = this.reset.bind(this);
    this.resetAll = this.resetAll.bind(this);
    this.forEach = this.forEach.bind(this);
    this.on = this.on.bind(this);
    this.off = this.off.bind(this);
    this.destroy = this.destroy.bind(this);
  }

  get(targetOrIndex) {
    if (typeof targetOrIndex === "number") {
      return this._controllers[targetOrIndex];
    }
    if (isElement(targetOrIndex)) {
      return this._byTarget.get(targetOrIndex);
    }
    return undefined;
  }

  getState(targetOrIndex) {
    if (typeof targetOrIndex === "undefined") {
      return this._controllers.map((controller) => controller.getState());
    }

    return this.get(targetOrIndex)?.getState();
  }

  getUVState(targetOrIndex) {
    if (typeof targetOrIndex === "undefined") {
      return this._controllers.map((controller) => controller.getUVState());
    }

    return this.get(targetOrIndex)?.getUVState();
  }

  setState(patch = {}, options = {}) {
    this._controllers.forEach((controller) =>
      controller.setState(patch, options)
    );
    return this;
  }

  setResetOptions(options = {}) {
    this._controllers.forEach((controller) =>
      controller.setResetOptions(options)
    );
    return this;
  }

  setResetDamping(damping) {
    this._controllers.forEach((controller) =>
      controller.setResetDamping(damping)
    );
    return this;
  }

  reset(targetOrPayload, next = {}, options = {}) {
    const controller = resolveGroupControllerTarget(this, targetOrPayload);
    if (!controller) {
      if (typeof targetOrPayload === "undefined") {
        return this;
      }

      throw new TypeError(
        "ControllerGroup.reset() requires a target, index, controller, or gesture event payload. Use resetAll() to reset every target."
      );
    }

    controller.reset(next, options);
    return this;
  }

  resetAll(next = {}, options = {}) {
    this._controllers.forEach((controller) => controller.reset(next, options));
    return this;
  }

  forEach(fn) {
    this._controllers.forEach((controller, index) => {
      fn(controller, controller.target, index);
    });
    return this;
  }

  on(type, handler) {
    return this._emitter.on(type, handler);
  }

  off(type, handler) {
    this._emitter.off(type, handler);
    return this;
  }

  destroy() {
    for (const unsubscribe of this._forwardUnsubscribers.splice(0)) {
      unsubscribe();
    }
    for (const controller of this._controllers) {
      controller.destroy();
    }
    this._emitter.clear();
  }
}

export function drag(options = {}) {
  return createFeature("drag", {
    button: 0,
    threshold: 4,
    ...options,
  });
}

export function click(options = {}) {
  return createFeature("click", {
    button: 0,
    maxDistance: 6,
    maxDelay: 250,
    ...options,
  });
}

export function doubleClick(options = {}) {
  return createFeature("doubleClick", {
    button: 0,
    delay: 360,
    maxDistance: 24,
    reset: false,
    ...options,
  });
}

export function pan(options = {}) {
  return createFeature("pan", {
    axis: "both",
    damping: 0.2,
    ...options,
  });
}

export function rotate(options = {}) {
  return createFeature("rotate", {
    damping: 0.2,
    ...options,
  });
}

export function zoom(options = {}) {
  return createFeature("zoom", {
    min: 0.1,
    max: 24,
    damping: 0.2,
    wheel: true,
    pinch: true,
    ...options,
  });
}

export function cssVars(options = {}) {
  return createFeature("cssVars", {
    x: "--x",
    y: "--y",
    zoom: "--zoom",
    angle: "--angle",
    transform: "auto",
    cursor: "auto",
    touchAction: "auto",
    draggingAttr: true,
    ...options,
  });
}

export function gesture(target, ...features) {
  const targets = resolveTargets(target);
  if (targets.length === 0) {
    throw new Error("gesture() target matched no elements.");
  }

  if (targets.length === 1) {
    return new Controller(targets[0], features);
  }

  return new ControllerGroup(targets, features);
}

gesture.one = function gestureOne(target, ...features) {
  const targets = resolveTargets(target);
  if (targets.length !== 1) {
    throw new Error("gesture.one() requires exactly one target.");
  }

  return new Controller(targets[0], features);
};

gesture.all = function gestureAll(target, ...features) {
  const targets = resolveTargets(target);
  if (targets.length === 0) {
    throw new Error("gesture.all() target matched no elements.");
  }

  return new ControllerGroup(targets, features);
};

export default gesture;

function createFeature(type, options) {
  return {
    [FEATURE_TOKEN]: true,
    type,
    options,
  };
}

function normalizeFeatureSet(features) {
  const featureSet = {
    drag: [],
    click: [],
    doubleClick: [],
    pan: [],
    rotate: [],
    zoom: [],
    cssVars: [],
  };

  for (const feature of features) {
    if (!feature || feature[FEATURE_TOKEN] !== true) {
      throw new TypeError("gesture() received an invalid feature.");
    }

    if (!featureSet[feature.type]) {
      throw new TypeError(`Unsupported feature: ${feature.type}`);
    }

    featureSet[feature.type].push(feature);
  }

  return featureSet;
}

function pickLastFeature(list) {
  return list.length > 0 ? list[list.length - 1] : null;
}

function applyTransformPatch(targetTransform, patch, zoomFeature) {
  if (isFiniteNumber(patch.x)) {
    targetTransform.x = patch.x;
  }
  if (isFiniteNumber(patch.y)) {
    targetTransform.y = patch.y;
  }
  if (isFiniteNumber(patch.angle)) {
    targetTransform.angle = patch.angle;
  }
  if (isFiniteNumber(patch.zoom)) {
    targetTransform.zoom = clampZoom(
      patch.zoom,
      zoomFeature?.options ?? { min: -Infinity, max: Infinity }
    );
  }
}

function applyUVTransformPatch(targetTransform, patch) {
  if (isFiniteNumber(patch.centerX)) {
    targetTransform.centerX = patch.centerX;
  }
  if (isFiniteNumber(patch.centerY)) {
    targetTransform.centerY = patch.centerY;
  }
}

function buildTransformExpression(options) {
  return `translate(var(${options.x}, 0px), var(${options.y}, 0px)) rotate(var(${options.angle}, 0deg)) scale(var(${options.zoom}, 1))`;
}

function readComputedTransform(target, scope) {
  const getter =
    target?.ownerDocument?.defaultView?.getComputedStyle ||
    scope?.getComputedStyle ||
    globalThis.getComputedStyle;

  if (typeof getter !== "function") {
    return "";
  }

  const value = getter(target).transform;
  if (!value || value === "none") {
    return "";
  }
  return value;
}

function joinTransforms(base, gestureTransform) {
  if (!base) {
    return gestureTransform;
  }
  return `${base} ${gestureTransform}`;
}

function setStyleProperty(style, name, value) {
  if (style.getPropertyValue(name) !== value) {
    style.setProperty(name, value);
  }
}

function createAnimationOverride(value) {
  if (value == null) {
    return null;
  }

  if (isFiniteNumber(value)) {
    const normalized = normalizeDamping(value);
    return {
      pan: normalized,
      rotate: normalized,
      zoom: normalized,
    };
  }

  if (typeof value === "object") {
    return {
      pan: value.pan == null ? undefined : normalizeDamping(value.pan),
      rotate: value.rotate == null ? undefined : normalizeDamping(value.rotate),
      zoom: value.zoom == null ? undefined : normalizeDamping(value.zoom),
    };
  }

  return null;
}

function createStateSnapshot(transform, state) {
  return {
    x: transform.x,
    y: transform.y,
    zoom: transform.zoom,
    angle: transform.angle,
    dragging: state.dragging,
    pinching: state.pinching,
    isPressed: state.isPressed,
    lastClickAt: state.lastClickAt,
    pointerX: state.pointerX,
    pointerY: state.pointerY,
  };
}

function createUVStateSnapshot(transform, uvTransform, state, rect) {
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);

  return {
    centerX: uvTransform.centerX / width,
    centerY: uvTransform.centerY / height,
    zoom: transform.zoom,
    angle: transform.angle,
    dragging: state.dragging,
    pinching: state.pinching,
    isPressed: state.isPressed,
    lastClickAt: state.lastClickAt,
    pointerX: clampUnit((state.pointerX - rect.left) / width),
    pointerY: clampUnit((state.pointerY - rect.top) / height),
  };
}

function createTouchUVStateSnapshot(activePointers, count, rect) {
  if (count <= 0) {
    return [];
  }

  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const touches = new Array(count);
  let index = 0;

  for (const pointer of activePointers.values()) {
    if (pointer.pointerType !== "touch") {
      continue;
    }

    touches[index++] = createTouchUVPointerSnapshot(
      pointer,
      rect,
      width,
      height
    );
    if (index >= count) {
      return touches;
    }
  }

  if (index === 0) {
    for (const pointer of activePointers.values()) {
      touches[index++] = createTouchUVPointerSnapshot(
        pointer,
        rect,
        width,
        height
      );
      if (index >= count) {
        return touches;
      }
    }
  }

  while (index < count) {
    touches[index++] = { x: 0, y: 0, active: 0 };
  }

  return touches;
}

function createTouchUVPointerSnapshot(pointer, rect, width, height) {
  return {
    x: clampUnit((pointer.x - rect.left) / width),
    y: clampUnit((pointer.y - rect.top) / height),
    active: 1,
  };
}

function normalizeTouchCount(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}

function getResetViewport(target) {
  const rect = target.getBoundingClientRect();
  return {
    width: Math.max(1, rect.width),
    height: Math.max(1, rect.height),
  };
}

function resolveResetChannel(key, viewport) {
  const width =
    viewport?.width * RESET_MOTION_PROFILE.reference.viewportFraction || 1;
  const height =
    viewport?.height * RESET_MOTION_PROFILE.reference.viewportFraction || 1;

  switch (key) {
    case "x":
    case "centerX":
      return { unit: width, space: "linear" };
    case "y":
    case "centerY":
      return { unit: height, space: "linear" };
    case "angle":
      return {
        unit: RESET_MOTION_PROFILE.reference.quarterTurn,
        space: "linear",
        wrap: true,
      };
    case "zoom":
      return {
        unit: RESET_MOTION_PROFILE.reference.zoomOctave,
        space: "log",
      };
    default:
      return { unit: 1, space: "linear" };
  }
}

function applyPanDelta(transform, dx, dy, axis) {
  if (axis === "x") {
    transform.x += dx;
    return;
  }
  if (axis === "y") {
    transform.y += dy;
    return;
  }
  transform.x += dx;
  transform.y += dy;
}

function measurePinch(a, b) {
  const prevCenter = {
    x: (a.prevX + b.prevX) * 0.5,
    y: (a.prevY + b.prevY) * 0.5,
  };
  const currentCenter = {
    x: (a.x + b.x) * 0.5,
    y: (a.y + b.y) * 0.5,
  };
  const prevVector = {
    x: b.prevX - a.prevX,
    y: b.prevY - a.prevY,
  };
  const currentVector = {
    x: b.x - a.x,
    y: b.y - a.y,
  };

  const prevDistance = getDistance(prevVector.x, prevVector.y);
  const currentDistance = getDistance(currentVector.x, currentVector.y);
  const prevAngle = Math.atan2(prevVector.y, prevVector.x);
  const currentAngle = Math.atan2(currentVector.y, currentVector.x);

  return {
    prevCenter,
    currentCenter,
    panDelta: {
      x: currentCenter.x - prevCenter.x,
      y: currentCenter.y - prevCenter.y,
    },
    zoomFactor: prevDistance > EPSILON ? currentDistance / prevDistance : 1,
    angleDelta: normalizeAngleDelta(currentAngle - prevAngle),
  };
}

function clampUnit(value) {
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

function resolveResetKeys(only) {
  if (only == null) {
    return null;
  }

  const values = Array.isArray(only) ? only : [only];
  const keys = new Set();

  for (const value of values) {
    switch (value) {
      case "all":
        keys.add("x");
        keys.add("y");
        keys.add("centerX");
        keys.add("centerY");
        keys.add("zoom");
        keys.add("angle");
        break;
      case "pan":
        keys.add("x");
        keys.add("y");
        keys.add("centerX");
        keys.add("centerY");
        break;
      case "position":
      case "translate":
        keys.add("x");
        keys.add("y");
        break;
      case "center":
      case "uv":
        keys.add("centerX");
        keys.add("centerY");
        break;
      case "zoom":
        keys.add("zoom");
        break;
      case "rotate":
      case "rotation":
      case "angle":
        keys.add("angle");
        break;
      case "x":
      case "y":
      case "centerX":
      case "centerY":
        keys.add(value);
        break;
      default:
        throw new TypeError(`Unsupported reset key: ${String(value)}.`);
    }
  }

  return keys;
}

function normalizeDoubleClickResetConfig(value) {
  if (value == null || value === false) {
    return null;
  }

  if (value === true) {
    return {
      next: {},
      options: {},
    };
  }

  if (typeof value !== "object") {
    throw new TypeError(
      "doubleClick({ reset }) reset must be true, false, or an object."
    );
  }

  const next = {};
  if (value.next != null) {
    if (typeof value.next !== "object") {
      throw new TypeError(
        "doubleClick({ reset }) reset.next must be an object."
      );
    }
    Object.assign(next, pickResetPatch(value.next));
  }
  Object.assign(next, pickResetPatch(value));

  const options = {};
  if ("immediate" in value) {
    options.immediate = value.immediate;
  }
  if ("damping" in value) {
    options.damping = value.damping;
  }
  if ("only" in value) {
    options.only = value.only;
  }

  return { next, options };
}

function pickResetPatch(source) {
  const patch = {};
  for (const key of RESET_PATCH_KEYS) {
    if (isFiniteNumber(source[key])) {
      patch[key] = source[key];
    }
  }
  return patch;
}

function pickPatchByKeys(patch, keys) {
  const picked = {};
  for (const key of keys) {
    if (key in patch) {
      picked[key] = patch[key];
    }
  }
  return picked;
}

function stepToward(current, target, key, damping) {
  const safeDamping = normalizeDamping(damping);
  const delta = target[key] - current[key];

  if (Math.abs(delta) <= EPSILON) {
    current[key] = target[key];
    return false;
  }

  current[key] += delta * safeDamping;
  if (Math.abs(target[key] - current[key]) <= EPSILON) {
    current[key] = target[key];
  }
  return true;
}

function stepTowardReset(current, target, key, damping, channel) {
  const safeDamping = normalizeDamping(damping);
  const safeCurve = normalizeResetLogCurve(RESET_MOTION_PROFILE.curve);
  const safeUnitScale = normalizePositive(channel?.unit, 1);
  const safeMaxStep =
    safeUnitScale *
    normalizePositive(RESET_MOTION_PROFILE.maxStepRatio, Infinity);
  const useLogSpace = channel?.space === "log";
  const useAngleDelta = channel?.wrap === true;
  const currentValue = useLogSpace
    ? Math.max(current[key], EPSILON)
    : current[key];
  const targetValue = useLogSpace
    ? Math.max(target[key], EPSILON)
    : target[key];
  const rawDelta = useLogSpace
    ? Math.log(targetValue) - Math.log(currentValue)
    : targetValue - currentValue;
  const delta = useAngleDelta ? normalizeAngleDelta(rawDelta) : rawDelta;

  if (Math.abs(delta) <= EPSILON) {
    current[key] = target[key];
    return false;
  }

  const normalizedDelta = delta / safeUnitScale;
  const shapedDelta = shapeLogDelta(normalizedDelta, safeCurve) * safeUnitScale;
  let step = clamp(shapedDelta * safeDamping, -safeMaxStep, safeMaxStep);
  if (Math.abs(step) > Math.abs(delta)) {
    step = delta;
  }

  if (useLogSpace) {
    current[key] = Math.exp(Math.log(currentValue) + step);
  } else {
    current[key] += step;
  }

  const nextCurrentValue = useLogSpace
    ? Math.max(current[key], EPSILON)
    : current[key];
  const remainingRawDelta = useLogSpace
    ? Math.log(targetValue) - Math.log(nextCurrentValue)
    : targetValue - nextCurrentValue;
  const remaining = useAngleDelta
    ? normalizeAngleDelta(remainingRawDelta)
    : remainingRawDelta;

  if (Math.abs(remaining) <= EPSILON) {
    current[key] = target[key];
  }
  return true;
}

function stepTowardLog(current, target, key, damping) {
  const safeDamping = normalizeDamping(damping);
  const currentValue = Math.max(current[key], EPSILON);
  const targetValue = Math.max(target[key], EPSILON);
  const currentLog = Math.log(currentValue);
  const targetLog = Math.log(targetValue);
  const delta = targetLog - currentLog;

  if (Math.abs(delta) <= EPSILON) {
    current[key] = target[key];
    return false;
  }

  const logStep = delta * safeDamping;

  const nextLog = currentLog + logStep;
  current[key] = Math.exp(nextLog);

  if (Math.abs(targetLog - nextLog) <= EPSILON) {
    current[key] = target[key];
  }
  return true;
}

function shapeLogDelta(delta, logCurve) {
  return Math.sign(delta) * (Math.log1p(Math.abs(delta) * logCurve) / logCurve);
}

function normalizeDamping(value) {
  if (!isFiniteNumber(value)) {
    return 1;
  }
  if (value <= 0) {
    return 1;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

function normalizePositive(value, fallback) {
  if (!isFiniteNumber(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function normalizeResetLogCurve(value) {
  if (!isFiniteNumber(value) || value <= 0) {
    return 0.2;
  }
  return value;
}

function clampZoom(value, options) {
  return clamp(value, options.min, options.max);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getDistance(dx, dy) {
  return Math.hypot(dx, dy);
}

function normalizeAngleDelta(value) {
  if (value > Math.PI) {
    return value - Math.PI * 2;
  }
  if (value < -Math.PI) {
    return value + Math.PI * 2;
  }
  return value;
}

function resolveNearestAngleTarget(currentAngle, targetAngle) {
  return currentAngle + normalizeAngleDelta(targetAngle - currentAngle);
}

function matchesConfiguredButton(feature, button) {
  if (!feature) {
    return false;
  }
  return matchesButton(button, feature.options.button);
}

function matchesButton(button, expected) {
  return expected == null || button === expected;
}

function normalizeButton(event) {
  if (typeof event.button === "number" && event.button >= 0) {
    return event.button;
  }
  return 0;
}

function getEventTime(event) {
  if (typeof event.timeStamp === "number" && Number.isFinite(event.timeStamp)) {
    return event.timeStamp;
  }
  return Date.now();
}

function getNow(scope) {
  if (typeof scope?.performance?.now === "function") {
    return scope.performance.now();
  }
  return Date.now();
}

function resolveTargets(target) {
  if (typeof target === "string") {
    if (typeof document === "undefined") {
      throw new Error("Selector targets require a browser document.");
    }
    return Array.from(document.querySelectorAll(target));
  }

  if (isElement(target)) {
    return [target];
  }

  if (Array.isArray(target)) {
    return validateElementCollection(target);
  }

  if (isCollectionLike(target)) {
    return validateElementCollection(Array.from(target));
  }

  throw new TypeError(
    "Target must be an HTMLElement, selector string, NodeList, or array of elements."
  );
}

function validateElementCollection(collection) {
  if (collection.some((item) => !isElement(item))) {
    throw new TypeError("Target collection contains a non-element value.");
  }
  return collection;
}

function looksLikeGesturePayload(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.type === "string" &&
      "target" in value &&
      "controller" in value
  );
}

function resolveGroupControllerTarget(group, value) {
  if (looksLikeGesturePayload(value)) {
    return value.controller;
  }

  if (value instanceof Controller) {
    return group._byTarget.get(value.target) === value ? value : undefined;
  }

  if (typeof value === "number" || isElement(value)) {
    return group.get(value);
  }

  return undefined;
}

function shouldManageTransform(controller, options) {
  return resolveAutoOption(
    options.transform,
    Boolean(
      controller._panFeature ||
        controller._rotateFeature ||
        controller._zoomFeature
    )
  );
}

function shouldManageCursor(controller, options) {
  return resolveAutoOption(
    options.cursor,
    Boolean(controller._dragFeature || controller._panFeature)
  );
}

function shouldManageTouchAction(controller, options) {
  return resolveAutoOption(
    options.touchAction,
    Boolean(
      controller._dragFeature ||
        controller._panFeature ||
        controller._rotateFeature ||
        controller._zoomFeature
    )
  );
}

function shouldManageUVTouchAction(controller) {
  return Boolean(
    controller._dragFeature ||
      controller._panFeature ||
      controller._rotateFeature ||
      controller._zoomFeature
  );
}

function resolveAutoOption(value, autoResult) {
  if (value === true) {
    return true;
  }
  if (value === "auto") {
    return autoResult;
  }
  return false;
}

function hasAttribute(target, name) {
  if (typeof target.hasAttribute === "function") {
    return target.hasAttribute(name);
  }
  return Boolean(target._paGestureAttrs?.has(name));
}

function getAttribute(target, name) {
  if (typeof target.getAttribute === "function") {
    return target.getAttribute(name);
  }
  return target._paGestureAttrs?.get(name) ?? null;
}

function setAttribute(target, name, value) {
  if (typeof target.setAttribute === "function") {
    target.setAttribute(name, value);
    return;
  }
  if (!target._paGestureAttrs) {
    target._paGestureAttrs = new Map();
  }
  target._paGestureAttrs.set(name, value);
}

function removeAttribute(target, name) {
  if (typeof target.removeAttribute === "function") {
    target.removeAttribute(name);
    return;
  }
  target._paGestureAttrs?.delete(name);
}

function isCollectionLike(value) {
  if (!value || typeof value === "string") {
    return false;
  }
  if (typeof value[Symbol.iterator] === "function") {
    return true;
  }
  return typeof value.length === "number" && typeof value.item === "function";
}

function isElement(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      value.nodeType === 1 &&
      typeof value.nodeName === "string" &&
      typeof value.addEventListener === "function"
  );
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function ensureNotDestroyed(controller) {
  if (controller._destroyed) {
    throw new Error("This controller has already been destroyed.");
  }
}

function getWindow(target) {
  return target?.ownerDocument?.defaultView || globalThis.window || globalThis;
}

function requestFrame(callback, scope) {
  if (typeof scope.requestAnimationFrame === "function") {
    return scope.requestAnimationFrame(callback);
  }
  return scope.setTimeout(callback, 16);
}

function cancelFrame(id, scope) {
  if (typeof scope.cancelAnimationFrame === "function") {
    scope.cancelAnimationFrame(id);
    return;
  }
  scope.clearTimeout(id);
}
