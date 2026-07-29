import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const SUPERADMIN_JWT_SECRET = process.env.SUPERADMIN_JWT_SECRET;

export interface AdminTokenPayload {
  adminId: string;
  usuario: string;
}

export function generarTokenAdmin(payload: AdminTokenPayload): string {
  if (!SUPERADMIN_JWT_SECRET) {
    throw new Error('SUPERADMIN_JWT_SECRET no está definida. Configúrala en el .env (local) o en las variables de Railway (producción).');
  }
  return jwt.sign(payload, SUPERADMIN_JWT_SECRET, { expiresIn: '12h' });
}

export function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token || !SUPERADMIN_JWT_SECRET) {
    return res.status(401).json({ error: 'No autorizado. Inicia sesión nuevamente.' });
  }

  try {
    jwt.verify(token, SUPERADMIN_JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Sesión inválida o expirada. Inicia sesión nuevamente.' });
  }
}
