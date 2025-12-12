const express = require("express");
const router = express.Router();
const db = require("../db.js");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const runQuery = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.query(sql, params, (err, results) => {
      if (err) reject(err);
      else resolve(results);
    });
  });

// Stripe webhook endpoint (must use raw body for signature verification)
router.post("/", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error("[stripe-webhook] STRIPE_WEBHOOK_SECRET not configured");
    return res.status(500).json({ error: "Webhook secret not configured" });
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error("[stripe-webhook] Signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  if (event.type === "payment_intent.succeeded") {
    const paymentIntent = event.data.object;
    const { treatment_request_id, donor_id, amount } = paymentIntent.metadata;

    if (!treatment_request_id || !donor_id || !amount) {
      console.error(
        "[stripe-webhook] Missing metadata in payment_intent:",
        paymentIntent.id
      );
      return res.status(400).json({
        error: "Missing required metadata in payment intent",
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

      // Get current treatment request status
      const [request] = await runQuery(
        "SELECT id, goal_amount, raised_amount, status FROM treatment_requests WHERE id = ?",
        [treatment_request_id]
      );

      if (!request) {
        throw new Error(`Treatment request ${treatment_request_id} not found`);
      }

      const numericAmount = Number(amount);
      const newRaised = Number(request.raised_amount || 0) + numericAmount;
      const newStatus =
        newRaised >= Number(request.goal_amount) ? "funded" : request.status;

      // Create donation record
      const insertResult = await new Promise((resolve, reject) => {
        connection.query(
          `INSERT INTO donations
             (treatment_request_id, donor_id, amount, donated_at)
           VALUES (?, ?, ?, NOW())`,
          [treatment_request_id, donor_id, numericAmount],
          (err, results) => {
            if (err) reject(err);
            else resolve(results);
          }
        );
      });

      // Update treatment request
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

      console.log(
        `[stripe-webhook] Donation created: ID ${insertResult.insertId}, Amount: ${amount}, Treatment Request: ${treatment_request_id}`
      );

      res.json({ received: true, donation_id: insertResult.insertId });
    } catch (txError) {
      await new Promise((resolve) =>
        connection.query("ROLLBACK", () => resolve())
      );
      console.error("[stripe-webhook] Transaction error:", txError);
      throw txError;
    } finally {
      connection.release();
    }
  } else {
    console.log(`[stripe-webhook] Unhandled event type: ${event.type}`);
    res.json({ received: true });
  }
});

module.exports = router;

