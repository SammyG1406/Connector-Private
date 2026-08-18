const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const dbPath = process.env.MEAL_DB_PATH || path.join(__dirname, "meals.db");
const db = new DatabaseSync(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS meals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    calories INTEGER NOT NULL,
    timestamp TEXT NOT NULL
  )
`);

function addMeal({ name, calories, timestamp }) {
  const stmt = db.prepare(
    "INSERT INTO meals (name, calories, timestamp) VALUES (?, ?, ?)"
  );
  const result = stmt.run(name, calories, timestamp);
  return getMeal(result.lastInsertRowid);
}

function listMeals() {
  return db.prepare("SELECT * FROM meals ORDER BY id DESC").all();
}

function getMeal(id) {
  return db.prepare("SELECT * FROM meals WHERE id = ?").get(id);
}

function deleteMeal(id) {
  const stmt = db.prepare("DELETE FROM meals WHERE id = ?");
  const result = stmt.run(id);
  return result.changes > 0;
}

module.exports = { addMeal, listMeals, getMeal, deleteMeal };
