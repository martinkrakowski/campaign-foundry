import { probeFfmpeg, recordFfmpegProbe } from "../lib/capabilities.js";

export default defineNitroPlugin(async () => {
  recordFfmpegProbe(await probeFfmpeg());
});
