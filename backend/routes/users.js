const express = require("express");
const router = express.Router();
const db = require("../db.js");
const bcrypt = require("bcrypt");
const authenticateToken = require("../middleware/auth.js");
const requireRole = require("../middleware/roleCheck.js");

// Validate that authenticateToken is a function
if (typeof authenticateToken !== "function") {
  throw new Error("authenticateToken middleware must be a function");
}

// POST /users - Admin/Hospital only: Create new user (doctor or patient)
router.post(
  "/",
  authenticateToken,
  requireRole("admin", "hospital"),
  async (req, res) => {
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
      if (
        !username ||
        !email ||
        !contact_phone ||
        !password ||
        !language_pref
      ) {
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

      // Validate role - only doctor or patient can be created by admin/hospital
      if (!role) {
        return res.status(400).json({
          error: "Role is required. Allowed values: doctor, patient",
        });
      }

      const allowedRoles = ["doctor", "patient"];
      if (!allowedRoles.includes(role)) {
        return res.status(400).json({
          error: `Invalid role. Only 'doctor' or 'patient' can be created by admin/hospital`,
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

      // Insert user into database with verification_status = 'verified'
      const insertQuery = `
      INSERT INTO users (
        username, email, contact_phone, password_hash, role, 
        language_pref, specialty, official_document_url, 
        registration_number, website_url, verification_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified')
    `;

      const insertValues = [
        username,
        email,
        contact_phone,
        password_hash,
        role,
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

      // Fetch the created user (only username and email for admin to send to staff)
      const userResult = await new Promise((resolve, reject) => {
        db.query(
          "SELECT username, email FROM users WHERE id = ?",
          [userId],
          (err, results) => {
            if (err) reject(err);
            else resolve(results);
          }
        );
      });

      const user = userResult[0];

      // Return only username and email (password excluded)
      res.status(201).json({
        message: "User created successfully",
        user: {
          username: user.username,
          email: user.email,
        },
      });
    } catch (error) {
      console.error("User creation error:", error);
      res
        .status(500)
        .json({ error: "Internal server error during user creation" });
    }
  }
);

// PUT /users - Update own profile
router.put("/", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      username,
      email,
      password,
      role,
      verification_status,
      contact_phone,
      language_pref,
      specialty,
      official_document_url,
      registration_number,
      website_url,
    } = req.body;

    // Prevent updating restricted fields
    if (username !== undefined) {
      return res.status(400).json({
        error: "Username cannot be updated",
      });
    }

    if (email !== undefined) {
      return res.status(400).json({
        error: "Email cannot be updated",
      });
    }

    if (password !== undefined) {
      return res.status(400).json({
        error:
          "Password cannot be updated through this endpoint. Use password update endpoint instead",
      });
    }

    if (role !== undefined) {
      return res.status(400).json({
        error: "Role cannot be updated",
      });
    }

    if (verification_status !== undefined) {
      return res.status(400).json({
        error: "Verification status cannot be updated",
      });
    }

    // Check if user exists
    const userCheck = await new Promise((resolve, reject) => {
      db.query(
        "SELECT id FROM users WHERE id = ?",
        [userId],
        (err, results) => {
          if (err) reject(err);
          else resolve(results);
        }
      );
    });

    if (userCheck.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    // Build update query dynamically based on provided fields
    const updateFields = [];
    const updateValues = [];

    // Allowed fields to update
    if (contact_phone !== undefined) {
      updateFields.push("contact_phone = ?");
      updateValues.push(contact_phone);
    }

    if (language_pref !== undefined) {
      updateFields.push("language_pref = ?");
      updateValues.push(language_pref);
    }

    if (specialty !== undefined) {
      updateFields.push("specialty = ?");
      updateValues.push(specialty || null);
    }

    if (official_document_url !== undefined) {
      updateFields.push("official_document_url = ?");
      updateValues.push(official_document_url || null);
    }

    if (registration_number !== undefined) {
      updateFields.push("registration_number = ?");
      updateValues.push(registration_number || null);
    }

    if (website_url !== undefined) {
      updateFields.push("website_url = ?");
      updateValues.push(website_url || null);
    }

    // If no fields to update
    if (updateFields.length === 0) {
      return res.status(400).json({
        error: "No valid fields to update",
      });
    }

    // Add updated_at timestamp
    updateFields.push("updated_at = NOW()");
    updateValues.push(userId);

    // Execute update query
    const updateQuery = `UPDATE users SET ${updateFields.join(
      ", "
    )} WHERE id = ?`;

    await new Promise((resolve, reject) => {
      db.query(updateQuery, updateValues, (err, results) => {
        if (err) reject(err);
        else resolve(results);
      });
    });

    // Fetch updated user (without password_hash)
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

    const updatedUser = userResult[0];

    res.status(200).json({
      message: "Profile updated successfully",
      user: updatedUser,
    });
  } catch (error) {
    console.error("Profile update error:", error);
    res
      .status(500)
      .json({ error: "Internal server error during profile update" });
  }
});

// GET all users
router.get("/", (req, res) => {
  db.query("SELECT * FROM users", (err, results) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(results);
  });
});

// PUT /users/password - Update password
router.put("/password", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { current_password, new_password, confirm_password } = req.body;

    // Validate required fields
    if (!current_password || !new_password || !confirm_password) {
      return res.status(400).json({
        error:
          "Current password, new password, and confirm password are required",
      });
    }

    // Validate new password and confirm password match
    if (new_password !== confirm_password) {
      return res.status(400).json({
        error: "New password and confirm password do not match",
      });
    }

    // Validate password strength (minimum length)
    if (new_password.length < 6) {
      return res.status(400).json({
        error: "Password must be at least 6 characters long",
      });
    }

    // Fetch user with password hash
    const userResult = await new Promise((resolve, reject) => {
      db.query(
        "SELECT id, password_hash FROM users WHERE id = ?",
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

    // Verify current password
    const isCurrentPasswordValid = await bcrypt.compare(
      current_password,
      user.password_hash
    );

    if (!isCurrentPasswordValid) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    // Check if new password is different from current password
    const isSamePassword = await bcrypt.compare(
      new_password,
      user.password_hash
    );
    if (isSamePassword) {
      return res.status(400).json({
        error: "New password must be different from current password",
      });
    }

    // Hash new password
    const saltRounds = 10;
    const new_password_hash = await bcrypt.hash(new_password, saltRounds);

    // Update password in database
    await new Promise((resolve, reject) => {
      db.query(
        "UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?",
        [new_password_hash, userId],
        (err, results) => {
          if (err) reject(err);
          else resolve(results);
        }
      );
    });

    res.status(200).json({
      message: "Password updated successfully",
    });
  } catch (error) {
    console.error("Password update error:", error);
    res
      .status(500)
      .json({ error: "Internal server error during password update" });
  }
});

// DELETE /users - Delete own account
router.delete("/", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { password } = req.body;

    // Validate password is provided
    if (!password) {
      return res.status(400).json({
        error: "Password is required to delete account",
      });
    }

    // Fetch user with password hash
    const userResult = await new Promise((resolve, reject) => {
      db.query(
        "SELECT id, password_hash FROM users WHERE id = ?",
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

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);

    if (!isPasswordValid) {
      return res.status(401).json({ error: "Invalid password" });
    }

    // Check for active consultations (pending or confirmed status)
    const activeConsultations = await new Promise((resolve, reject) => {
      db.query(
        "SELECT COUNT(*) as count FROM consultations WHERE (patient_id = ? OR doctor_id = ?) AND status IN ('pending', 'confirmed')",
        [userId, userId],
        (err, results) => {
          if (err) reject(err);
          else resolve(results[0].count);
        }
      );
    });

    if (activeConsultations > 0) {
      return res.status(403).json({
        error:
          "Cannot delete account. You have active consultations. Please complete or cancel them first.",
      });
    }

    // Attempt to delete user
    // Note: This may fail due to foreign key constraints if there are related records
    // The database will prevent deletion if foreign keys exist without ON DELETE CASCADE
    await new Promise((resolve, reject) => {
      db.query("DELETE FROM users WHERE id = ?", [userId], (err, results) => {
        if (err) {
          // Check if error is due to foreign key constraint
          if (err.code === "ER_ROW_IS_REFERENCED_2" || err.errno === 1451) {
            reject(
              new Error(
                "Cannot delete account due to existing related records. Please contact support."
              )
            );
          } else {
            reject(err);
          }
        } else {
          resolve(results);
        }
      });
    });

    res.status(200).json({
      message: "Account deleted successfully",
    });
  } catch (error) {
    console.error("Account deletion error:", error);
    if (error.message.includes("related records")) {
      return res.status(403).json({ error: error.message });
    }
    res
      .status(500)
      .json({ error: "Internal server error during account deletion" });
  }
});

// GET user by ID with JWT authentication
router.get("/:id", authenticateToken, (req, res) => {
  const userId = req.params.id;

  db.query("SELECT * FROM users WHERE id = ?", [userId], (err, results) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    if (results.length === 0) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    console.log(results);
    res.json(results[0]);
  });
});

module.exports = router;
