import { createRestAPIClient } from "masto";

const masto = createRestAPIClient({
  url: process.env.URL,
  accessToken: process.env.TOKEN,
});

const status = await masto.v1.statuses.create({
  status: "Hello from #mastojs!",
});

console.log(status.url);
