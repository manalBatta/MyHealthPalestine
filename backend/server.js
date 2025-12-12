const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const app = express();
const port = 3000;
const db = require("./db.js");
require("dotenv").config();

// Global base_url variable
global.base_url = process.env.BASE_URL || `http://localhost:${port}/healthpal`;

// Stripe webhook must be registered BEFORE express.json() middleware
// because it needs raw body for signature verification
const stripeWebhookRoutes = require("./routes/stripeWebhook.js");
const baseUrlPath = new URL(global.base_url).pathname.replace(/\/$/, "");
app.use(`${baseUrlPath}/stripe-webhook`, stripeWebhookRoutes);

app.use(express.json());

// Clean up expired tokens from blacklist (runs on startup and can be scheduled)
const cleanupExpiredTokens = () => {
  db.query(
    "DELETE FROM token_blacklist WHERE expires_at < NOW()",
    (err, results) => {
      if (err) {
        console.error("Error cleaning up expired tokens:", err);
      } else {
        console.log(`Cleaned up ${results.affectedRows} expired tokens`);
      }
    }
  );
};

// Clean up expired tokens on server startup
cleanupExpiredTokens();

// Schedule cleanup every hour (optional - can be adjusted)
setInterval(cleanupExpiredTokens, 60 * 60 * 1000);

// Clean up past, unbooked consultation slots
const cleanupExpiredSlots = () => {
  db.query(
    "DELETE FROM consultation_slots WHERE is_booked = FALSE AND consultation_id IS NULL AND end_datetime < NOW()",
    (err, results) => {
      if (err) {
        console.error("Error cleaning up expired slots:", err);
      } else if (results.affectedRows) {
        console.log(`Cleaned up ${results.affectedRows} expired slots`);
      }
    }
  );
};

// Run slot cleanup every hour
setInterval(cleanupExpiredSlots, 60 * 60 * 1000);

// Check and update expired medicines
const checkExpiredMedicines = () => {
  db.query(
    `UPDATE inventory_registry 
     SET \`condition\` = 'expired' 
     WHERE type = 'medicine' 
     AND expiry_date < CURDATE() 
     AND \`condition\` != 'expired'`,
    (err, results) => {
      if (err) {
        console.error("Error checking expired medicines:", err);
      } else if (results.affectedRows) {
        console.log(`Updated ${results.affectedRows} expired medicines`);
      }
    }
  );
};

// Run expired medicine check on startup and daily
checkExpiredMedicines();
setInterval(checkExpiredMedicines, 24 * 60 * 60 * 1000); // Every 24 hours

// Deactivate expired public health alerts
const deactivateExpiredAlerts = () => {
  db.query(
    `UPDATE public_health_alerts 
     SET is_active = false 
     WHERE is_active = true 
     AND expires_at IS NOT NULL 
     AND expires_at <= NOW()`,
    (err, results) => {
      if (err) {
        console.error("Error deactivating expired alerts:", err);
      } else if (results.affectedRows) {
        console.log(
          `Deactivated ${results.affectedRows} expired public health alerts`
        );
      }
    }
  );
};

// Run expired alerts check on startup and hourly
deactivateExpiredAlerts();
setInterval(deactivateExpiredAlerts, 60 * 60 * 1000); // Every hour

// Routes
const usersRoutes = require("./routes/users.js");
const consultationsRoutes = require("./routes/consultations.js");
const consultationSlotsRoutes = require("./routes/consultationSlots.js");
const mentalHealthRoutes = require("./routes/mentalHealthConsultations.js");
const authRoutes = require("./routes/auth.js");
const connectionsRoutes = require("./routes/connections.js");
const messagesRoutes = require("./routes/messages.js");
const treatmentRequestsRoutes = require("./routes/treatmentRequests.js");
const donationsRoutes = require("./routes/donations.js");
const sponsorshipVerificationRoutes = require("./routes/sponsorshipVerification.js");
const recoveryUpdatesRoutes = require("./routes/recoveryUpdates.js");
const medicineRequestsRoutes = require("./routes/medicineRequests.js");
const anonymousSessionsRoutes = require("./routes/anonymousSessions.js");
const anonymousMessagesRoutes = require("./routes/anonymousMessages.js");
const inventoryRegistryRoutes = require("./routes/inventoryRegistry.js");
const workshopsRoutes = require("./routes/workshops.js");
const workshopRegistrationsRoutes = require("./routes/workshopRegistrations.js");
const supportGroupsRoutes = require("./routes/supportGroups.js");
const supportGroupMembersRoutes = require("./routes/supportGroupMembers.js");
const supportGroupMessagesRoutes = require("./routes/supportGroupMessages.js");
const missionsRoutes = require("./routes/missions.js");
const missionRegistrationsRoutes = require("./routes/missionRegistrations.js");
const surgicalMissionsRoutes = require("./routes/surgicalMissions.js");
const healthGuidesRoutes = require("./routes/healthGuides.js");
const publicHealthAlertsRoutes = require("./routes/publicHealthAlerts.js");

