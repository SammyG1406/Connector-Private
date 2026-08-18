const express = require("express");
const mealsRouter = require("./routes/meals");

function createApp() {
  const app = express();
  app.use(express.json());

  app.get("/health", (req, res) => res.json({ status: "ok" }));
  app.use("/meals", mealsRouter);

  app.use((req, res) => res.status(404).json({ error: "not found" }));

  return app;
}

module.exports = { createApp };
