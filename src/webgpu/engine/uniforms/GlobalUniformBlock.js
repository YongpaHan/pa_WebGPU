import { makeShaderDataDefinitions } from "webgpu-utils";
import { UniformBlock } from "./UniformBlock";
import { globalUniformWgsl } from "../../shaders/global/globalUniform.wgsl";

export class GlobalUniformBlock {
  constructor({ device } = {}) {
    if (!device) throw new Error("GlobalUniformBlock: device가 필요합니다.");

    const defs = makeShaderDataDefinitions(globalUniformWgsl);
    const structDef = defs.uniforms?.global;
    if (!structDef)
      throw new Error("GlobalUniformBlock: uniforms.global이 필요합니다.");

    this.block = new UniformBlock({
      device: device,
      label: "GlobalUniform",
      group: 0,
      binding: 0,
      visibility:
        GPUShaderStage.VERTEX |
        GPUShaderStage.FRAGMENT |
        GPUShaderStage.COMPUTE,
      structDef,
    });

    this.values = {
      resolution: [1, 1],
      time: 0,
      deltaTime: 0,
      gestureTransform: [0, 0, 1, 0],
      gestureState: [0, 0, 0, 0],
      touches: [
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
    };

    this.block.createBindGroupLayout();
    this.block.createBindGroup();
  }

  setUniforms(values = {}) {
    this.values = { ...this.values, ...values };
    this.block.set(this.values);
  }

  upload(force = false) {
    this.block.upload(force);
  }

  getBindGroupLayout() {
    return this.block?.getBindGroupLayout?.() || null;
  }

  bind(passEncoder) {
    this.block?.bind?.(passEncoder);
  }

  get bindGroup() {
    return this.block.bindGroup;
  }

  destroy() {
    this.block?.destroy?.();
    this.block = null;
  }
}
