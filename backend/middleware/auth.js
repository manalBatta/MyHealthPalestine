const jwt = require("jsonwebtoken");
const db = require("../db.js");

// JWT Authentication Middleware with Token Blacklist Check
const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({ error: "Access token required" });
    }

    // Check if token is blacklisted
    const blacklistCheck = await new Promise((resolve, reject) => {
      db.query(
        "SELECT id FROM token_blacklist WHERE token = ?",
        [token],
        (err, results) => {
          if (err) reject(err);
          else resolve(results);
        }
      );
    });

    if (blacklistCheck.length > 0) {
      return res.status(403).json({ error: "Token has been revoked" });
    }

    // Verify JWT token
    jwt.verify(
      token,
      process.env.JWT_SECRET || "your-secret-key",
      (err, user) => {
        if (err) {
          return res.status(403).json({ error: "Invalid or expired token" });
        }
        req.user = user;
        next();
      }
    );
  } catch (error) {
    console.error("Authentication error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

module.exports = authenticateToken;
