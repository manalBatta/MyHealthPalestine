const express = require("express");
const app = express();
const port = 3000;

app.use(express.json());

// Routes
const usersRoutes = require("./routes/users.js");
const consultationsRoutes = require("./routes/consultations.js");

app.use("/healthpal/users", usersRoutes);
app.use("/healthpal/consultations", consultationsRoutes);

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
