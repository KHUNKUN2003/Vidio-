import { app, initializeDatabase } from "../server/index.js";

const ready = initializeDatabase();

export default async function handler(request, response) {
  await ready;
  return app(request, response);
}
