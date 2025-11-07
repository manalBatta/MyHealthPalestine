const express = require("express");
const app = express();
const port = 3000;
const db = require("./db.js");

// Global base_url variable
global.base_url = process.env.BASE_URL || `http://localhost:${port}/healthpal`;

app.use(express.json());

// Clean up expired tokens from blacklist (runs on startup and can be scheduled)
const cleanupExpiredTokens = () => {
  db.query(
    "DELETE FROM token_blacklist WHERE expires_at < NOW()",
    (err, results) => {
      if (err) {
        console.error("Error cleaning up expired tokens:", err);
      } else {
        console.log(`Cleaned up ${results.affectedRows} expired tokens`);
      }
    }
  );
};

// Clean up expired tokens on server startup
cleanupExpiredTokens();

// Schedule cleanup every hour (optional - can be adjusted)
setInterval(cleanupExpiredTokens, 60 * 60 * 1000);

// Routes
const usersRoutes = require("./routes/users.js");
const consultationsRoutes = require("./routes/consultations.js");
const authRoutes = require("./routes/auth.js");

// Use base_url in the route paths
const baseUrlPath = new URL(global.base_url).pathname.replace(/\/$/, "");

app.use(`${baseUrlPath}/users`, usersRoutes);
app.use(`${baseUrlPath}/consultations`, consultationsRoutes);
app.use(`${baseUrlPath}/auth`, authRoutes);

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
