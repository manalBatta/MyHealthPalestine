const express = require("express");
const router = express.Router();
const db = require("../db.js");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const authenticateToken = require("../middleware/auth.js");

// POST /auth/register - Register a new user
router.post("/register", async (req, res) => {
  try {
    const {
      username,
      email,
      contact_phone,
      password,
      role,
      language_pref,
      specialty,
      official_document_url,
      registration_number,
      website_url,
    } = req.body;

    // Validate required fields
    if (!username || !email || !contact_phone || !password || !language_pref) {
      return res.status(400).json({
        error:
          "Missing required fields: username, email, contact_phone, password, and language_pref are required",
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    // Validate password strength (minimum length)
    if (password.length < 6) {
      return res.status(400).json({
        error: "Password must be at least 6 characters long",
      });
    }

    // Set default role to 'patient' if not provided
    const userRole = role || "patient";

    // Prevent admin role registration (admin accounts must be created by other admins)
    if (userRole === "admin") {
      return res.status(403).json({
        error: "Admin role cannot be registered through public registration",
      });
    }

    // Validate role is one of the allowed values
    const allowedRoles = ["patient", "doctor", "donor", "ngo", "hospital"];
    if (!allowedRoles.includes(userRole)) {
      return res.status(400).json({
        error: `Invalid role. Must be one of: ${allowedRoles.join(", ")}`,
      });
    }

    // Check for duplicate email
    const emailCheck = await new Promise((resolve, reject) => {
      db.query(
        "SELECT id FROM users WHERE email = ?",
        [email],
        (err, results) => {
          if (err) reject(err);
          else resolve(results);
        }
      );
    });

    if (emailCheck.length > 0) {
      return res.status(409).json({ error: "Email already exists" });
    }

    // Check for duplicate username
    const usernameCheck = await new Promise((resolve, reject) => {
      db.query(
        "SELECT id FROM users WHERE username = ?",
        [username],
        (err, results) => {
          if (err) reject(err);
          else resolve(results);
        }
      );
    });

    if (usernameCheck.length > 0) {
      return res.status(409).json({ error: "Username already exists" });
    }

    // Hash password
    const saltRounds = 10;
    const password_hash = await bcrypt.hash(password, saltRounds);

    // Insert user into database
    const insertQuery = `
      INSERT INTO users (
        username, email, contact_phone, password_hash, role, 
        language_pref, specialty, official_document_url, 
        registration_number, website_url, verification_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none')
    `;

    const insertValues = [
      username,
      email,
      contact_phone,
      password_hash,
      userRole,
      language_pref,
      specialty || null,
      official_document_url || null,
      registration_number || null,
      website_url || null,
    ];

    const insertResult = await new Promise((resolve, reject) => {
      db.query(insertQuery, insertValues, (err, results) => {
        if (err) reject(err);
        else resolve(results);
      });
    });

    const userId = insertResult.insertId;

    // Fetch the created user (without password_hash)
    const userResult = await new Promise((resolve, reject) => {
      db.query(
        "SELECT id, username, email, contact_phone, role, specialty, language_pref, official_document_url, registration_number, website_url, verification_status, created_at, updated_at FROM users WHERE id = ?",
        [userId],
        (err, results) => {
          if (err) reject(err);
          else resolve(results);
        }
      );
    });

    const user = userResult[0];

    // Generate JWT token
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET || "your-secret-key",
      { expiresIn: "1d" }
    );

    // Return both token and user object
    res.status(201).json({
      message: "User registered successfully",
      token: token,
      user: user,
    });
  } catch (error) {
    console.error("Registration error:", error);
    res
      .status(500)
      .json({ error: "Internal server error during registration" });
  }
});

// POST /auth/login - Login user with email or username
router.post("/login", async (req, res) => {
  try {
    const { identifier, password } = req.body;

    // Validate required fields
    if (!identifier || !password) {
      return res.status(400).json({
        error:
          "Missing required fields: identifier (email or username) and password are required",
      });
    }

    // Find user by email or username
    const userResult = await new Promise((resolve, reject) => {
      db.query(
        "SELECT id, username, email, contact_phone, password_hash, role, specialty, language_pref, official_document_url, registration_number, website_url, verification_status, created_at, updated_at FROM users WHERE email = ? OR username = ?",
        [identifier, identifier],
        (err, results) => {
          if (err) reject(err);
          else resolve(results);
        }
      );
    });

    // Generic error message for security (don't reveal if user exists)
    if (userResult.length === 0) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const user = userResult[0];

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);

    if (!isPasswordValid) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Remove password_hash from user object before sending
    delete user.password_hash;

    // Generate JWT token
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET || "your-secret-key",
      { expiresIn: "1d" }
    );

    // Return both token and user object
    res.status(200).json({
      message: "Login successful",
      token: token,
      user: user,
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Internal server error during login" });
  }
});

// GET /auth/me - Get current user's profile with summary counts
router.get("/me", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Fetch user profile (without password_hash)
    const userResult = await new Promise((resolve, reject) => {
      db.query(
        "SELECT id, username, email, contact_phone, role, specialty, language_pref, official_document_url, registration_number, website_url, verification_status, verification_requested_at, verified_at, created_at, updated_at FROM users WHERE id = ?",
        [userId],
        (err, results) => {
          if (err) reject(err);
          else resolve(results);
        }
      );
    });

    if (userResult.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = userResult[0];

    // Calculate summary counts
    const counts = {};

    // Connections count (as patient or doctor)
    const connectionsCount = await new Promise((resolve, reject) => {
      db.query(
        "SELECT COUNT(*) as count FROM connections WHERE patient_id = ? OR doctor_id = ?",
        [userId, userId],
        (err, results) => {
          if (err) reject(err);
          else resolve(results[0].count);
        }
      );
    });
    counts.connections = connectionsCount;

    // Consultations count (as patient or doctor)
    const consultationsCount = await new Promise((resolve, reject) => {
      db.query(
        "SELECT COUNT(*) as count FROM consultations WHERE patient_id = ? OR doctor_id = ?",
        [userId, userId],
        (err, results) => {
          if (err) reject(err);
          else resolve(results[0].count);
        }
      );
    });
    counts.consultations = consultationsCount;

    // Messages count (sent or received)
    const messagesCount = await new Promise((resolve, reject) => {
      db.query(
        "SELECT COUNT(*) as count FROM messages WHERE sender_id = ? OR receiver_id = ?",
        [userId, userId],
        (err, results) => {
          if (err) reject(err);
          else resolve(results[0].count);
        }
      );
    });
    counts.messages = messagesCount;

    // Support group memberships count
    const supportGroupsCount = await new Promise((resolve, reject) => {
      db.query(
        "SELECT COUNT(*) as count FROM support_group_members WHERE user_id = ? AND is_active = true",
        [userId],
        (err, results) => {
          if (err) reject(err);
          else resolve(results[0].count);
        }
      );
    });
    counts.support_groups = supportGroupsCount;

    // Workshop registrations count
    const workshopsCount = await new Promise((resolve, reject) => {
      db.query(
        "SELECT COUNT(*) as count FROM workshop_registrations WHERE user_id = ?",
        [userId],
        (err, results) => {
          if (err) reject(err);
          else resolve(results[0].count);
        }
      );
    });
    counts.workshops = workshopsCount;

    // Mission registrations count
    const missionsCount = await new Promise((resolve, reject) => {
      db.query(
        "SELECT COUNT(*) as count FROM mission_registrations WHERE patient_id = ?",
        [userId],
        (err, results) => {
          if (err) reject(err);
          else resolve(results[0].count);
        }
      );
    });
    counts.missions = missionsCount;

    // Treatment requests count (as patient or doctor)
    const treatmentRequestsCount = await new Promise((resolve, reject) => {
      db.query(
        "SELECT COUNT(*) as count FROM treatment_requests WHERE patient_id = ? OR doctor_id = ?",
        [userId, userId],
        (err, results) => {
          if (err) reject(err);
          else resolve(results[0].count);
        }
      );
    });
    counts.treatment_requests = treatmentRequestsCount;

    // Donations count (for donors)
    const donationsCount = await new Promise((resolve, reject) => {
      db.query(
        "SELECT COUNT(*) as count FROM donations WHERE donor_id = ?",
        [userId],
        (err, results) => {
          if (err) reject(err);
          else resolve(results[0].count);
        }
      );
    });
    counts.donations = donationsCount;

    // Recovery updates count (for patients)
    const recoveryUpdatesCount = await new Promise((resolve, reject) => {
      db.query(
        "SELECT COUNT(*) as count FROM recovery_updates WHERE patient_id = ?",
        [userId],
        (err, results) => {
          if (err) reject(err);
          else resolve(results[0].count);
        }
      );
    });
    counts.recovery_updates = recoveryUpdatesCount;

    // Return user profile with summary counts
    res.status(200).json({
      user: user,
      counts: counts,
    });
  } catch (error) {
    console.error("Get profile error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/logout - Logout user and blacklist token
router.post("/logout", authenticateToken, async (req, res) => {
  try {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({ error: "Token not found" });
    }

    // Decode token to get expiration time
    const decoded = jwt.decode(token);
    if (!decoded || !decoded.exp) {
      return res.status(400).json({ error: "Invalid token format" });
    }

    // Calculate expiration timestamp
    const expiresAt = new Date(decoded.exp * 1000);

    // Add token to blacklist
    await new Promise((resolve, reject) => {
      db.query(
        "INSERT INTO token_blacklist (token, expires_at) VALUES (?, ?)",
        [token, expiresAt],
        (err, results) => {
          if (err) {
            // If token already exists in blacklist, that's okay
            if (err.code === "ER_DUP_ENTRY") {
              resolve(results);
            } else {
              reject(err);
            }
          } else {
            resolve(results);
          }
        }
      );
    });

    res.status(200).json({
      message: "Logout successful",
    });
  } catch (error) {
    console.error("Logout error:", error);
    res.status(500).json({ error: "Internal server error during logout" });
  }
});

module.exports = router;
