import { makeStructuredView } from "webgpu-utils";

export class UniformBlock {
  constructor({
    device,
    label = "UniformBlock",
    group = 1,
    binding = 0,
    visibility = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
    structDef = null,
    initialValues = null,
    usage = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  } = {}) {
    if (!device) throw new Error("UniformBlock: device가 필요합니다.");
    this.device = device;
    this.label = label;
    this.group = group;
    this.binding = binding;

    this.visibility = visibility;
    this.usage = usage;

    this.structDef = structDef;
    if (!this.structDef)
      throw new Error("UniformBlock: structDef가 필요합니다.");
    this.view = makeStructuredView(structDef);

    this.buffer = this.device.createBuffer({
      label: `${this.label}.buffer`,
      size: this.view.arrayBuffer.byteLength,
      usage: this.usage,
    });

    this.bindGroupLayout = null;
    this.bindGroup = null;

    this.dirty = false;
    this.destroyed = false;

    if (initialValues) {
      this.set(initialValues);
      this.upload(true);
    }
  }

  set(values) {
    if (this.destroyed) return;
    this.view.set(values);
    this.dirty = true;
  }
  upload(force = false) {
    if (this.destroyed) return;
    if (!force && !this.dirty) return;

    this.device.queue.writeBuffer(this.buffer, 0, this.view.arrayBuffer);
    this.dirty = false;
  }

  getLayoutEntry() {
    return {
      binding: this.binding,
      visibility: this.visibility,
      buffer: {},
    };
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
      throw new Error("UniformBlock: bindGroupLayout이 필요합니다.");
    }
    this.bindGroup = this.device.createBindGroup({
      label: `${this.label}.bg`,
      layout,
      entries: [{ binding: this.binding, resource: { buffer: this.buffer } }],
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
      throw new Error("UniformBlock: bindGroup이 아직 생성되지 않았습니다.");
    }
    passEncoder.setBindGroup(this.group, this.bindGroup);
  }
  destroy() {
    if (this.destroyed) return;
    this.buffer?.destroy?.();

    this.structDef = null;
    this.view = null;
    this.buffer = null;
    this.bindGroupLayout = null;
    this.bindGroup = null;
    this.dirty = false;
    this.destroyed = true;
  }
}
