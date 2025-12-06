const express = require("express");
const router = express.Router();
const db = require("../db.js");
const authenticateToken = require("../middleware/auth.js");

const runQuery = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.query(sql, params, (err, results) => {
      if (err) reject(err);
      else resolve(results);
    });
  });

// POST /donations - Create a donation for a sponsored treatment request
router.post("/", authenticateToken, async (req, res) => {
  try {
    const donorId = req.user.id;
    const { treatment_request_id, amount } = req.body;

    if (!treatment_request_id || !amount) {
      return res.status(400).json({
        error: "treatment_request_id and amount are required",
      });
    }

    const numericAmount = Number(amount);
    if (Number.isNaN(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({
        error: "amount must be a positive number",
      });
    }

    const [request] = await runQuery(
      "SELECT id, sponsered, goal_amount, raised_amount, status FROM treatment_requests WHERE id = ?",
      [treatment_request_id]
    );

    if (!request) {
      return res.status(404).json({ error: "Treatment request not found" });
    }

    if (!request.sponsered) {
      return res.status(400).json({
        error: "Donations are only allowed for sponsored treatment requests",
      });
    }

    if (!request.goal_amount || Number(request.goal_amount) <= 0) {
      return res.status(400).json({
        error: "Sponsored treatment request must have a goal_amount",
      });
    }

    if (request.status !== "open" && request.status !== "funded") {
      return res.status(400).json({
        error: "Donations can only be made to open or partially funded requests",
      });
    }

    const remaining =
      Number(request.goal_amount) - Number(request.raised_amount || 0);

    if (numericAmount > remaining) {
      return res.status(400).json({
        error: "Donation amount cannot exceed remaining goal amount",
        remaining_amount: remaining,
      });
    }

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

      const insertResult = await new Promise((resolve, reject) => {
        connection.query(
          `INSERT INTO donations
             (treatment_request_id, donor_id, amount, donated_at)
           VALUES (?, ?, ?, NOW())`,
          [treatment_request_id, donorId, numericAmount],
          (err, results) => {
            if (err) reject(err);
            else resolve(results);
          }
        );
      });

      const newRaised = Number(request.raised_amount || 0) + numericAmount;
      const newStatus =
        newRaised >= Number(request.goal_amount) ? "funded" : request.status;

      await new Promise((resolve, reject) => {
        connection.query(
          `UPDATE treatment_requests
             SET raised_amount = ?, status = ?, updated_at = NOW()
           WHERE id = ?`,
          [newRaised, newStatus, treatment_request_id],
          (err, results) => {
            if (err) reject(err);
            else resolve(results);
          }
        );
      });

      await new Promise((resolve, reject) =>
        connection.query("COMMIT", (err) =>
          err ? reject(err) : resolve()
        )
      );

      const [donation] = await runQuery(
        "SELECT * FROM donations WHERE id = ?",
        [insertResult.insertId]
      );

      res.status(201).json({
        message: "Donation created successfully",
        donation,
      });
    } catch (txError) {
      await new Promise((resolve) =>
        connection.query("ROLLBACK", () => resolve())
      );
      throw txError;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error("Create donation error:", error);
    res.status(500).json({
      error: "Internal server error while creating donation",
    });
  }
});

// GET /donations - List current user's donations
router.get("/", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20 } = req.query;

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);

    if (Number.isNaN(pageNum) || pageNum < 1) {
      return res.status(400).json({ error: "Invalid page number" });
    }
    if (Number.isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
      return res.status(400).json({
        error: "Invalid limit. Must be between 1 and 100",
      });
    }

    const data = await runQuery(
      `SELECT d.*, tr.treatment_type, tr.content, tr.goal_amount, tr.raised_amount
       FROM donations d
       JOIN treatment_requests tr ON d.treatment_request_id = tr.id
       WHERE d.donor_id = ?
       ORDER BY d.donated_at DESC
       LIMIT ?
       OFFSET ?`,
      [userId, limitNum, (pageNum - 1) * limitNum]
    );

    res.json({
      message: "Donations retrieved successfully",
      data,
      meta: { page: pageNum, limit: limitNum },
    });
  } catch (error) {
    console.error("Get donations error:", error);
    res.status(500).json({
      error: "Internal server error while retrieving donations",
    });
  }
});

// GET /donations/:id - Get single donation (donor or related doctor/patient)
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const donationId = req.params.id;
    const user = req.user;

    const results = await runQuery(
      `SELECT d.*, tr.doctor_id, tr.patient_id
       FROM donations d
       JOIN treatment_requests tr ON d.treatment_request_id = tr.id
       WHERE d.id = ?`,
      [donationId]
    );

    if (results.length === 0) {
      return res.status(404).json({ error: "Donation not found" });
    }

    const donation = results[0];

    const isDonor = donation.donor_id === user.id;
    const isDoctor = donation.doctor_id === user.id;
    const isPatient = donation.patient_id === user.id;
    const isAdmin = user.role === "admin";

    if (!isDonor && !isDoctor && !isPatient && !isAdmin) {
      return res.status(403).json({
        error: "You do not have access to this donation",
      });
    }

    res.json({
      message: "Donation retrieved successfully",
      donation,
    });
  } catch (error) {
    console.error("Get donation error:", error);
    res.status(500).json({
      error: "Internal server error while retrieving donation",
    });
  }
});

// GET /treatment-requests/:id/donations - List donations for a specific request
router.get(
  "/by-treatment-request/:treatment_request_id",
  authenticateToken,
  async (req, res) => {
    try {
      const { treatment_request_id } = req.params;
      const user = req.user;

      const [request] = await runQuery(
        "SELECT id, doctor_id, patient_id FROM treatment_requests WHERE id = ?",
        [treatment_request_id]
      );

      if (!request) {
        return res.status(404).json({ error: "Treatment request not found" });
      }

      const isDoctor = request.doctor_id === user.id;
      const isPatient = request.patient_id === user.id;
      const isAdmin = user.role === "admin";

      if (!isDoctor && !isPatient && !isAdmin) {
        return res.status(403).json({
          error: "You do not have access to donations for this request",
        });
      }

      const donations = await runQuery(
        `SELECT d.*, u.username AS donor_username, u.email AS donor_email
         FROM donations d
         LEFT JOIN users u ON d.donor_id = u.id
         WHERE d.treatment_request_id = ?
         ORDER BY d.donated_at DESC`,
        [treatment_request_id]
      );

      res.json({
        message: "Donations for treatment request retrieved successfully",
        data: donations,
      });
    } catch (error) {
      console.error("Get donations by treatment request error:", error);
      res.status(500).json({
        error:
          "Internal server error while retrieving donations for treatment request",
      });
    }
  }
);

module.exports = router;


