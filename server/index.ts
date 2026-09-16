import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";
import { Pool } from "pg";

const app = express();
const port = Number(process.env.PORT || 10000);
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

const origins = (
  process.env.ALLOWED_ORIGIN ||
  process.env.FRONTEND_URL ||
  "http://localhost:5173"
)
  .split(",")
  .map((value) => value.trim().replace(/\/$/, ""))
  .filter(Boolean);

const COOKIE = "cv_session";
const fields =
  "code, full_name, passport_number, date_of_birth, course_name, issue_date, status";
const codePattern = /^\d{9}$/;
const statuses = new Set(["valid", "expired", "revoked"]);

type Input = {
  full_name?: unknown;
  passport_number?: unknown;
  date_of_birth?: unknown;
  course_name?: unknown;
  issue_date?: unknown;
  status?: unknown;
};

function db() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

function normalize(row: Record<string, unknown>) {
  return {
    ...row,
    code: String(row.code),
    date_of_birth: row.date_of_birth
      ? new Date(String(row.date_of_birth)).toISOString().slice(0, 10)
      : null,
    issue_date: row.issue_date
      ? new Date(String(row.issue_date)).toISOString().slice(0, 10)
      : null,
  };
}

function digest(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function cookieOptions() {
  const crossOrigin = origins.some((origin) => !origin.includes("localhost"));

  return {
    httpOnly: true,
    secure: crossOrigin || process.env.NODE_ENV === "production",
    sameSite: crossOrigin ? ("none" as const) : ("lax" as const),
    path: "/",
    maxAge: 7 * 86400000,
  };
}

function validate(input: Input) {
  if (
    typeof input.full_name !== "string" ||
    !input.full_name.trim() ||
    typeof input.course_name !== "string" ||
    !input.course_name.trim()
  ) {
    throw new Error("Full name and course are required.");
  }

  for (const field of ["date_of_birth", "issue_date"] as const) {
    if (
      input[field] &&
      (typeof input[field] !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(input[field] as string))
    ) {
      throw new Error(`Invalid ${field}.`);
    }
  }

  if (input.status && !statuses.has(String(input.status))) {
    throw new Error("Invalid status.");
  }
}

async function currentAdmin(req: Request) {
  const token = req.cookies?.[COOKIE];

  if (!token) return null;

  const result = await db().query(
    "SELECT a.id, a.email FROM admin_sessions s JOIN admins a ON a.id=s.admin_id WHERE s.token_hash=$1 AND s.expires_at > NOW() LIMIT 1",
    [digest(token)]
  );

  return (
    (result.rows[0] as { id: number; email: string } | undefined) ?? null
  );
}

app.disable("x-powered-by");

app.use((req, res, next) => {
  const origin = req.headers.origin?.replace(/\/$/, "");

  if (origin && origins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,DELETE,OPTIONS"
  );

  if (req.method === "OPTIONS") return res.sendStatus(204);

  next();
});

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/api", (_req, _res, next) => {
  try {
    db();
    next();
  } catch (error) {
    next(error);
  }
});

