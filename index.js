import { Cli, Bridge, AppServiceRegistration } from "matrix-appservice-bridge";
import { createRestAPIClient } from "masto";
import { htmlToText } from "html-to-text";
import fs from "fs";
import yaml from "js-yaml";

// Load config with logging
let config;
try {
  config = yaml.load(fs.readFileSync("config.yaml", "utf8"));
  console.log("Configuration loaded successfully:", config);
} catch (err) {
  console.error("Failed to load configuration:", err);
  process.exit(1);
}

if (!config || !config.matrix || !config.mastodon) {
  console.error(
    "Invalid configuration structure. 'matrix' or 'mastodon' section is missing.",
  );
  process.exit(1);
}

// Set up Mastodon client
const mastodonClient = createRestAPIClient({
  url: config.mastodon.apiUrl,
  accessToken: config.mastodon.accessToken,
});

let bridge;

new Cli({
  registrationPath: "mastodon-registration.yaml",
  generateRegistration: function (reg, callback) {
    reg.setId(AppServiceRegistration.generateToken());
    reg.setHomeserverToken(AppServiceRegistration.generateToken());
    reg.setAppServiceToken(AppServiceRegistration.generateToken());
    reg.setSenderLocalpart("mastobot");
    reg.addRegexPattern("users", "@masto_.*", true);
    callback(reg);
  },
  run: function (port) {
    bridge = new Bridge({
      homeserverUrl: config.matrix.homeserverUrl,
      domain: config.matrix.domain,
      registration: "mastodon-registration.yaml",
      controller: {
        onUserQuery: function (queriedUser) {
          console.log(`onUserQuery: ${queriedUser}`);
          return {}; // auto-provision users with no additional data
        },
        onEvent: async function (request, context) {
          console.log("Received event:", request.getData());
          const event = request.getData();
          if (
            event.type !== "m.room.message" ||
            !event.content ||
            event.room_id !== config.matrix.roomId
          ) {
            return;
          }

          const body = event.content.body;
          console.log("Body content:", body);

          const postCmd = "!masto post ";
          if (body.startsWith(postCmd)) {
            const status = body.substring(postCmd.length).trim();
            try {
              const response = await mastodonClient.v1.statuses.create({
                status: status,
              });
              console.log("Posted to Mastodon:", response.url);
              bridge
                .getIntent(config.matrix.botUserId)
                .sendText(event.room_id, `Posted to Mastodon: ${response.url}`);
            } catch (error) {
              console.log("Error posting to Mastodon:", error);
              bridge
                .getIntent(config.matrix.botUserId)
                .sendText(
                  event.room_id,
                  `Error posting to Mastodon: ${error.message}`,
                );
            }
          } else if (body === "!masto help") {
            bridge
              .getIntent(config.matrix.botUserId)
              .sendText(
                event.room_id,
                "To post a status on Mastodon, use the following format:\n\n!post Your status text here.",
              );
          } else {
            bridge
              .getIntent(config.matrix.botUserId)
              .sendText(event.room_id, "Use `!masto help` for more info");
          }
        },
      },
    });

    bridge
      .run(port)
      .then(async () => {
        console.log("Matrix-side listening on port %s", port);

        try {
          console.log(
            `Ensuring bot user ${config.matrix.botUserId} is registered...`,
          );
          await bridge.getIntent(config.matrix.botUserId).ensureRegistered();
          console.log(`Bot ${config.matrix.botUserId} has been registered.`);

          try {
            console.log(`Attempting to join room ${config.matrix.roomId}...`);
            await bridge
              .getIntent(config.matrix.botUserId)
              .join(config.matrix.roomId);
            console.log(
              `Bot ${config.matrix.botUserId} has joined the room ${config.matrix.roomId}`,
            );
            await bridge
              .getIntent(config.matrix.botUserId)
              .sendText(
                config.matrix.roomId,
                "Hello! The bridge is now up and running.",
              );
            console.log("Greeting message sent to the room.");
          } catch (err) {
            console.error(`Failed to join room: ${err.message}`);
          }
        } catch (err) {
          console.error(`Failed to register bot: ${err.message}`);
        }

        // Start fetching Mastodon notifications
        setInterval(fetchAndSendNotifications, 1000);
      })
      .catch((err) => {
        console.error(`Failed to initialize the bridge: ${err.message}`);
        console.error(err);
      });
  },
}).run();

async function fetchAndSendNotifications() {
  try {
    const notifications = await mastodonClient.v1.notifications.list();
    if (notifications.length === 0) {
      await bridge
        .getIntent(config.matrix.botUserId)
        .sendText(config.matrix.roomId, "No new notifications.");
    } else {
      const messages = notifications
        .map((n) => {
          const content = n.status
            ? htmlToText(n.status.content, { wordwrap: 130 })
            : "";
          return `${n.type} from ${n.account.username}: ${content}`;
        })
        .join("\n\n");
      await bridge
        .getIntent(config.matrix.botUserId)
        .sendText(config.matrix.roomId, messages);
    }
    console.log("Notifications fetched and sent to Matrix.");
  } catch (error) {
    console.log("Error fetching notifications:", error);
    await bridge
      .getIntent(config.matrix.botUserId)
      .sendText(config.matrix.roomId, "Error fetching notifications.");
  }
}
