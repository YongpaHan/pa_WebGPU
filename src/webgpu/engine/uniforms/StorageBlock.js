import { makeStructuredView } from "webgpu-utils";

function cloneArrayBuffer(data) {
  if (data instanceof ArrayBuffer) {
    return data.slice(0);
  }
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  throw new Error(
    "StorageBlock: data는 ArrayBuffer 또는 TypedArray여야 합니다."
  );
}

function createBackingStore({ structDef, arrayBuffer = null, byteLength = null }) {
  if (structDef) {
    if (arrayBuffer) {
      const view = makeStructuredView(structDef, arrayBuffer);
      return {
        view,
        arrayBuffer: view.arrayBuffer,
      };
    }

    if (Number.isFinite(byteLength) && byteLength > 0) {
      const minSize = Number.isFinite(structDef.size) ? structDef.size : 0;
      if (byteLength < minSize) {
        throw new Error(
          `StorageBlock: byteLength(${byteLength})는 struct 최소 크기(${minSize})보다 작을 수 없습니다.`
        );
      }

      const view = makeStructuredView(structDef, new ArrayBuffer(byteLength));
      return {
        view,
        arrayBuffer: view.arrayBuffer,
      };
    }

    const view = makeStructuredView(structDef);
    return {
      view,
      arrayBuffer: view.arrayBuffer,
    };
  }

  if (arrayBuffer) {
    return {
      view: null,
      arrayBuffer,
    };
  }

  if (Number.isFinite(byteLength) && byteLength > 0) {
    return {
      view: null,
      arrayBuffer: new ArrayBuffer(Math.floor(byteLength)),
    };
  }

  throw new Error(
    "StorageBlock: structDef, arrayBuffer, byteLength 중 하나가 필요합니다."
  );
}

export class StorageBlock {
  constructor({
    device,
    name = null,
    label = "StorageBlock",
    group = 1,
    binding = 0,
    visibility =
      GPUShaderStage.VERTEX |
      GPUShaderStage.FRAGMENT |
      GPUShaderStage.COMPUTE,
    structDef = null,
    initialValues = null,
    initialData = null,
    arrayBuffer = null,
    byteLength = null,
    bufferType = "read-only-storage",
    usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  } = {}) {
    if (!device) throw new Error("StorageBlock: device가 필요합니다.");

    this.device = device;
    this.name = name ?? label;
    this.label = label;
    this.group = group;
    this.binding = binding;
    this.visibility = visibility;
    this.structDef = structDef;
    this.bufferType = bufferType;
    this.usage = usage;

    this.view = null;
    this.arrayBuffer = null;
    this.buffer = null;
    this.bindGroupLayout = null;
    this.bindGroup = null;

    this.dirty = false;
    this.destroyed = false;
    this.bindingVersion = 0;

    this._setBackingStore(
      createBackingStore({
        structDef: this.structDef,
        arrayBuffer,
        byteLength,
      })
    );

    if (initialData != null) {
      this.setData(initialData);
      this.upload(true);
    } else if (initialValues) {
      this.set(initialValues);
      this.upload(true);
    }
  }

  _createBuffer(size) {
    return this.device.createBuffer({
      label: `${this.label}.buffer`,
      size,
      usage: this.usage,
    });
  }

  _setBackingStore({ view = null, arrayBuffer }) {
    if (!(arrayBuffer instanceof ArrayBuffer)) {
      throw new Error("StorageBlock: 유효한 ArrayBuffer가 필요합니다.");
    }

    const nextSize = arrayBuffer.byteLength;
    if (!Number.isFinite(nextSize) || nextSize <= 0) {
      throw new Error("StorageBlock: 버퍼 크기는 0보다 커야 합니다.");
    }

    const needsRecreate = !this.buffer || this.buffer.size !== nextSize;
    if (needsRecreate) {
      this.buffer?.destroy?.();
      this.buffer = this._createBuffer(nextSize);
      this.bindingVersion += 1;
    }

    this.view = view;
    this.arrayBuffer = arrayBuffer;
    this.dirty = true;
  }

