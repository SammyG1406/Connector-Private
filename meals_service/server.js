const { createApp } = require("./src/app");

const port = Number(process.env.PORT || 4001);
const app = createApp();

app.listen(port, () => {
  console.log(`meals_service listening on http://localhost:${port}`);
});
