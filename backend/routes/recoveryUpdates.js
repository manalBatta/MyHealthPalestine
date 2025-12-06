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

// POST /recovery-updates - Create recovery update (patient or doctor)
router.post("/", authenticateToken, async (req, res) => {
  try {
    const { patient_id, treatment_request_id, consultation_id, content, file_url, status } = req.body;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Validate required fields
    if (!patient_id || !content || !status) {
      return res.status(400).json({
        error: "patient_id, content, and status are required",
      });
    }

    // Validate status enum
    const validStatuses = ["improving", "stable", "critical", "recovered"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        error: `status must be one of: ${validStatuses.join(", ")}`,
      });
    }

    // Check if patient exists
    const patient = await runQuery("SELECT id, role FROM users WHERE id = ?", [patient_id]);
    if (patient.length === 0) {
      return res.status(404).json({ error: "Patient not found" });
    }
    if (patient[0].role !== "patient") {
      return res.status(400).json({ error: "patient_id must refer to a patient" });
    }

    // Authorization: Patient can only create for themselves, doctor can create for their patients
    if (userRole === "patient") {
      if (parseInt(patient_id) !== userId) {
        return res.status(403).json({
          error: "Patients can only create recovery updates for themselves",
        });
      }
    } else if (userRole === "doctor") {
      // Check if doctor has a connection with this patient
      const connection = await runQuery(
        "SELECT id FROM connections WHERE patient_id = ? AND doctor_id = ? AND status = 'active'",
        [patient_id, userId]
      );
      if (connection.length === 0) {
        return res.status(403).json({
          error: "Doctor can only create recovery updates for connected patients",
        });
      }
    } else {
      return res.status(403).json({
        error: "Only patients and doctors can create recovery updates",
      });
    }

    // Validate optional foreign keys if provided
    if (treatment_request_id) {
      const treatmentRequest = await runQuery(
        "SELECT id, patient_id FROM treatment_requests WHERE id = ?",
        [treatment_request_id]
      );
      if (treatmentRequest.length === 0) {
        return res.status(404).json({ error: "Treatment request not found" });
      }
      if (parseInt(treatmentRequest[0].patient_id) !== parseInt(patient_id)) {
        return res.status(400).json({
          error: "Treatment request does not belong to the specified patient",
        });
      }
    }

    if (consultation_id) {
      const consultation = await runQuery(
        "SELECT id, patient_id FROM consultations WHERE id = ?",
        [consultation_id]
      );
      if (consultation.length === 0) {
        return res.status(404).json({ error: "Consultation not found" });
      }
      if (parseInt(consultation[0].patient_id) !== parseInt(patient_id)) {
        return res.status(400).json({
          error: "Consultation does not belong to the specified patient",
        });
      }
    }

    // Insert recovery update
    const result = await runQuery(
      `INSERT INTO recovery_updates 
       (patient_id, treatment_request_id, consultation_id, content, file_url, status, created_at) 
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [patient_id, treatment_request_id || null, consultation_id || null, content, file_url || null, status]
    );

    const recoveryUpdate = await runQuery(
      "SELECT * FROM recovery_updates WHERE id = ?",
      [result.insertId]
    );

    res.status(201).json({
      message: "Recovery update created successfully",
      data: recoveryUpdate[0],
    });
  } catch (error) {
    console.error("Error creating recovery update:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /recovery-updates - List recovery updates (patient sees own, doctor sees their patients', admin sees all)
router.get("/", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    let query = "SELECT * FROM recovery_updates";
    let params = [];

    if (userRole === "patient") {
      query += " WHERE patient_id = ?";
      params.push(userId);
    } else if (userRole === "doctor") {
      // Doctor sees recovery updates for their connected patients
      query += ` WHERE patient_id IN (
        SELECT patient_id FROM connections 
        WHERE doctor_id = ? AND status = 'active'
      )`;
      params.push(userId);
    } else if (userRole === "admin") {
      // Admin sees all
      // No WHERE clause needed
    } else {
      return res.status(403).json({
        error: "Access denied",
      });
    }

    query += " ORDER BY created_at DESC";

    const recoveryUpdates = await runQuery(query, params);

    res.status(200).json({
      message: "Recovery updates retrieved successfully",
      data: recoveryUpdates,
    });
  } catch (error) {
    console.error("Error fetching recovery updates:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /recovery-updates/patient/:patient_id - Get specific patient's recovery updates (doctor only)
router.get("/patient/:patient_id", authenticateToken, requireRole("doctor"), async (req, res) => {
  try {
    const { patient_id } = req.params;
    const doctorId = req.user.id;

    // Check if patient exists
    const patient = await runQuery("SELECT id, role FROM users WHERE id = ?", [patient_id]);
    if (patient.length === 0) {
      return res.status(404).json({ error: "Patient not found" });
    }
    if (patient[0].role !== "patient") {
      return res.status(400).json({ error: "patient_id must refer to a patient" });
    }

    // Check if doctor has a connection with this patient
    const connection = await runQuery(
      "SELECT id FROM connections WHERE patient_id = ? AND doctor_id = ? AND status = 'active'",
      [patient_id, doctorId]
    );
    if (connection.length === 0) {
      return res.status(403).json({
        error: "Doctor can only view recovery updates for connected patients",
      });
    }

    const recoveryUpdates = await runQuery(
      "SELECT * FROM recovery_updates WHERE patient_id = ? ORDER BY created_at DESC",
      [patient_id]
    );

    res.status(200).json({
      message: "Patient recovery updates retrieved successfully",
      data: recoveryUpdates,
    });
  } catch (error) {
    console.error("Error fetching patient recovery updates:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /recovery-updates/:id - Get single recovery update
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    const recoveryUpdate = await runQuery(
      "SELECT * FROM recovery_updates WHERE id = ?",
      [id]
    );

    if (recoveryUpdate.length === 0) {
      return res.status(404).json({ error: "Recovery update not found" });
    }

    const update = recoveryUpdate[0];

    // Authorization check
    if (userRole === "patient") {
      if (parseInt(update.patient_id) !== userId) {
        return res.status(403).json({
          error: "Access denied",
        });
      }
    } else if (userRole === "doctor") {
      // Check if doctor has a connection with this patient
      const connection = await runQuery(
        "SELECT id FROM connections WHERE patient_id = ? AND doctor_id = ? AND status = 'active'",
        [update.patient_id, userId]
      );
      if (connection.length === 0) {
        return res.status(403).json({
          error: "Access denied",
        });
      }
    } else if (userRole !== "admin") {
      return res.status(403).json({
        error: "Access denied",
      });
    }

    res.status(200).json({
      message: "Recovery update retrieved successfully",
      data: update,
    });
  } catch (error) {
    console.error("Error fetching recovery update:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /recovery-updates/:id - Update recovery update (patient or doctor)
router.put("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { content, file_url, status } = req.body;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Get existing recovery update
    const existing = await runQuery(
      "SELECT * FROM recovery_updates WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Recovery update not found" });
    }

    const update = existing[0];

    // Authorization: Patient can update their own, doctor can update for their patients
    if (userRole === "patient") {
      if (parseInt(update.patient_id) !== userId) {
        return res.status(403).json({
          error: "Patients can only update their own recovery updates",
        });
      }
    } else if (userRole === "doctor") {
      // Check if doctor has a connection with this patient
      const connection = await runQuery(
        "SELECT id FROM connections WHERE patient_id = ? AND doctor_id = ? AND status = 'active'",
        [update.patient_id, userId]
      );
      if (connection.length === 0) {
        return res.status(403).json({
          error: "Doctor can only update recovery updates for connected patients",
        });
      }
    } else {
      return res.status(403).json({
        error: "Only patients and doctors can update recovery updates",
      });
    }

    // Build update query dynamically
    const updates = [];
    const params = [];

    if (content !== undefined) {
      updates.push("content = ?");
      params.push(content);
    }

    if (file_url !== undefined) {
      updates.push("file_url = ?");
      params.push(file_url);
    }

    if (status !== undefined) {
      // Validate status enum
      const validStatuses = ["improving", "stable", "critical", "recovered"];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          error: `status must be one of: ${validStatuses.join(", ")}`,
        });
      }
      updates.push("status = ?");
      params.push(status);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    params.push(id);

    await runQuery(
      `UPDATE recovery_updates SET ${updates.join(", ")} WHERE id = ?`,
      params
    );

    const updated = await runQuery(
      "SELECT * FROM recovery_updates WHERE id = ?",
      [id]
    );

    res.status(200).json({
      message: "Recovery update updated successfully",
      data: updated[0],
    });
  } catch (error) {
    console.error("Error updating recovery update:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /recovery-updates/:id - Delete recovery update (doctor for their patients or admin)
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Get existing recovery update
    const existing = await runQuery(
      "SELECT * FROM recovery_updates WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Recovery update not found" });
    }

    const update = existing[0];

    // Authorization: Doctor can delete for their patients, admin can delete any
    if (userRole === "doctor") {
      // Check if doctor has a connection with this patient
      const connection = await runQuery(
        "SELECT id FROM connections WHERE patient_id = ? AND doctor_id = ? AND status = 'active'",
        [update.patient_id, userId]
      );
      if (connection.length === 0) {
        return res.status(403).json({
          error: "Doctor can only delete recovery updates for connected patients",
        });
      }
    } else if (userRole !== "admin") {
      return res.status(403).json({
        error: "Only doctors and admins can delete recovery updates",
      });
    }

    await runQuery("DELETE FROM recovery_updates WHERE id = ?", [id]);

    res.status(200).json({
      message: "Recovery update deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting recovery update:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