// Use base_url in the route paths (already defined above for webhook)
app.use(`${baseUrlPath}/users`, usersRoutes);
app.use(`${baseUrlPath}/consultations`, consultationsRoutes);
app.use(`${baseUrlPath}/consultation-slots`, consultationSlotsRoutes);
app.use(`${baseUrlPath}/mental-health-consultations`, mentalHealthRoutes);
app.use(`${baseUrlPath}/auth`, authRoutes);
app.use(`${baseUrlPath}/connections`, connectionsRoutes);
app.use(`${baseUrlPath}/messages`, messagesRoutes);
app.use(`${baseUrlPath}/treatment-requests`, treatmentRequestsRoutes);
app.use(`${baseUrlPath}/donations`, donationsRoutes);
app.use(
  `${baseUrlPath}/sponsorship-verifications`,
  sponsorshipVerificationRoutes
);
app.use(`${baseUrlPath}/recovery-updates`, recoveryUpdatesRoutes);
app.use(`${baseUrlPath}/medicine-requests`, medicineRequestsRoutes);
app.use(`${baseUrlPath}/anonymous-sessions`, anonymousSessionsRoutes);
app.use(`${baseUrlPath}/anonymous-messages`, anonymousMessagesRoutes);
app.use(`${baseUrlPath}/inventory-registry`, inventoryRegistryRoutes);
app.use(`${baseUrlPath}/workshops`, workshopsRoutes);
app.use(`${baseUrlPath}/workshop-registrations`, workshopRegistrationsRoutes);
app.use(`${baseUrlPath}/support-groups`, supportGroupsRoutes);
app.use(`${baseUrlPath}/support-group-members`, supportGroupMembersRoutes);
app.use(`${baseUrlPath}/support-group-messages`, supportGroupMessagesRoutes);
app.use(`${baseUrlPath}/missions`, missionsRoutes);
app.use(`${baseUrlPath}/mission-registrations`, missionRegistrationsRoutes);
app.use(`${baseUrlPath}/surgical-missions`, surgicalMissionsRoutes);
app.use(`${baseUrlPath}/health-guides`, healthGuidesRoutes);
app.use(`${baseUrlPath}/public-health-alerts`, publicHealthAlertsRoutes);

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.set("io", io);

const verifyConnectionParticipant = (connectionId, userId) =>
  new Promise((resolve, reject) => {
    db.query(
      "SELECT * FROM connections WHERE id = ?",
      [connectionId],
      (err, results) => {
        if (err) {
          reject(err);
          return;
        }

        if (results.length === 0) {
          resolve(null);
          return;
        }

        const connection = results[0];
        if (
          connection.patient_id !== userId &&
          connection.doctor_id !== userId
        ) {
          resolve(null);
          return;
        }

        if (connection.status !== "active") {
          resolve(null);
          return;
        }

        resolve(connection);
      }
    );
  });

io.use((socket, next) => {
  const token =
    socket.handshake.auth?.token || socket.handshake.headers?.authorization;

  if (!token) {
    return next(new Error("Authentication error: token missing"));
  }

  const bearerToken = token.startsWith("Bearer ") ? token.split(" ")[1] : token;

  jwt.verify(
    bearerToken,
    process.env.JWT_SECRET || "your-secret-key",
    (err, user) => {
      if (err) {
        return next(new Error("Authentication error: invalid token"));
      }
      socket.user = user;
      next();
    }
  );
});

io.on("connection", (socket) => {
  socket.on("join_connection", async (connectionId, callback) => {
    try {
      const connection = await verifyConnectionParticipant(
        connectionId,
        socket.user.id
      );

      if (!connection) {
        if (callback) {
          callback({ error: "Unauthorized or inactive connection" });
        }
        return;
      }

      socket.join(`connection_${connectionId}`);
      if (callback) {
        callback({ success: true });
      }
    } catch (error) {
      console.error("join_connection error:", error);
      if (callback) {
        callback({ error: "Failed to join connection" });
      }
    }
  });

  socket.on("leave_connection", (connectionId) => {
    socket.leave(`connection_${connectionId}`);
  });

  // Support group WebSocket handlers
  socket.on("join_support_group", async (groupId, callback) => {
    try {
      // Verify user is active member or moderator
      const group = await new Promise((resolve, reject) => {
        db.query(
          "SELECT moderator_id FROM support_groups WHERE id = ?",
          [groupId],
          (err, results) => {
            if (err) reject(err);
            else resolve(results);
          }
        );
      });

      if (group.length === 0) {
        if (callback) {
          callback({ error: "Support group not found" });
        }
        return;
      }

      const isModerator = group[0].moderator_id === socket.user.id;
      const isAdmin = socket.user.role === "admin";

      if (!isModerator && !isAdmin) {
        // Check if user is active member
        const member = await new Promise((resolve, reject) => {
          db.query(
            "SELECT * FROM support_group_members WHERE group_id = ? AND user_id = ? AND is_active = true",
            [groupId, socket.user.id],
            (err, results) => {
              if (err) reject(err);
              else resolve(results);
            }
          );
        });

        if (member.length === 0) {
          if (callback) {
            callback({
              error:
                "You must be an active member or moderator to join this group",
            });
          }
          return;
        }
      }

      socket.join(`support_group_${groupId}`);
      if (callback) {
        callback({ success: true, group_id: groupId });
      }
    } catch (error) {
      console.error("join_support_group error:", error);
      if (callback) {
        callback({ error: "Failed to join support group" });
      }
    }
  });

  socket.on("leave_support_group", (groupId) => {
    socket.leave(`support_group_${groupId}`);
  });
});

server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
