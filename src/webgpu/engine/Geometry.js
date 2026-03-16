const formatTable = {
  // 8-bit Formats
  uint8x2: { byteSize: 2, components: 2, wgsl: "vec2<u32>" },
  uint8x4: { byteSize: 4, components: 4, wgsl: "vec4<u32>" },
  sint8x2: { byteSize: 2, components: 2, wgsl: "vec2<i32>" },
  sint8x4: { byteSize: 4, components: 4, wgsl: "vec4<i32>" },
  unorm8x2: { byteSize: 2, components: 2, wgsl: "vec2<f32>" },
  unorm8x4: { byteSize: 4, components: 4, wgsl: "vec4<f32>" },
  snorm8x2: { byteSize: 2, components: 2, wgsl: "vec2<f32>" },
  snorm8x4: { byteSize: 4, components: 4, wgsl: "vec4<f32>" },
  // 16-bit Formats
  uint16x2: { byteSize: 4, components: 2, wgsl: "vec2<u32>" },
  uint16x4: { byteSize: 8, components: 4, wgsl: "vec4<u32>" },
  sint16x2: { byteSize: 4, components: 2, wgsl: "vec2<i32>" },
  sint16x4: { byteSize: 8, components: 4, wgsl: "vec4<i32>" },
  unorm16x2: { byteSize: 4, components: 2, wgsl: "vec2<f32>" },
  unorm16x4: { byteSize: 8, components: 4, wgsl: "vec4<f32>" },
  snorm16x2: { byteSize: 4, components: 2, wgsl: "vec2<f32>" },
  snorm16x4: { byteSize: 8, components: 4, wgsl: "vec4<f32>" },
  float16x2: { byteSize: 4, components: 2, wgsl: "vec2<f16>" },
  float16x4: { byteSize: 8, components: 4, wgsl: "vec4<f16>" },
  // 32-bit Formats
  float32: { byteSize: 4, components: 1, wgsl: "f32" },
  float32x2: { byteSize: 8, components: 2, wgsl: "vec2<f32>" },
  float32x3: { byteSize: 12, components: 3, wgsl: "vec3<f32>" },
  float32x4: { byteSize: 16, components: 4, wgsl: "vec4<f32>" },
  uint32: { byteSize: 4, components: 1, wgsl: "u32" },
  uint32x2: { byteSize: 8, components: 2, wgsl: "vec2<u32>" },
  uint32x3: { byteSize: 12, components: 3, wgsl: "vec3<u32>" },
  uint32x4: { byteSize: 16, components: 4, wgsl: "vec4<u32>" },
  sint32: { byteSize: 4, components: 1, wgsl: "i32" },
  sint32x2: { byteSize: 8, components: 2, wgsl: "vec2<i32>" },
  sint32x3: { byteSize: 12, components: 3, wgsl: "vec3<i32>" },
  sint32x4: { byteSize: 16, components: 4, wgsl: "vec4<i32>" },
};

export class Geometry {
  constructor({
    device,
    topology = "triangle-list",
    attributes = [],
    index = null,
    count = null,
    instanceCount = 1,
    spaceMode = "clip", // "clip" | "pixel"
  } = {}) {
    this.device = device;
    this.topology = topology;
    this.spaceMode = spaceMode;

    // Internal storage uses contiguous slots even when external slot ids are sparse.
    this.buffers = []; // internal slot indexed
    this.layouts = []; // internal slot indexed
    this.indexBuffer = null;
    this.slotToInternal = new Map(); // external slot -> internal slot
    this.attributeDefs = new Map(); // external slot -> descriptor
    this.vertexCountSourceSlot = null;

    this.vertexCount = count ?? 0;
    this.instanceCount = instanceCount;

    if (index) this.setIndex(index);
    if (attributes.length) this.setAttributes(attributes);
  }

  setAttributes(attrs) {
    if (!this.device) throw new Error("Geometry: device가 필요합니다.");
    if (!Array.isArray(attrs))
      throw new Error("Geometry: attrs는 배열이어야 합니다.");

    const normalized = this._normalizeAttributeDescriptors(attrs);
    this.attributeDefs.clear();
    for (const desc of normalized) {
      this.attributeDefs.set(desc.slot, desc);
    }

    this._rebuildVertexResources();
    return this;
  }

  setVertexData({
    slot = 0,
    data,
    attributes,
    arrayStride,
    stepMode = "vertex",
  } = {}) {
    return this._upsertAttributeDescriptor({
      slot,
      data,
      attributes,
      arrayStride,
      stepMode,
    });
  }

  setInstanceData({
    slot = 1,
    data,
    attributes,
    arrayStride,
    stepMode = "instance",
  } = {}) {
    return this._upsertAttributeDescriptor({
      slot,
      data,
      attributes,
      arrayStride,
      stepMode,
    });
  }

