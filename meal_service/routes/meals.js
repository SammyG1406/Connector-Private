const express = require("express");
const db = require("../db");

const router = express.Router();

router.get("/", (req, res) => {
  res.json(db.listMeals());
});

router.post("/", (req, res) => {
  const { name, calories, timestamp } = req.body || {};

  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "name is required and must be a non-empty string" });
  }
  if (typeof calories !== "number" || !Number.isFinite(calories) || calories < 0) {
    return res.status(400).json({ error: "calories is required and must be a non-negative number" });
  }

  const meal = db.addMeal({
    name: name.trim(),
    calories,
    timestamp: timestamp || new Date().toISOString(),
  });
  res.status(201).json(meal);
});

router.delete("/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "id must be an integer" });
  }

  const deleted = db.deleteMeal(id);
  if (!deleted) {
    return res.status(404).json({ error: `meal ${id} not found` });
  }
  res.status(204).end();
});

module.exports = router;
