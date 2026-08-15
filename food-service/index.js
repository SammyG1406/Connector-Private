require("dotenv").config();
const express = require("express");

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 4001);

// In-memory store; replace with a real database for production use.
let foods = [
  { id: 1, name: "Margherita Pizza", category: "Italian", price: 12.5 },
  { id: 2, name: "Chicken Tikka Masala", category: "Indian", price: 14.0 },
  { id: 3, name: "Sushi Roll", category: "Japanese", price: 16.75 },
];
let nextId = foods.length + 1;

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/foods", (req, res) => {
  res.json(foods);
});

app.get("/foods/:id", (req, res) => {
  const food = foods.find((f) => f.id === Number(req.params.id));
  if (!food) return res.status(404).json({ error: "food not found" });
  res.json(food);
});

app.post("/foods", (req, res) => {
  const { name, category, price } = req.body || {};
  if (!name || !category || typeof price !== "number") {
    return res.status(400).json({ error: "name, category, and numeric price are required" });
  }
  const food = { id: nextId++, name, category, price };
  foods.push(food);
  res.status(201).json(food);
});

app.put("/foods/:id", (req, res) => {
  const food = foods.find((f) => f.id === Number(req.params.id));
  if (!food) return res.status(404).json({ error: "food not found" });
  const { name, category, price } = req.body || {};
  if (name !== undefined) food.name = name;
  if (category !== undefined) food.category = category;
  if (price !== undefined) food.price = price;
  res.json(food);
});

app.delete("/foods/:id", (req, res) => {
  const index = foods.findIndex((f) => f.id === Number(req.params.id));
  if (index === -1) return res.status(404).json({ error: "food not found" });
  const [removed] = foods.splice(index, 1);
  res.json(removed);
});

app.listen(PORT, () => {
  console.log(`Food service listening on http://localhost:${PORT}`);
});
