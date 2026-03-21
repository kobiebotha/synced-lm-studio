import "dotenv/config";
import { createBridgeDatabase } from "./powersync";
import { BridgeService } from "./bridge";

async function main() {
  const { db, ownerUserId } = await createBridgeDatabase();
  const service = new BridgeService(db, ownerUserId);
  await service.start();

  const stop = async () => {
    await service.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void stop();
  });
  process.on("SIGTERM", () => {
    void stop();
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
