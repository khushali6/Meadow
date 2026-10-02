import { createRelay } from "./relay";

const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
  console.error("Set TELEGRAM_BOT_TOKEN to the token of the bot you created with @BotFather.");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
const relay = createRelay({ botToken, dataFile: process.env.RELAY_DATA ?? "./relay-data/devices.json" });

relay
  .start()
  .then(bot => {
    relay.server.listen(port, host, () => console.log(`[relay] @${bot.username} relay listening on ${host}:${port}. Serve it over HTTPS and set MEADOW_RELAY_URL (or HOSTED_RELAY_URL) to its public URL.`));
  })
  .catch(error => {
    console.error(`[relay] ${(error as Error).message}`);
    process.exit(1);
  });

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  relay.stop();
  process.exit(0);
});
