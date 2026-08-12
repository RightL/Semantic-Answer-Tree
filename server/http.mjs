import { createSemanticAnswerHttpService, DEFAULT_HTTP_HOST, resolveHttpPort } from "./http-server.mjs";

const port = resolveHttpPort();
const service = createSemanticAnswerHttpService({ port });
let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await service.stop();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

service
  .start()
  .then(() => {
    console.error(`Semantic Answer service listening at http://${DEFAULT_HTTP_HOST}:${port}`);
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : "Semantic Answer service failed to start.");
    await shutdown().catch(() => {});
    process.exitCode = 1;
  });
