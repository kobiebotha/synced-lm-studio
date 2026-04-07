import "dotenv/config";
import { createBridgeDatabase } from "./powersync";
import { BridgeService } from "./bridge";
import { bridgeConfig } from "./config";
import { acquireSingleInstanceLock } from "./lock";

let service: BridgeService | null = null;
let releaseLock: (() => Promise<void>) | null = null;

async function shutdown(exitCode: number) {
  try {
    if (service) {
      await service.stop();
      service = null;
    }
  } finally {
    if (releaseLock) {
      await releaseLock();
      releaseLock = null;
    }
  }

  process.exit(exitCode);
}

async function main() {
  releaseLock = await acquireSingleInstanceLock(bridgeConfig.bridgeDbFilename);
  const { db, ownerUserId } = await createBridgeDatabase();
  service = new BridgeService(db, ownerUserId);
  await service.start();
}

process.on("SIGINT", () => {
  void shutdown(0);
});
process.on("SIGTERM", () => {
  void shutdown(0);
});

main().catch((error) => {
  console.error(error);
  void shutdown(1);
});
