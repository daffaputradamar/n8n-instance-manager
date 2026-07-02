const crypto = require("crypto");

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return salt + ":" + hash;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  try {
    const verify = crypto.scryptSync(password, salt, 64).toString("hex");
    return hash === verify;
  } catch {
    return false;
  }
}

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) {
    req.sessionUser = req.session.user;
    return next();
  }
  return res.status(401).json({ error: "Not signed in" });
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.authed && req.session.user && req.session.user.role === "admin") {
    return next();
  }
  return res.status(403).json({ error: "Admin access required" });
}

module.exports = { hashPassword, verifyPassword, requireAuth, requireAdmin };
