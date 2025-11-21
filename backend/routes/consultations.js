const express = require("express");
const router = express.Router();
const db = require("../db.js");
const authenticateToken = require("../middleware/auth.js");
const requireRole = require("../middleware/roleCheck.js");

// Validate that authenticateToken is a function
if (typeof authenticateToken !== "function") {
  throw new Error("authenticateToken middleware must be a function");
}

// Helper to run queries with promises
const getConnection = () =>
  new Promise((resolve, reject) => {
    db.getConnection((err, connection) => {
      if (err) reject(err);
      else resolve(connection);
    });
  });

const queryConnection = (connection, sql, params = []) =>
  new Promise((resolve, reject) => {
    connection.query(sql, params, (err, results) => {
      if (err) reject(err);
      else resolve(results);
    });
  });

// POST /consultations - Patient creates a new consultation
router.post("/", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;

  if (userRole !== "patient") {
    return res.status(403).json({
      error: "Only patients can create consultations",
    });
  }

  const { doctor_id, slot_id, mode, notes } = req.body;

  // Validate required fields
  if (!doctor_id || !slot_id || !mode) {
    return res.status(400).json({
      error: "doctor_id, slot_id, and mode are required",
    });
  }

  // Notes must be null (doctor fills after consultation)
  if (notes !== undefined && notes !== null) {
    return res.status(400).json({
      error: "Notes must be null when creating a consultation",
    });
  }

  // Validate mode
  const allowedModes = ["video", "audio", "chat"];
  if (!allowedModes.includes(mode)) {
    return res.status(400).json({
      error: `Invalid mode. Allowed values: ${allowedModes.join(", ")}`,
    });
  }

  let connection;

  try {
    connection = await getConnection();
    await queryConnection(connection, "START TRANSACTION");

    // Ensure doctor exists and has doctor role
    const doctorResult = await queryConnection(
      connection,
      "SELECT id, role FROM users WHERE id = ?",
      [doctor_id]
    );

    if (doctorResult.length === 0 || doctorResult[0].role !== "doctor") {
      await queryConnection(connection, "ROLLBACK");
      return res.status(400).json({
        error: "Selected doctor does not exist or is not a doctor",
      });
    }

    // Ensure slot exists, belongs to doctor, and is available
    const slotResult = await queryConnection(
      connection,
      "SELECT id, doctor_id, is_booked FROM consultation_slots WHERE id = ? FOR UPDATE",
      [slot_id]
    );

    if (slotResult.length === 0) {
      await queryConnection(connection, "ROLLBACK");
      return res.status(400).json({
        error: "Selected slot does not exist",
      });
    }

    const slot = slotResult[0];

    if (slot.doctor_id !== Number(doctor_id)) {
      await queryConnection(connection, "ROLLBACK");
      return res.status(400).json({
        error: "Selected slot does not belong to the specified doctor",
      });
    }

    if (slot.is_booked) {
      await queryConnection(connection, "ROLLBACK");
      return res.status(400).json({
        error: "Selected slot is already booked",
      });
    }

    // Create consultation (status defaults to 'pending')
    const insertResult = await queryConnection(
      connection,
      `INSERT INTO consultations
        (patient_id, doctor_id, specialty, status, mode, notes, slot_id)
        VALUES (?, ?, ?, 'pending', ?, NULL, ?)`,
      [userId, doctor_id, null, mode, slot_id]
    );

    const consultationId = insertResult.insertId;

    // Update slot to mark as booked and link to consultation
    await queryConnection(
      connection,
      `UPDATE consultation_slots
        SET is_booked = TRUE, consultation_id = ?, updated_at = NOW()
        WHERE id = ?`,
      [consultationId, slot_id]
    );

    // Fetch the newly created consultation
    const consultationResult = await queryConnection(
      connection,
      `SELECT id, patient_id, doctor_id, specialty, status, mode, notes, slot_id,
              created_at, updated_at
       FROM consultations
       WHERE id = ?`,
      [consultationId]
    );

    await queryConnection(connection, "COMMIT");

    res.status(201).json({
      message: "Consultation created successfully",
      consultation: consultationResult[0],
    });
  } catch (error) {
    if (connection) {
      try {
        await queryConnection(connection, "ROLLBACK");
      } catch (rollbackError) {
        console.error("Rollback error:", rollbackError);
      }
    }
    console.error("Create consultation error:", error);
    res.status(500).json({
      error: "Internal server error during consultation creation",
    });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

// PUT /consultations/:id - Update consultation status/notes
router.put("/:id", authenticateToken, async (req, res) => {
  const consultationId = req.params.id;
  const userId = req.user.id;
  const userRole = req.user.role;
  const { status, notes } = req.body;

  // Only patients or doctors can update consultations
  if (!["patient", "doctor"].includes(userRole)) {
    return res.status(403).json({
      error: "Only patients or doctors can update consultations",
    });
  }

  try {
    // Fetch consultation
    const consultationResult = await new Promise((resolve, reject) => {
      db.query(
        "SELECT * FROM consultations WHERE id = ?",
        [consultationId],
        (err, results) => {
          if (err) reject(err);
          else resolve(results);
        }
      );
    });

    if (consultationResult.length === 0) {
      return res.status(404).json({ error: "Consultation not found" });
    }

    const consultation = consultationResult[0];

    const updates = [];
    const values = [];

    if (userRole === "patient") {
      if (consultation.patient_id !== userId) {
        return res
          .status(403)
          .json({ error: "You can only update your own consultations" });
      }

      if (notes !== undefined) {
        return res
          .status(400)
          .json({ error: "Patients cannot update consultation notes" });
      }

      if (!status) {
        return res.status(400).json({
          error: "Status is required for patient updates",
        });
      }

      const allowedStatus = ["cancelled"];
      if (!allowedStatus.includes(status)) {
        return res.status(400).json({
          error: `Patients can only set status to: ${allowedStatus.join(", ")}`,
        });
      }

      updates.push("status = ?");
      values.push(status);
    } else if (userRole === "doctor") {
      if (consultation.doctor_id !== userId) {
        return res
          .status(403)
          .json({ error: "You can only update your own consultations" });
      }

      const allowedStatus = ["confirmed", "completed", "cancelled"];
      if (status !== undefined) {
        if (!allowedStatus.includes(status)) {
          return res.status(400).json({
            error: `Doctors can only set status to: ${allowedStatus.join(
              ", "
            )}`,
          });
        }
        updates.push("status = ?");
        values.push(status);
      }

      if (notes !== undefined) {
        updates.push("notes = ?");
        values.push(notes);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({
        error: "No valid fields to update",
      });
    }

    updates.push("updated_at = NOW()");

    values.push(consultationId);

    await new Promise((resolve, reject) => {
      db.query(
        `UPDATE consultations SET ${updates.join(", ")} WHERE id = ?`,
        values,
        (err, results) => {
          if (err) reject(err);
          else resolve(results);
        }
      );
    });

    const updatedConsultation = await new Promise((resolve, reject) => {
      db.query(
        "SELECT * FROM consultations WHERE id = ?",
        [consultationId],
        (err, results) => {
          if (err) reject(err);
          else resolve(results[0]);
        }
      );
    });

    res.status(200).json({
      message: "Consultation updated successfully",
      consultation: updatedConsultation,
    });
  } catch (error) {
    console.error("Update consultation error:", error);
    res
      .status(500)
      .json({ error: "Internal server error during consultation update" });
  }
});

// DELETE /consultations/:id - Admin only
router.delete(
  "/:id",
  authenticateToken,
  requireRole("admin"),
  async (req, res) => {
    const consultationId = req.params.id;
    let connection;

    try {
      connection = await getConnection();
      await queryConnection(connection, "START TRANSACTION");

      const consultationResult = await queryConnection(
        connection,
        "SELECT id, slot_id FROM consultations WHERE id = ? FOR UPDATE",
        [consultationId]
      );

      if (consultationResult.length === 0) {
        await queryConnection(connection, "ROLLBACK");
        return res.status(404).json({ error: "Consultation not found" });
      }

      const consultation = consultationResult[0];

      await queryConnection(
        connection,
        "DELETE FROM consultations WHERE id = ?",
        [consultationId]
      );

      if (consultation.slot_id) {
        await queryConnection(
          connection,
          `UPDATE consultation_slots
             SET is_booked = FALSE,
                 consultation_id = NULL,
                 updated_at = NOW()
           WHERE id = ?`,
          [consultation.slot_id]
        );
      }

      await queryConnection(connection, "COMMIT");

      res.status(200).json({
        message: "Consultation deleted successfully",
      });
    } catch (error) {
      if (connection) {
        try {
          await queryConnection(connection, "ROLLBACK");
        } catch (rollbackError) {
          console.error("Rollback error:", rollbackError);
        }
      }
      console.error("Delete consultation error:", error);
      res.status(500).json({
        error: "Internal server error during consultation deletion",
      });
    } finally {
      if (connection) {
        connection.release();
      }
    }
  }
);

// GET /consultations - Retrieve consultations for the authenticated user
router.get("/", authenticateToken, (req, res) => {
  const userId = req.user.id;

  const query = `
    SELECT *
    FROM consultations
    WHERE patient_id = ? OR doctor_id = ?
    ORDER BY created_at DESC
  `;

  db.query(query, [userId, userId], (err, results) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({
      message: "Consultations retrieved successfully",
      consultations: results,
    });
  });
});

// GET /consultations/all - Admin only: Retrieve all consultations with filters & pagination
router.get("/all", authenticateToken, requireRole("admin"), (req, res) => {
  const {
    page = 1,
    limit = 20,
    sort_by = "created_at",
    sort_order = "desc",
    status,
    mode,
    doctor_id,
    patient_id,
    created_from,
    created_to,
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
    "created_at",
    "updated_at",
    "status",
    "mode",
    "doctor_id",
    "patient_id",
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
    const allowedStatus = ["pending", "confirmed", "completed", "cancelled"];
    if (!allowedStatus.includes(status)) {
      return res.status(400).json({
        error: `Invalid status. Allowed: ${allowedStatus.join(", ")}`,
      });
    }
    conditions.push("status = ?");
    params.push(status);
  }

  if (mode) {
    const allowedModes = ["video", "audio", "chat"];
    if (!allowedModes.includes(mode)) {
      return res.status(400).json({
        error: `Invalid mode. Allowed: ${allowedModes.join(", ")}`,
      });
    }
    conditions.push("mode = ?");
    params.push(mode);
  }

  if (doctor_id) {
    const doctorIdNum = parseInt(doctor_id, 10);
    if (Number.isNaN(doctorIdNum)) {
      return res.status(400).json({ error: "doctor_id must be a number" });
    }
    conditions.push("doctor_id = ?");
    params.push(doctorIdNum);
  }

  if (patient_id) {
    const patientIdNum = parseInt(patient_id, 10);
    if (Number.isNaN(patientIdNum)) {
      return res.status(400).json({ error: "patient_id must be a number" });
    }
    conditions.push("patient_id = ?");
    params.push(patientIdNum);
  }

  if (created_from) {
    const fromDate = new Date(created_from);
    if (Number.isNaN(fromDate.getTime())) {
      return res.status(400).json({ error: "Invalid created_from date" });
    }
    conditions.push("created_at >= ?");
    params.push(created_from);
  }

  if (created_to) {
    const toDate = new Date(created_to);
    if (Number.isNaN(toDate.getTime())) {
      return res.status(400).json({ error: "Invalid created_to date" });
    }
    conditions.push("created_at <= ?");
    params.push(created_to);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const offset = (pageNum - 1) * limitNum;

  const dataQuery = `
    SELECT *
    FROM consultations
    ${whereClause}
    ORDER BY ${normalizedSortBy} ${normalizedSortOrder}
    LIMIT ?
    OFFSET ?
  `;

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM consultations
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
          message: "All consultations retrieved successfully",
          meta: {
            page: pageNum,
            limit: limitNum,
            total,
            total_pages: Math.ceil(total / limitNum),
          },
          consultations: dataResults,
        });
      }
    );
  });
});

module.exports = router;
