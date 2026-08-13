from fastapi import FastAPI, HTTPException

app = FastAPI(title="Food Microservice")

foods = [
    {"id": 1, "name": "Margherita Pizza", "category": "Italian", "price": 12.5},
    {"id": 2, "name": "Chicken Tikka Masala", "category": "Indian", "price": 14.0},
    {"id": 3, "name": "Sushi Roll", "category": "Japanese", "price": 16.75},
]


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/foods")
def get_foods():
    return foods


@app.get("/foods/{food_id}")
def get_food(food_id: int):
    food = next((f for f in foods if f["id"] == food_id), None)
    if food is None:
        raise HTTPException(status_code=404, detail="food not found")
    return food
