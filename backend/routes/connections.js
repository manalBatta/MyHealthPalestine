const express = require("express");
const router = express.Router();
const db = require("../db.js");
const authenticateToken = require("../middleware/auth.js");
const requireRole = require("../middleware/roleCheck.js");

// GET /connections - Get user's connections
router.get("/", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    let query;
    let params;

    if (userRole === "patient") {
      // Patients see their connected doctors
      query = `
        SELECT 
          c.id,
          c.patient_id,
          c.doctor_id,
          c.connected_at,
          c.status,
          u.username as doctor_username,
          u.email as doctor_email,
          u.specialty as doctor_specialty
        FROM connections c
        INNER JOIN users u ON c.doctor_id = u.id
        WHERE c.patient_id = ? AND c.status = 'active'
        ORDER BY c.connected_at DESC
      `;
      params = [userId];
    } else if (userRole === "doctor") {
      // Doctors see their connected patients
      query = `
        SELECT 
          c.id,
          c.patient_id,
          c.doctor_id,
          c.connected_at,
          c.status,
          u.username as patient_username,
          u.email as patient_email
        FROM connections c
        INNER JOIN users u ON c.patient_id = u.id
        WHERE c.doctor_id = ? AND c.status = 'active'
        ORDER BY c.connected_at DESC
      `;
      params = [userId];
    } else {
      return res.status(403).json({
        error: "Only patients and doctors can view connections",
      });
    }

    const results = await new Promise((resolve, reject) => {
      db.query(query, params, (err, results) => {
        if (err) reject(err);
        else resolve(results);
      });
    });

    res.status(200).json({
      message: "Connections retrieved successfully",
      connections: results,
    });
  } catch (error) {
    console.error("Get connections error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /connections/:id - Update connection status (doctor only)
router.put("/:id", authenticateToken, async (req, res) => {
  try {
    const connectionId = req.params.id;
    const userId = req.user.id;
    const userRole = req.user.role;
    const { status } = req.body;

    // Only doctors can update connection status
    if (userRole !== "doctor") {
      return res.status(403).json({
        error: "Only doctors can update connection status",
      });
    }

    // Validate status
    if (!status) {
      return res.status(400).json({
        error: "Status is required",
      });
    }

    const allowedStatus = ["active", "inactive"];
    if (!allowedStatus.includes(status)) {
      return res.status(400).json({
        error: `Invalid status. Allowed values: ${allowedStatus.join(", ")}`,
      });
    }

    // Fetch connection and verify doctor owns it
    const connectionResult = await new Promise((resolve, reject) => {
      db.query(
        "SELECT * FROM connections WHERE id = ?",
        [connectionId],
        (err, results) => {
          if (err) reject(err);
          else resolve(results);
        }
      );
    });

    if (connectionResult.length === 0) {
      return res.status(404).json({ error: "Connection not found" });
    }

    const connection = connectionResult[0];

    if (connection.doctor_id !== userId) {
      return res.status(403).json({
        error: "You can only update connections where you are the doctor",
      });
    }

    // Update connection status
    await new Promise((resolve, reject) => {
      db.query(
        "UPDATE connections SET status = ? WHERE id = ?",
        [status, connectionId],
        (err, results) => {
          if (err) reject(err);
          else resolve(results);
        }
      );
    });

    // Fetch updated connection
    const updatedConnection = await new Promise((resolve, reject) => {
      db.query(
        "SELECT * FROM connections WHERE id = ?",
        [connectionId],
        (err, results) => {
          if (err) reject(err);
          else resolve(results[0]);
        }
      );
    });

    res.status(200).json({
      message: "Connection status updated successfully",
      connection: updatedConnection,
    });
  } catch (error) {
    console.error("Update connection error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /connections/:id - Admin only: Delete connection
router.delete("/:id", authenticateToken, requireRole("admin"), async (req, res) => {
  try {
    const connectionId = req.params.id;

    // Check if connection exists
    const connectionResult = await new Promise((resolve, reject) => {
      db.query(
        "SELECT id FROM connections WHERE id = ?",
        [connectionId],
        (err, results) => {
          if (err) reject(err);
          else resolve(results);
        }
      );
    });

    if (connectionResult.length === 0) {
      return res.status(404).json({ error: "Connection not found" });
    }

    // Delete connection
    await new Promise((resolve, reject) => {
      db.query("DELETE FROM connections WHERE id = ?", [connectionId], (err, results) => {
        if (err) reject(err);
        else resolve(results);
      });
    });

    res.status(200).json({
      message: "Connection deleted successfully",
    });
  } catch (error) {
    console.error("Delete connection error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /connections/all - Admin only: Get all connections with filters & pagination
router.get("/all", authenticateToken, requireRole("admin"), (req, res) => {
  const {
    page = 1,
    limit = 20,
    sort_by = "connected_at",
    sort_order = "desc",
    status,
    patient_id,
    doctor_id,
    connected_from,
    connected_to,
  } = req.query;

  // Validate pagination parameters
  const pageNum = parseInt(page, 10);
  const limitNum = parseInt(limit, 10);

  if (Number.isNaN(pageNum) || pageNum < 1) {
    return res.status(400).json({ error: "Invalid page number" });
  }

  if (Number.isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
    return res
      .status(400)
      .json({ error: "Invalid limit. Must be between 1 and 100" });
  }

  // Validate sort field & order
  const allowedSortFields = [
    "connected_at",
    "status",
    "patient_id",
    "doctor_id",
  ];
  const normalizedSortBy = sort_by.toLowerCase();
  if (!allowedSortFields.includes(normalizedSortBy)) {
    return res.status(400).json({
      error: `Invalid sort field. Allowed: ${allowedSortFields.join(", ")}`,
    });
  }

  const normalizedSortOrder = sort_order.toLowerCase();
  if (!["asc", "desc"].includes(normalizedSortOrder)) {
    return res
      .status(400)
      .json({ error: "Invalid sort order. Allowed values: asc, desc" });
  }

  // Build filters
  const conditions = [];
  const params = [];

  if (status) {
    const allowedStatus = ["active", "inactive"];
    if (!allowedStatus.includes(status)) {
      return res.status(400).json({
        error: `Invalid status. Allowed: ${allowedStatus.join(", ")}`,
      });
    }
    conditions.push("c.status = ?");
    params.push(status);
  }

  if (patient_id) {
    const patientIdNum = parseInt(patient_id, 10);
    if (Number.isNaN(patientIdNum)) {
      return res.status(400).json({ error: "patient_id must be a number" });
    }
    conditions.push("c.patient_id = ?");
    params.push(patientIdNum);
  }

  if (doctor_id) {
    const doctorIdNum = parseInt(doctor_id, 10);
    if (Number.isNaN(doctorIdNum)) {
      return res.status(400).json({ error: "doctor_id must be a number" });
    }
    conditions.push("c.doctor_id = ?");
    params.push(doctorIdNum);
  }

  if (connected_from) {
    const fromDate = new Date(connected_from);
    if (Number.isNaN(fromDate.getTime())) {
      return res.status(400).json({ error: "Invalid connected_from date" });
    }
    conditions.push("c.connected_at >= ?");
    params.push(connected_from);
  }

  if (connected_to) {
    const toDate = new Date(connected_to);
    if (Number.isNaN(toDate.getTime())) {
      return res.status(400).json({ error: "Invalid connected_to date" });
    }
    conditions.push("c.connected_at <= ?");
    params.push(connected_to);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const offset = (pageNum - 1) * limitNum;

  const dataQuery = `
    SELECT 
      c.*,
      p.username as patient_username,
      p.email as patient_email,
      d.username as doctor_username,
      d.email as doctor_email,
      d.specialty as doctor_specialty
    FROM connections c
    LEFT JOIN users p ON c.patient_id = p.id
    LEFT JOIN users d ON c.doctor_id = d.id
    ${whereClause}
    ORDER BY c.${normalizedSortBy} ${normalizedSortOrder}
    LIMIT ?
    OFFSET ?
  `;

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM connections c
    ${whereClause}
  `;

  // Execute count query first to get total
  db.query(countQuery, params, (countErr, countResults) => {
    if (countErr) {
      res.status(500).json({ error: countErr.message });
      return;
    }

    const total = countResults[0]?.total || 0;

    // Fetch paginated data
    db.query(
      dataQuery,
      [...params, limitNum, offset],
      (dataErr, dataResults) => {
        if (dataErr) {
          res.status(500).json({ error: dataErr.message });
          return;
        }

        res.json({
          message: "All connections retrieved successfully",
          meta: {
            page: pageNum,
            limit: limitNum,
            total,
            total_pages: Math.ceil(total / limitNum),
          },
          connections: dataResults,
        });
      }
    );
  });
});

module.exports = router;

