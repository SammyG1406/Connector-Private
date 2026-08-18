const { randomUUID } = require("crypto");

// In-memory store: id -> meal. Data does not survive a process restart.
const meals = new Map();

function list() {
  return Array.from(meals.values());
}

function get(id) {
  return meals.get(id) || null;
}

function create({ name, calories, protein, carbs, fat }) {
  const id = randomUUID();
  const meal = {
    id,
    name,
    calories,
    protein,
    carbs,
    fat,
    createdAt: new Date().toISOString(),
  };
  meals.set(id, meal);
  return meal;
}

function update(id, patch) {
  const existing = meals.get(id);
  if (!existing) return null;
  const updated = { ...existing, ...patch, id, updatedAt: new Date().toISOString() };
  meals.set(id, updated);
  return updated;
}

function remove(id) {
  return meals.delete(id);
}

module.exports = { list, get, create, update, remove };
