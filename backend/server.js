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

// Routes
const usersRoutes = require("./routes/users.js");
const consultationsRoutes = require("./routes/consultations.js");
const mentalHealthRoutes = require("./routes/mentalHealthConsultations.js");
const authRoutes = require("./routes/auth.js");
const connectionsRoutes = require("./routes/connections.js");
const messagesRoutes = require("./routes/messages.js");
const treatmentRequestsRoutes = require("./routes/treatmentRequests.js");

// Use base_url in the route paths
const baseUrlPath = new URL(global.base_url).pathname.replace(/\/$/, "");

app.use(`${baseUrlPath}/users`, usersRoutes);
app.use(`${baseUrlPath}/consultations`, consultationsRoutes);
app.use(`${baseUrlPath}/mental-health-consultations`, mentalHealthRoutes);
app.use(`${baseUrlPath}/auth`, authRoutes);
app.use(`${baseUrlPath}/connections`, connectionsRoutes);
app.use(`${baseUrlPath}/messages`, messagesRoutes);
app.use(`${baseUrlPath}/treatment-requests`, treatmentRequestsRoutes);

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
});

server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
