const express = require("express");
const router = express.Router();
const db = require("../db.js");
const authenticateToken = require("../middleware/auth.js");
const requireRole = require("../middleware/roleCheck.js");

const runQuery = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.query(sql, params, (err, results) => {
      if (err) reject(err);
      else resolve(results);
    });
  });

// Helper to check if user can create public health alerts
const canCreateAlert = (role) => {
  return ["doctor", "hospital", "ngo", "admin"].includes(role);
};

// Helper to format date for MySQL
const formatMySQLDate = (dateString) => {
  if (!dateString) return null;
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace("T", " ");
};

// POST /public-health-alerts - Create public health alert (doctors, hospitals, NGOs, admins only)
router.post("/", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    if (!canCreateAlert(userRole)) {
      return res.status(403).json({
        error: "Only doctors, hospitals, NGOs, and admins can create public health alerts",
      });
    }

    const { title, message, alert_type, severity, country, city, expires_at } =
      req.body;

    // Validate required fields
    if (!title || !message || !alert_type || !severity) {
      return res.status(400).json({
        error: "title, message, alert_type, and severity are required",
      });
    }

    // Validate alert_type enum
    const validAlertTypes = [
      "disease_outbreak",
      "air_quality",
      "urgent_need",
      "general",
    ];
    if (!validAlertTypes.includes(alert_type)) {
      return res.status(400).json({
        error: `alert_type must be one of: ${validAlertTypes.join(", ")}`,
      });
    }

    // Validate severity enum
    const validSeverities = ["low", "moderate", "high", "critical"];
    if (!validSeverities.includes(severity)) {
      return res.status(400).json({
        error: `severity must be one of: ${validSeverities.join(", ")}`,
      });
    }

    // Validate and format expires_at if provided
    const formattedExpiresAt = expires_at ? formatMySQLDate(expires_at) : null;
    if (expires_at && !formattedExpiresAt) {
      return res.status(400).json({
        error: "Invalid expires_at date format",
      });
    }

    // Validate expires_at is in the future if provided
    if (formattedExpiresAt) {
      const expiresDate = new Date(expires_at);
      if (expiresDate <= new Date()) {
        return res.status(400).json({
          error: "expires_at must be in the future",
        });
      }
    }

    const sql = `
      INSERT INTO public_health_alerts 
        (title, message, alert_type, severity, country, city, published_by, is_active, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, true, ?, NOW())
    `;

    const result = await runQuery(sql, [
      title,
      message,
      alert_type,
      severity,
      country || null,
      city || null,
      userId,
      formattedExpiresAt,
    ]);

    const alertId = result.insertId;

    // Fetch the created alert
    const alert = await runQuery(
      `SELECT 
        pha.*,
        u.username as publisher_username,
        u.email as publisher_email
      FROM public_health_alerts pha
      LEFT JOIN users u ON pha.published_by = u.id
      WHERE pha.id = ?`,
      [alertId]
    );

    res.status(201).json({
      message: "Public health alert created successfully",
      alert: alert[0],
    });
  } catch (error) {
    console.error("Error creating public health alert:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /public-health-alerts - List public health alerts
router.get("/", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const {
      alert_type,
      severity,
      country,
      city,
      is_active,
      my_alerts,
      active_only,
    } = req.query;

    let sql = `
      SELECT 
        pha.*,
        u.username as publisher_username,
        u.email as publisher_email
      FROM public_health_alerts pha
      LEFT JOIN users u ON pha.published_by = u.id
      WHERE 1=1
    `;

    const params = [];

    // For non-admins, show only active alerts that haven't expired
    if (userRole !== "admin") {
      sql +=
        " AND pha.is_active = true AND (pha.expires_at IS NULL OR pha.expires_at > NOW())";
    } else {
      // Admins can see all, but can filter
      if (active_only === "true") {
        sql +=
          " AND pha.is_active = true AND (pha.expires_at IS NULL OR pha.expires_at > NOW())";
      } else if (is_active !== undefined) {
        sql += " AND pha.is_active = ?";
        params.push(is_active === "true" ? 1 : 0);
      }
    }

    // Filter by alert_type
    if (alert_type) {
      sql += " AND pha.alert_type = ?";
      params.push(alert_type);
    }

    // Filter by severity
    if (severity) {
      sql += " AND pha.severity = ?";
      params.push(severity);
    }

    // Filter by country
    if (country) {
      sql += " AND pha.country = ?";
      params.push(country);
    }

    // Filter by city
    if (city) {
      sql += " AND pha.city = ?";
      params.push(city);
    }

    // Filter by user's alerts
    if (my_alerts === "true") {
      sql += " AND pha.published_by = ?";
      params.push(userId);
    }

    // Order by severity (critical first), then by created_at
    sql +=
      " ORDER BY FIELD(pha.severity, 'critical', 'high', 'moderate', 'low'), pha.created_at DESC";

    const alerts = await runQuery(sql, params);

    res.json({
      message: "Public health alerts retrieved successfully",
      alerts,
    });
  } catch (error) {
    console.error("Error fetching public health alerts:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /public-health-alerts/:id - Get single public health alert
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userRole = req.user.role;

    const sql = `
      SELECT 
        pha.*,
        u.username as publisher_username,
        u.email as publisher_email
      FROM public_health_alerts pha
      LEFT JOIN users u ON pha.published_by = u.id
      WHERE pha.id = ?
    `;

    const alert = await runQuery(sql, [id]);

    if (alert.length === 0) {
      return res.status(404).json({ error: "Public health alert not found" });
    }

    // For non-admins, check if alert is active and not expired
    if (userRole !== "admin") {
      if (!alert[0].is_active) {
        return res.status(403).json({
          error: "This alert is not active",
        });
      }
      if (
        alert[0].expires_at &&
        new Date(alert[0].expires_at) <= new Date()
      ) {
        return res.status(403).json({
          error: "This alert has expired",
        });
      }
    }

    res.json({
      message: "Public health alert retrieved successfully",
      alert: alert[0],
    });
  } catch (error) {
    console.error("Error fetching public health alert:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /public-health-alerts/:id - Update public health alert (creator or admin)
router.put("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Check if alert exists
    const existing = await runQuery(
      "SELECT * FROM public_health_alerts WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Public health alert not found" });
    }

    // Only creator or admin can update
    if (existing[0].published_by !== userId && userRole !== "admin") {
      return res.status(403).json({
        error: "Only the alert publisher or admin can update this alert",
      });
    }

    const {
      title,
      message,
      alert_type,
      severity,
      country,
      city,
      is_active,
      expires_at,
    } = req.body;

    const updates = [];
    const params = [];

    if (title !== undefined) {
      updates.push("title = ?");
      params.push(title);
    }
    if (message !== undefined) {
      updates.push("message = ?");
      params.push(message);
    }
    if (alert_type !== undefined) {
      const validAlertTypes = [
        "disease_outbreak",
        "air_quality",
        "urgent_need",
        "general",
      ];
      if (!validAlertTypes.includes(alert_type)) {
        return res.status(400).json({
          error: `alert_type must be one of: ${validAlertTypes.join(", ")}`,
        });
      }
      updates.push("alert_type = ?");
      params.push(alert_type);
    }
    if (severity !== undefined) {
      const validSeverities = ["low", "moderate", "high", "critical"];
      if (!validSeverities.includes(severity)) {
        return res.status(400).json({
          error: `severity must be one of: ${validSeverities.join(", ")}`,
        });
      }
      updates.push("severity = ?");
      params.push(severity);
    }
    if (country !== undefined) {
      updates.push("country = ?");
      params.push(country);
    }
    if (city !== undefined) {
      updates.push("city = ?");
      params.push(city);
    }
    if (is_active !== undefined) {
      if (typeof is_active !== "boolean") {
        return res.status(400).json({
          error: "is_active must be a boolean value",
        });
      }
      updates.push("is_active = ?");
      params.push(is_active);
    }
    if (expires_at !== undefined) {
      const formattedExpiresAt = expires_at ? formatMySQLDate(expires_at) : null;
      if (expires_at && !formattedExpiresAt) {
        return res.status(400).json({
          error: "Invalid expires_at date format",
        });
      }
      updates.push("expires_at = ?");
      params.push(formattedExpiresAt);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    params.push(id);

    const sql = `UPDATE public_health_alerts SET ${updates.join(", ")} WHERE id = ?`;

    await runQuery(sql, params);

    // Fetch updated alert
    const updated = await runQuery(
      `SELECT 
        pha.*,
        u.username as publisher_username,
        u.email as publisher_email
      FROM public_health_alerts pha
      LEFT JOIN users u ON pha.published_by = u.id
      WHERE pha.id = ?`,
      [id]
    );

    res.json({
      message: "Public health alert updated successfully",
      alert: updated[0],
    });
  } catch (error) {
    console.error("Error updating public health alert:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /public-health-alerts/:id - Delete public health alert (creator or admin)
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Check if alert exists
    const existing = await runQuery(
      "SELECT * FROM public_health_alerts WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Public health alert not found" });
    }

    // Only creator or admin can delete
    if (existing[0].published_by !== userId && userRole !== "admin") {
      return res.status(403).json({
        error: "Only the alert publisher or admin can delete this alert",
      });
    }

    await runQuery("DELETE FROM public_health_alerts WHERE id = ?", [id]);

    res.json({ message: "Public health alert deleted successfully" });
  } catch (error) {
    console.error("Error deleting public health alert:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

