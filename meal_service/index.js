const express = require("express");
const mealsRouter = require("./routes/meals");

const app = express();
const port = Number(process.env.PORT || 4001);

app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.use("/meals", mealsRouter);

app.use((err, req, res, next) => {
  res.status(500).json({ error: err.message || "internal server error" });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`meal_service listening on http://localhost:${port}`);
  });
}

module.exports = app;
