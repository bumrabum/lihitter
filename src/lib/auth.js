import { config } from "../config.js";

export function basicAuth(req, res, next) {
  if (config.isLocal) return next();

  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="lihitter"');
    return res.status(401).send("Authentication required");
  }

  const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  const user = decoded.slice(0, colon);
  const pass = decoded.slice(colon + 1);

  if (user !== config.authUser || pass !== config.authPassword) {
    res.set("WWW-Authenticate", 'Basic realm="lihitter"');
    return res.status(401).send("Invalid credentials");
  }

  next();
}
