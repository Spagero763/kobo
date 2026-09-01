import { config } from "./config.js";
import { createApp } from "./app.js";

createApp().listen(config.port, () => {
  console.log(`kobo on :${config.port}`);
  console.log(`wallet ${config.agentAddress}`);
  console.log(`tag    ${config.attributionTag || "(not set)"}`);
});
