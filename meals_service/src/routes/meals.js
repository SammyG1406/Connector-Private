const { Router } = require("express");
const store = require("../store");

const router = Router();

function isValidMealBody(body) {
  return (
    body &&
    typeof body.name === "string" &&
    body.name.trim().length > 0 &&
    ["calories", "protein", "carbs", "fat"].every(
      (field) => body[field] === undefined || typeof body[field] === "number"
    )
  );
}

router.get("/", (req, res) => {
  res.json(store.list());
});

router.get("/:id", (req, res) => {
  const meal = store.get(req.params.id);
  if (!meal) return res.status(404).json({ error: "meal not found" });
  res.json(meal);
});

router.post("/", (req, res) => {
  if (!isValidMealBody(req.body)) {
    return res.status(400).json({ error: "name (string) is required; calories/protein/carbs/fat must be numbers" });
  }
  const meal = store.create(req.body);
  res.status(201).json(meal);
});

router.put("/:id", (req, res) => {
  if (!isValidMealBody(req.body)) {
    return res.status(400).json({ error: "name (string) is required; calories/protein/carbs/fat must be numbers" });
  }
  const meal = store.update(req.params.id, req.body);
  if (!meal) return res.status(404).json({ error: "meal not found" });
  res.json(meal);
});

router.delete("/:id", (req, res) => {
  const deleted = store.remove(req.params.id);
  if (!deleted) return res.status(404).json({ error: "meal not found" });
  res.status(204).send();
});

module.exports = router;