  updateVertexData(data, slot = 0) {
    const desc = this.attributeDefs.get(slot);
    if (!desc) return;
    if (desc.stepMode === "instance") {
      throw new Error(`slot(${slot})은 instance 데이터입니다.`);
    }

    if (!ArrayBuffer.isView(data)) {
      throw new Error(
        "Geometry.updateVertexData: data는 TypedArray여야 합니다."
      );
    }

    const internalSlot = this.slotToInternal.has(slot)
      ? this.slotToInternal.get(slot)
      : slot;
    const target = this.buffers[internalSlot];
    if (!target) return;

    target.data = data;
    desc.data = data;

    const nextVertexCount = data.byteLength / target.stride;
    if (!Number.isInteger(nextVertexCount)) {
      throw new Error(
        `Geometry.updateVertexData: slot(${slot}) 데이터 길이가 stride(${target.stride})와 맞지 않습니다.`
      );
    }

    if (data.byteLength > target.buffer.size) {
      target.buffer.destroy();
      target.buffer = this.device.createBuffer({
        label: `VertexBuffer(ext:${target.userSlot}, int:${target.slot})`,
        size: data.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }

    this.device.queue.writeBuffer(target.buffer, 0, target.data);

    if (!this.indexBuffer && target.userSlot === this.vertexCountSourceSlot) {
      this.vertexCount = nextVertexCount;
    }

    return this;
  }

  updateInstanceData(data, slot = 1) {
    const desc = this.attributeDefs.get(slot);
    if (!desc) return;
    if (desc.stepMode !== "instance") {
      throw new Error(`slot(${slot})은 vertex 데이터입니다.`);
    }

    if (!ArrayBuffer.isView(data)) {
      throw new Error(
        "Geometry.updateInstanceData: data는 TypedArray여야 합니다."
      );
    }

    const internalSlot = this.slotToInternal.has(slot)
      ? this.slotToInternal.get(slot)
      : slot;
    const target = this.buffers[internalSlot];
    if (!target) return;

    target.data = data;
    desc.data = data;

    const nextInstanceCount = data.byteLength / target.stride;
    if (!Number.isInteger(nextInstanceCount)) {
      throw new Error(
        `Geometry.updateInstanceData: slot(${slot}) 데이터 길이가 stride(${target.stride})와 맞지 않습니다.`
      );
    }

    if (data.byteLength > target.buffer.size) {
      target.buffer.destroy();
      target.buffer = this.device.createBuffer({
        label: `VertexBuffer(ext:${target.userSlot}, int:${target.slot})`,
        size: data.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }

    this.device.queue.writeBuffer(target.buffer, 0, target.data);
    this.instanceCount = nextInstanceCount;

    return this;
  }

  _cloneDescriptor(desc) {
    return {
      slot: desc.slot,
      stepMode: desc.stepMode,
      data: desc.data,
      arrayStride: desc.arrayStride,
      attributes: desc.attributes.map((a) => ({
        location: a.location,
        format: a.format,
        offset: a.offset,
      })),
    };
  }

  _getAttributeDescriptorList() {
    return Array.from(this.attributeDefs.values()).map((d) =>
      this._cloneDescriptor(d)
    );
  }

  _upsertAttributeDescriptor(desc) {
    const next = this._getAttributeDescriptorList();
    const targetSlot = Number.isInteger(desc.slot) ? desc.slot : 0;
    const index = next.findIndex((d) => d.slot === targetSlot);
    const item = {
      slot: targetSlot,
      stepMode: desc.stepMode || "vertex",
      data: desc.data,
      arrayStride: desc.arrayStride,
      attributes: desc.attributes,
    };

    if (index === -1) next.push(item);
    else next[index] = item;

    return this.setAttributes(next);
  }

  _normalizeAttributeDescriptors(attrs) {
    const normalized = [];
    const seenSlots = new Set();

    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i];
      if (!a || typeof a !== "object") {
        throw new Error(`Geometry: attrs[${i}]는 객체여야 합니다.`);
      }
      if (!ArrayBuffer.isView(a.data)) {
        throw new Error(`Geometry: attrs[${i}].data는 TypedArray여야 합니다.`);
      }
      if (!Array.isArray(a.attributes) || a.attributes.length === 0) {
        throw new Error(`Geometry: attrs[${i}].attributes가 필요합니다.`);
      }

      const slot = Number.isInteger(a.slot) ? a.slot : i;
      if (slot < 0) {
        throw new Error(
          `Geometry: attrs[${i}].slot은 0 이상의 정수여야 합니다.`
        );
      }
      if (seenSlots.has(slot)) {
        throw new Error(`Geometry: slot(${slot})이 중복되었습니다.`);
      }
      seenSlots.add(slot);

      normalized.push({
        slot,
        stepMode: a.stepMode || "vertex",
        data: a.data,
        arrayStride: a.arrayStride,
        attributes: a.attributes.map((attr) => ({
          location: attr.location,
          format: attr.format,
          offset: attr.offset,
        })),
      });
    }

    return normalized;
  }

  _clearVertexResources() {
    for (const entry of this.buffers) {
      entry?.buffer?.destroy?.();
    }
    this.buffers = [];
    this.layouts = [];
    this.slotToInternal.clear();
    this.vertexCountSourceSlot = null;
  }

  _rebuildVertexResources() {
    this._clearVertexResources();

    const defs = this._getAttributeDescriptorList().sort(
      (a, b) => a.slot - b.slot
    );
    let resolvedInstanceCount = null;
    let firstVertexCount = null;
    let firstVertexSlot = null;

    for (let internalSlot = 0; internalSlot < defs.length; internalSlot++) {
      const def = defs[internalSlot];
      const parsedAttrs = this._parseAttributes(def.attributes);
      const stride = def.arrayStride ?? parsedAttrs.autoStride;
      if (!Number.isFinite(stride) || stride <= 0) {
        throw new Error(
          `Geometry: slot(${def.slot})의 stride가 잘못되었습니다.`
        );
      }

      const buffer = this.device.createBuffer({
        label: `VertexBuffer(ext:${def.slot}, int:${internalSlot})`,
        size: def.data.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(buffer, 0, def.data);

      this.buffers[internalSlot] = {
        slot: internalSlot,
        userSlot: def.slot,
        stepMode: def.stepMode,
        stride,
        data: def.data,
        buffer,
      };
      this.layouts[internalSlot] = {
        arrayStride: stride,
        stepMode: def.stepMode,
        attributes: parsedAttrs.attrs,
      };
      this.slotToInternal.set(def.slot, internalSlot);

      const count = def.data.byteLength / stride;
      if (!Number.isInteger(count)) {
        throw new Error(
          `Geometry: slot(${def.slot}) 데이터 길이가 stride(${stride})와 맞지 않습니다.`
        );
      }
      if (def.stepMode === "instance") {
        if (resolvedInstanceCount === null) {
          resolvedInstanceCount = count;
        } else if (resolvedInstanceCount !== count) {
          throw new Error(
            `Geometry: instance 버퍼 개수가 일치해야 합니다. (slot ${def.slot})`
          );
        }
      } else if (firstVertexCount === null) {
        firstVertexCount = count;
        firstVertexSlot = def.slot;
      }
    }

    this.instanceCount = resolvedInstanceCount ?? 1;
    if (!this.indexBuffer && firstVertexCount !== null) {
      this.vertexCount = firstVertexCount;
      this.vertexCountSourceSlot = firstVertexSlot;
    } else if (!this.indexBuffer) {
      this.vertexCount = 0;
    }
  }

  _parseAttributes(attrs) {
    let currentOffset = 0;
    const parsedAttributes = [];

    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i];
      const formatInfo = formatTable[a.format];
      if (!formatInfo) {
        throw new Error("지원하지 않는 vertex format입니다.");
      }

      let actualOffset = a.offset ?? currentOffset;

      parsedAttributes.push({
        shaderLocation: a.location,
        format: a.format,
        offset: actualOffset,
      });
      const byteSize = formatInfo.byteSize;
      currentOffset = actualOffset + byteSize;
    }
    return {
      autoStride: currentOffset,
      attrs: parsedAttributes,
    };
  }

  setIndex(index) {
    const raw = index;
    let typed;
    if (raw instanceof Uint16Array || raw instanceof Uint32Array) {
      typed = raw;
    } else if (Array.isArray(raw)) {
      const max = Math.max(...raw);
      typed = max > 65535 ? new Uint32Array(raw) : new Uint16Array(raw);
    } else {
      throw new Error("index는 배열 또는 Uint16Array/Uint32Array여야 합니다.");
    }
    const indexFormat = typed instanceof Uint16Array ? "uint16" : "uint32";

    this.indexBuffer?.buffer?.destroy?.();

    const buffer = this.device.createBuffer({
      label: `IndexBuffer`,
      size: typed.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buffer, 0, typed);

    this.indexBuffer = { buffer, format: indexFormat, count: typed.length };
    return this;
  }

  setVertexCount(count) {
    this.vertexCount = count;
    return this;
  }
  setInstanceCount(count) {
    this.instanceCount = count;
    return this;
  }

  getVBL() {
    return this.layouts;
  }
  bind(passEncoder) {
    for (const e of this.buffers) {
      if (!e) continue;
      passEncoder.setVertexBuffer(e.slot, e.buffer);
    }
    if (this.indexBuffer) {
      passEncoder.setIndexBuffer(
        this.indexBuffer.buffer,
        this.indexBuffer.format
      );
    }
  }
  draw(passEncoder) {
    if (this.indexBuffer) {
      passEncoder.drawIndexed(
        this.indexBuffer.count, // indexCount
        this.instanceCount, // instanceCount
        0, // firstIndex
        0, // baseVertex
        0 // firstInstance
      );
      return;
    }
    passEncoder.draw(
      this.vertexCount,
      this.instanceCount,
      0, // firstVertex
      0 // firstInstance
    );
  }

  destroy() {
    this._clearVertexResources();

    this.indexBuffer?.buffer?.destroy?.();
    this.indexBuffer = null;

    this.attributeDefs.clear();
    this.vertexCount = 0;
    this.instanceCount = 1;
  }
}