  set(values) {
    if (this.destroyed) return;
    if (!this.view) {
      throw new Error(
        "StorageBlock.set: structDef 기반 블록에서만 set(values)을 사용할 수 있습니다."
      );
    }
    this.view.set(values);
    this.dirty = true;
  }

  setData(data) {
    if (this.destroyed) return;

    const nextArrayBuffer = cloneArrayBuffer(data);
    const nextView = this.structDef
      ? makeStructuredView(this.structDef, nextArrayBuffer)
      : null;

    this._setBackingStore({
      view: nextView,
      arrayBuffer: nextView?.arrayBuffer ?? nextArrayBuffer,
    });
  }

  resize(byteLength, { preserveData = true } = {}) {
    if (this.destroyed) return false;

    const nextSize = Math.floor(byteLength);
    if (!Number.isFinite(nextSize) || nextSize <= 0) {
      throw new Error("StorageBlock.resize: byteLength는 0보다 커야 합니다.");
    }

    if (this.structDef && Number.isFinite(this.structDef.size)) {
      if (nextSize < this.structDef.size) {
        throw new Error(
          `StorageBlock.resize: byteLength(${nextSize})는 struct 최소 크기(${this.structDef.size})보다 작을 수 없습니다.`
        );
      }
    }

    if (this.arrayBuffer && this.arrayBuffer.byteLength === nextSize) {
      return false;
    }

    const nextArrayBuffer = new ArrayBuffer(nextSize);
    if (preserveData && this.arrayBuffer) {
      const prev = new Uint8Array(this.arrayBuffer);
      const next = new Uint8Array(nextArrayBuffer);
      next.set(prev.subarray(0, Math.min(prev.byteLength, next.byteLength)));
    }

    const nextView = this.structDef
      ? makeStructuredView(this.structDef, nextArrayBuffer)
      : null;

    this._setBackingStore({
      view: nextView,
      arrayBuffer: nextView?.arrayBuffer ?? nextArrayBuffer,
    });

    return true;
  }

  upload(force = false) {
    if (this.destroyed) return;
    if (!force && !this.dirty) return;

    this.device.queue.writeBuffer(this.buffer, 0, this.arrayBuffer);
    this.dirty = false;
  }

  getLayoutEntry() {
    return {
      binding: this.binding,
      visibility: this.visibility,
      buffer: {
        type: this.bufferType,
      },
    };
  }

  getBindResource() {
    return {
      buffer: this.buffer,
    };
  }

  getBindingKey() {
    return `${this.bindingVersion}:${this.buffer?.size ?? 0}`;
  }

  createBindGroupLayout() {
    if (this.destroyed) return null;
    this.bindGroupLayout = this.device.createBindGroupLayout({
      label: `${this.label}.bindGroupLayout`,
      entries: [this.getLayoutEntry()],
    });
    return this.bindGroupLayout;
  }

  createBindGroup(layout = this.bindGroupLayout) {
    if (this.destroyed) return null;
    if (!layout) {
      throw new Error("StorageBlock: bindGroupLayout이 필요합니다.");
    }

    this.bindGroup = this.device.createBindGroup({
      label: `${this.label}.bg`,
      layout,
      entries: [
        {
          binding: this.binding,
          resource: this.getBindResource(),
        },
      ],
    });
    return this.bindGroup;
  }

  getBindGroupLayout() {
    return this.bindGroupLayout;
  }

  getBindGroup() {
    return this.bindGroup;
  }

  bind(passEncoder) {
    if (!this.bindGroup) {
      throw new Error("StorageBlock: bindGroup이 아직 생성되지 않았습니다.");
    }
    passEncoder.setBindGroup(this.group, this.bindGroup);
  }

  destroy() {
    if (this.destroyed) return;

    this.buffer?.destroy?.();

    this.view = null;
    this.arrayBuffer = null;
    this.buffer = null;
    this.bindGroupLayout = null;
    this.bindGroup = null;
    this.dirty = false;
    this.destroyed = true;
  }
}
