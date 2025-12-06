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

const allowedUploaderRoles = new Set(["doctor", "hospital", "ngo", "admin"]);

router.post("/", authenticateToken, async (req, res) => {
  try {
    const user = req.user;

    if (!allowedUploaderRoles.has(user.role)) {
      return res.status(403).json({
        error:
          "Only doctors, hospitals, NGOs, or admins can upload verification evidence",
      });
    }

    const { treatment_request_id, receipt_url, patient_feedback } = req.body;

    if (!treatment_request_id) {
      return res.status(400).json({
        error: "treatment_request_id is required",
      });
    }

    const [request] = await runQuery(
      `SELECT id, patient_id, doctor_id, sponsered, status
       FROM treatment_requests
       WHERE id = ?`,
      [treatment_request_id]
    );

    if (!request) {
      return res.status(404).json({ error: "Treatment request not found" });
    }

    if (!request.sponsered) {
      return res.status(400).json({
        error: "Only sponsored treatment requests require verification",
      });
    }

    if (request.status !== "funded" && request.status !== "closed") {
      return res.status(400).json({
        error: "Verification can only be uploaded after the request is funded",
      });
    }

    const existing = await runQuery(
      "SELECT id FROM sponsorship_verification WHERE treatment_request_id = ?",
      [treatment_request_id]
    );

    if (existing.length > 0) {
      return res.status(400).json({
        error:
          "Verification evidence already exists for this treatment request",
      });
    }

    const insertResult = await runQuery(
      `INSERT INTO sponsorship_verification
        (treatment_request_id, receipt_url, patient_feedback, created_at)
       VALUES (?, ?, ?, NOW())`,
      [treatment_request_id, receipt_url || null, patient_feedback || null]
    );

    const [verification] = await runQuery(
      "SELECT * FROM sponsorship_verification WHERE id = ?",
      [insertResult.insertId]
    );

    res.status(201).json({
      message: "Verification evidence uploaded successfully",
      sponsorship_verification: verification,
    });
  } catch (error) {
    console.error("Create sponsorship verification error:", error);
    res.status(500).json({
      error: "Internal server error while uploading verification",
    });
  }
});

const canViewVerification = (user, request) => {
  if (user.role === "admin") return true;
  if (user.id === request.patient_id) return true;
  if (user.id === request.doctor_id) return true;
  return false;
};

router.get(
  "/by-treatment-request/:treatment_request_id",
  authenticateToken,
  async (req, res) => {
    try {
      const { treatment_request_id } = req.params;
      const user = req.user;

      const [request] = await runQuery(
        "SELECT id, patient_id, doctor_id FROM treatment_requests WHERE id = ?",
        [treatment_request_id]
      );

      if (!request) {
        return res.status(404).json({ error: "Treatment request not found" });
      }

      if (!canViewVerification(user, request)) {
        return res.status(403).json({
          error: "You do not have access to this verification",
        });
      }

      const [verification] = await runQuery(
        "SELECT * FROM sponsorship_verification WHERE treatment_request_id = ?",
        [treatment_request_id]
      );

      if (!verification) {
        return res.status(404).json({
          error: "No verification found for this treatment request",
        });
      }

      res.json({
        message: "Verification retrieved successfully",
        sponsorship_verification: verification,
      });
    } catch (error) {
      console.error("Get verification by treatment request error:", error);
      res.status(500).json({
        error: "Internal server error while retrieving verification",
      });
    }
  }
);

router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const verificationId = req.params.id;
    const user = req.user;

    const results = await runQuery(
      `SELECT sv.*, tr.patient_id, tr.doctor_id
       FROM sponsorship_verification sv
       JOIN treatment_requests tr ON sv.treatment_request_id = tr.id
       WHERE sv.id = ?`,
      [verificationId]
    );

    if (results.length === 0) {
      return res.status(404).json({ error: "Verification not found" });
    }

    const verification = results[0];

    if (!canViewVerification(user, verification)) {
      return res.status(403).json({
        error: "You do not have access to this verification",
      });
    }

    res.json({
      message: "Verification retrieved successfully",
      sponsorship_verification: verification,
    });
  } catch (error) {
    console.error("Get verification error:", error);
    res.status(500).json({
      error: "Internal server error while retrieving verification",
    });
  }
});

router.put(
  "/:id/approve",
  authenticateToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const verificationId = req.params.id;
      const { approved } = req.body;

      if (typeof approved !== "boolean") {
        return res.status(400).json({
          error: "approved must be a boolean",
        });
      }

      const results = await runQuery(
        `SELECT sv.*, tr.status, tr.id AS treatment_request_id
       FROM sponsorship_verification sv
       JOIN treatment_requests tr ON sv.treatment_request_id = tr.id
       WHERE sv.id = ?`,
        [verificationId]
      );

      if (results.length === 0) {
        return res.status(404).json({ error: "Verification not found" });
      }

      const verification = results[0];

      const connection = await new Promise((resolve, reject) => {
        db.getConnection((err, conn) => {
          if (err) reject(err);
          else resolve(conn);
        });
      });

      try {
        await new Promise((resolve, reject) =>
          connection.query("START TRANSACTION", (err) =>
            err ? reject(err) : resolve()
          )
        );

        if (approved) {
          // Approve verification and close treatment request
          await new Promise((resolve, reject) => {
            connection.query(
              `UPDATE sponsorship_verification
               SET approved = 1, approved_at = ?, approved_by = ?
             WHERE id = ?`,
              [new Date(), req.user.id, verificationId],
              (err, result) => {
                if (err) reject(err);
                else resolve(result);
              }
            );
          });

          await new Promise((resolve, reject) => {
            connection.query(
              `UPDATE treatment_requests
               SET status = 'closed', updated_at = NOW()
             WHERE id = ?`,
              [verification.treatment_request_id],
              (err, result) => {
                if (err) reject(err);
                else resolve(result);
              }
            );
          });
        } else {
          // When setting approved to false: delete verification and, if needed, revert status
          await new Promise((resolve, reject) => {
            connection.query(
              "DELETE FROM sponsorship_verification WHERE id = ?",
              [verificationId],
              (err, result) => {
                if (err) reject(err);
                else resolve(result);
              }
            );
          });

          // If request had been closed before, move it back to funded
          if (verification.status === "closed") {
            await new Promise((resolve, reject) => {
              connection.query(
                `UPDATE treatment_requests
                 SET status = 'funded', updated_at = NOW()
               WHERE id = ?`,
                [verification.treatment_request_id],
                (err, result) => {
                  if (err) reject(err);
                  else resolve(result);
                }
              );
            });
          }
        }

        await new Promise((resolve, reject) =>
          connection.query("COMMIT", (err) => (err ? reject(err) : resolve()))
        );
      } catch (txError) {
        await new Promise((resolve) =>
          connection.query("ROLLBACK", () => resolve())
        );
        throw txError;
      } finally {
        connection.release();
      }

      res.json({
        message: approved
          ? "Verification approved successfully"
          : "Verification marked as not approved",
        sponsorship_verification: approved
          ? (
              await runQuery(
                "SELECT * FROM sponsorship_verification WHERE id = ?",
                [verificationId]
              )
            )[0]
          : null,
      });
    } catch (error) {
      console.error("Approve verification error:", error);
      res.status(500).json({
        error: "Internal server error while approving verification",
      });
    }
  }
);

module.exports = router;
