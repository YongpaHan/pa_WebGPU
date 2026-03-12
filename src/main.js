import "./style.css";
import "reset-css";

import { createCanvas } from "./webgpu/utils/canvas";
import { runSketch } from "./sketches/0_plain/sketch";

const canvas = createCanvas();

await runSketch({ canvas });
