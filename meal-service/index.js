require("dotenv").config();
const express = require("express");

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 4002);

// In-memory store; replace with a real database for production use.
let meals = [
  { id: 1, name: "Breakfast Combo", type: "breakfast", calories: 450 },
  { id: 2, name: "Lunch Bowl", type: "lunch", calories: 650 },
  { id: 3, name: "Dinner Plate", type: "dinner", calories: 800 },
];
let nextId = meals.length + 1;

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/meals", (req, res) => {
  res.json(meals);
});

app.get("/meals/:id", (req, res) => {
  const meal = meals.find((m) => m.id === Number(req.params.id));
  if (!meal) return res.status(404).json({ error: "meal not found" });
  res.json(meal);
});

app.post("/meals", (req, res) => {
  const { name, type, calories } = req.body || {};
  if (!name || !type || typeof calories !== "number") {
    return res.status(400).json({ error: "name, type, and numeric calories are required" });
  }
  const meal = { id: nextId++, name, type, calories };
  meals.push(meal);
  res.status(201).json(meal);
});

app.put("/meals/:id", (req, res) => {
  const meal = meals.find((m) => m.id === Number(req.params.id));
  if (!meal) return res.status(404).json({ error: "meal not found" });
  const { name, type, calories } = req.body || {};
  if (name !== undefined) meal.name = name;
  if (type !== undefined) meal.type = type;
  if (calories !== undefined) meal.calories = calories;
  res.json(meal);
});

app.delete("/meals/:id", (req, res) => {
  const index = meals.findIndex((m) => m.id === Number(req.params.id));
  if (index === -1) return res.status(404).json({ error: "meal not found" });
  const [removed] = meals.splice(index, 1);
  res.json(removed);
});

app.listen(PORT, () => {
  console.log(`Meal service listening on http://localhost:${PORT}`);
});
