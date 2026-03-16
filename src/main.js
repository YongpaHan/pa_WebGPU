import "./style.css";
import "reset-css";

import { createCanvas } from "./webgpu/utils/canvas";
import { runSketch } from "./sketches/260313/sketch";

const canvas = createCanvas();

await runSketch({ canvas });