app.get("/api/verify", async (req, res, next) => {
  try {
    const code = String(req.query.code || "");

    if (!codePattern.test(code)) {
      return res.status(404).json({ error: "Certificate not found" });
    }

    const result = await db().query(
      `SELECT ${fields} FROM certificates WHERE code=$1 LIMIT 1`,
      [code]
    );

    return result.rows[0]
      ? res.json({
          valid: true,
          certificate: normalize(result.rows[0]),
        })
      : res.status(404).json({ error: "Certificate not found" });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/login", async (req, res, next) => {
  try {
    const email =
      typeof req.body?.email === "string"
        ? req.body.email.trim().toLowerCase()
        : "";

    const password =
      typeof req.body?.password === "string" ? req.body.password : "";

    const result = await db().query(
      "SELECT id, email, password_hash FROM admins WHERE email=$1 LIMIT 1",
      [email]
    );

    const admin = result.rows[0] as
      | { id: number; email: string; password_hash: string }
      | undefined;

    if (
      !admin ||
      !(await verifyPassword(password, admin.password_hash))
    ) {
      return res.status(401).json({ error: "Invalid admin credentials." });
    }

    const value = crypto.randomBytes(32).toString("hex");

    await db().query(
      "INSERT INTO admin_sessions (admin_id, token_hash, expires_at) VALUES ($1,$2,$3)",
      [admin.id, digest(value), new Date(Date.now() + 7 * 86400000)]
    );

    res.cookie(COOKIE, value, cookieOptions());

    return res.json({
      authenticated: true,
      admin: { email: admin.email },
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/logout", async (req, res, next) => {
  try {
    const token = req.cookies?.[COOKIE];

    if (token) {
      await db().query(
        "DELETE FROM admin_sessions WHERE token_hash=$1",
        [digest(token)]
      );
    }

    res.clearCookie(COOKIE, {
      ...cookieOptions(),
      maxAge: 0,
    });

    return res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/me", async (req, res, next) => {
  try {
    const admin = await currentAdmin(req);

    return res
      .status(admin ? 200 : 401)
      .json(
        admin
          ? {
              authenticated: true,
              admin: { email: admin.email },
            }
          : { authenticated: false }
      );
  } catch (error) {
    next(error);
  }
});

app.use("/api/admin/certificates", async (req, res, next) => {
  try {
    if (!(await currentAdmin(req))) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const code = req.path.match(/^\/(\d{9})$/)?.[1];

    if (req.method === "GET" && req.path === "/") {
      const result = await db().query(
        `SELECT ${fields} FROM certificates ORDER BY created_at DESC`
      );

      return res.json({
        certificates: result.rows.map(normalize),
      });
    }

    if (req.method === "POST" && req.path === "/") {
      validate(req.body as Input);

      for (let attempt = 0; attempt < 10; attempt += 1) {
        const generated = String(
          100000000 + Math.floor(Math.random() * 900000000)
        );

        try {
          const result = await db().query(
            `INSERT INTO certificates
              (code, full_name, passport_number, date_of_birth, course_name, issue_date, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             RETURNING ${fields}`,
            [
              generated,
              String(req.body.full_name).trim(),
              req.body.passport_number
                ? String(req.body.passport_number).trim()
                : null,
              req.body.date_of_birth || null,
              String(req.body.course_name).trim(),
              req.body.issue_date || null,
              req.body.status || "valid",
            ]
          );

          return res.status(201).json({
            certificate: normalize(result.rows[0]),
          });
        } catch (error) {
          if (!String(error).toLowerCase().includes("unique")) {
            throw error;
          }
        }
      }

      return res.status(409).json({
        error: "Could not allocate a unique certificate code.",
      });
    }

    if (!code) {
      return res.status(404).json({ error: "Not found" });
    }

    if (req.method === "GET") {
      const result = await db().query(
        `SELECT ${fields} FROM certificates WHERE code=$1`,
        [code]
      );

      return result.rows[0]
        ? res.json({
            certificate: normalize(result.rows[0]),
          })
        : res.status(404).json({
            error: "Certificate not found",
          });
    }

    if (req.method === "PUT") {
      validate(req.body as Input);

      const result = await db().query(
        `UPDATE certificates
         SET full_name=$1,
             passport_number=$2,
             date_of_birth=$3,
             course_name=$4,
             issue_date=$5,
             status=$6
         WHERE code=$7
         RETURNING ${fields}`,
        [
          String(req.body.full_name).trim(),
          req.body.passport_number
            ? String(req.body.passport_number).trim()
            : null,
          req.body.date_of_birth || null,
          String(req.body.course_name).trim(),
          req.body.issue_date || null,
          req.body.status || "valid",
          code,
        ]
      );

      return result.rows[0]
        ? res.json({
            certificate: normalize(result.rows[0]),
          })
        : res.status(404).json({
            error: "Certificate not found",
          });
    }

    if (req.method === "DELETE") {
      const result = await db().query(
        "DELETE FROM certificates WHERE code=$1 RETURNING code",
        [code]
      );

      return result.rowCount
        ? res.json({ ok: true })
        : res.status(404).json({
            error: "Certificate not found",
          });
    }

    return res.status(405).json({
      error: "Method not allowed",
    });
  } catch (error) {
    next(error);
  }
});

async function verifyPassword(password: string, stored: string) {
  const [, iterations, salt, expected] = stored.split("$");

  if (!iterations || !salt || !expected) return false;

  const derived = await new Promise<Buffer>((resolve, reject) =>
    crypto.pbkdf2(
      password,
      salt,
      Number(iterations),
      32,
      "sha256",
      (error, key) => (error ? reject(error) : resolve(key))
    )
  );

  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    derived
  );
}

app.use(
  (
    error: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    console.error(error);

    const message =
      error instanceof Error && /required|invalid/i.test(error.message)
        ? error.message
        : "Internal server error";

    res.status(500).json({ error: message });
  }
);

app.listen(port, "0.0.0.0", () =>
  console.log(`Certificate API listening on 0.0.0.0:${port}`)
);

export { app };
