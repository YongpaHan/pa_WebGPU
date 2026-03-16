import { Renderer } from "@/webgpu/engine/Renderer";
import { createGesture } from "@/webgpu/utils/gesture";
import { createTimer } from "@/webgpu/utils/timer";
import { createPass } from "./passes/pass";
import { shader } from "./shaders/shader";

export async function runSketch({ canvas }) {
  const timer = createTimer();
  const gesture = createGesture(canvas, {
    doubleClick: {
      reset: {
        // only: ["rotate", "zoom"],
      },
    },
  });
  const renderer = new Renderer({ canvas });
  const { pass } = createPass({ shader });

  let time = 0;
  let dt = 0;

  async function main() {
    await renderer.init();
    await renderer.createTexture("test_tex", {
      source: "fonts/pa_Regular/pa_Regular.png",
    });

    renderer.addPass(pass);
    animate();
  }

  function update() {
    dt = timer.tick();
    time += dt;
    renderer.setGlobalUniforms(gesture.uniforms);
  }

  function animate() {
    update();

    renderer.renderFrame(time, dt);
    requestAnimationFrame(animate);
  }

  await main();
}
