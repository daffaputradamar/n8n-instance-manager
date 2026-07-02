function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.status(401).json({ error: "Not signed in" });
}

module.exports = { requireAuth };
