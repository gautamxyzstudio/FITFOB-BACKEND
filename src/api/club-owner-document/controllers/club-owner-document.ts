/**
 * club-owner-document controller
 */

import { factories } from "@strapi/strapi";
import { Context } from "koa";
import fs from "fs";
import crypto from "crypto";
import sharp from "sharp";

const CLUB_OWNER_DOCUMENT_UID = "api::club-owner-document.club-owner-document";
const UPLOAD_FOLDER_ID = 2;

/* ---------- GENERATE STRAPI V5 DOCUMENT ID ---------- */
function generateDocumentId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  const bytes = crypto.randomBytes(24);
  for (let i = 0; i < 24; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

/* ---------- ROLE HELPER (DIRECT SQL) ---------- */
async function getUserRole(userId: number, cachedRole?: any): Promise<string> {
  if (cachedRole?.name || cachedRole?.type) {
    return (
      cachedRole.name?.toLowerCase().replace(/[\s_-]+/g, "") ||
      cachedRole.type?.toLowerCase().replace(/[\s_-]+/g, "") ||
      ""
    );
  }

  try {
    const res = await strapi.db.connection.raw(
      `SELECT r.type, r.name 
       FROM up_roles r
       JOIN up_users_role_lnk lnk ON lnk.role_id = r.id
       WHERE lnk.user_id = ?
       LIMIT 1`,
      [userId]
    );
    const row = res?.rows?.[0];
    if (!row) return "";
    return (
      row.name?.toLowerCase().replace(/[\s_-]+/g, "") ||
      row.type?.toLowerCase().replace(/[\s_-]+/g, "") ||
      ""
    );
  } catch (err) {
    strapi.log.warn("[getUserRole] Direct SQL error:", err);
    return "";
  }
}

/* ---------- BODY PARSER HELPER ---------- */
function getBody(ctx: Context): any {
  let body: any = ctx.request.body || {};
  if (body.data) {
    if (typeof body.data === "string") {
      try {
        body = JSON.parse(body.data);
      } catch (_) {}
    } else if (typeof body.data === "object") {
      body = { ...body, ...body.data };
    }
  }
  return body;
}

/* ---------- OPTIMIZE IMAGE & UPDATE TEMP FILE ---------- */
async function prepareAndOptimizeImage(
  rawFile: any,
  maxWidth = 1600,
  quality = 85
): Promise<void> {
  const filePath = rawFile?.filepath || rawFile?.path;
  if (!filePath) return;

  try {
    const originalBuffer = await fs.promises.readFile(filePath);

    // If PDF, do not process with sharp
    const isPdf =
      rawFile.mimetype === "application/pdf" ||
      (rawFile.originalFilename &&
        rawFile.originalFilename.toLowerCase().endsWith(".pdf")) ||
      originalBuffer.subarray(0, 4).toString() === "%PDF";

    if (isPdf) return;

    const optimizedBuffer = await sharp(originalBuffer)
      .rotate() // auto-orient based on EXIF
      .resize({
        width: maxWidth,
        height: maxWidth,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality, mozjpeg: false })
      .toBuffer();

    await fs.promises.writeFile(filePath, optimizedBuffer);
    rawFile.size = optimizedBuffer.length;
    rawFile.mimetype = "image/jpeg";
  } catch (err) {
    strapi.log.warn("[prepareAndOptimizeImage] Optimization fallback to original:", err);
  }
}

/* ---------- FILE UPLOAD HELPER ---------- */
async function uploadToFolder(file: any): Promise<any[]> {
  const uploadService = strapi.plugin("upload").service("upload");
  const filesArray = Array.isArray(file) ? file : [file];
  const uploadedFiles: any[] = [];

  for (const f of filesArray) {
    try {
      const res = await uploadService.upload({
        data: { fileInfo: { folder: UPLOAD_FOLDER_ID } },
        files: f,
      });
      uploadedFiles.push(...res);
    } catch (_) {
      const res = await uploadService.upload({
        data: {},
        files: f,
      });
      uploadedFiles.push(...res);
    }
  }

  return uploadedFiles;
}

/* ---------- DOCUMENT NAME NORMALIZATION HELPER ---------- */
function normalizeDocumentIdentifier(name: string): { key: string; displayName: string } {
  if (!name || typeof name !== "string") {
    return { key: "", displayName: "" };
  }

  const clean = name.toLowerCase().replace(/[^a-z0-9]/g, "");

  // 1. Aadhaar variations (aadhar, aadhaar, adhaar, adhar, uidai, etc.)
  if (
    clean.includes("aadhaar") ||
    clean.includes("aadhar") ||
    clean.includes("adhaar") ||
    clean.includes("adhar") ||
    clean === "uidai" ||
    clean === "uid"
  ) {
    return { key: "aadhaar", displayName: "Aadhaar Card" };
  }

  // 2. PAN variations (pan, pancard, etc.)
  if (clean === "pan" || clean === "pancard" || clean.includes("permanentaccount")) {
    return { key: "pan", displayName: "PAN Card" };
  }

  // 3. Driving License variations (dl, driving licence, driver license, etc.)
  if (
    clean === "dl" ||
    clean.includes("drivinglicen") ||
    clean.includes("driverlicen")
  ) {
    return { key: "driving-license", displayName: "Driving License" };
  }

  // 4. Voter ID variations (voter, voter id, epic, election card, etc.)
  if (
    clean.includes("voter") ||
    clean.includes("epic") ||
    clean.includes("electioncard")
  ) {
    return { key: "voter-id", displayName: "Voter ID Card" };
  }

  // 5. Passport
  if (clean.includes("passport")) {
    return { key: "passport", displayName: "Passport" };
  }

  // 6. GST
  if (clean.includes("gst") || clean.includes("gstin")) {
    return { key: "gst", displayName: "GST Registration Certificate" };
  }

  // 7. Udyam / MSME
  if (clean.includes("udyam") || clean.includes("msme")) {
    return { key: "udyam-msme", displayName: "Udyam / MSME Certificate" };
  }

  // 8. Bank Statement / Cheque
  if (
    clean.includes("bankstatement") ||
    clean.includes("cheque") ||
    clean.includes("check")
  ) {
    return { key: "bank-statement-or-cheque", displayName: "Bank Statement / Cheque" };
  }

  // Fallback for custom document names:
  const stripped = clean
    .replace(/(card|document|doc|certificate|cert|id)$/g, "")
    .trim();

  return {
    key: stripped.length > 0 ? stripped : clean,
    displayName: name.trim(),
  };
}

export default factories.createCoreController(
  CLUB_OWNER_DOCUMENT_UID,
  ({ strapi }) => ({
    /**
     * POST /api/club-owner-documents
     * Fast direct PostgreSQL implementation for document creation with multipart/form-data.
     */
    async create(ctx: Context) {
      try {
        // 1. Authenticate user (state or Bearer token header)
        let user = ctx.state.user;

        if (!user && ctx.request?.header?.authorization?.startsWith("Bearer ")) {
          const token = ctx.request.header.authorization.slice(7).trim();
          try {
            const jwtService = strapi.plugin("users-permissions")?.service("jwt");
            if (jwtService?.verify) {
              const payload = await jwtService.verify(token);
              if (payload?.id) {
                user = { id: payload.id };
              }
            }
          } catch (_) {}
        }

        if (!user || !user.id) {
          return ctx.unauthorized("Authentication required. Please log in.");
        }

        // 2. Resolve role & target club owner via direct PostgreSQL queries
        const body = getBody(ctx);
        const roleName = await getUserRole(user.id, user.role);
        const isAdmin = roleName === "admin" || roleName === "superadmin";

        let targetOwner: any = null;

        if (isAdmin && (body.club_owner || ctx.query.club_owner)) {
          const rawOwner = String(body.club_owner || ctx.query.club_owner).trim();
          const isNumeric = /^\d+$/.test(rawOwner);
          const ownerRes = await strapi.db.connection.raw(
            `SELECT id, document_id, club_name, owner_name 
             FROM club_owners 
             WHERE ${isNumeric ? "id = ?" : "document_id = ?"} 
             LIMIT 1`,
            [isNumeric ? Number(rawOwner) : rawOwner]
          );
          targetOwner = ownerRes?.rows?.[0] || null;

          if (!targetOwner) {
            return ctx.notFound(`Club owner '${rawOwner}' not found`);
          }
        } else {
          // Query registered club owner for user via direct SQL
          const ownerRes = await strapi.db.connection.raw(
            `SELECT co.id, co.document_id, co.club_name, co.owner_name
             FROM club_owners co
             JOIN up_users_club_owner_lnk lnk ON lnk.club_owner_id = co.id
             WHERE lnk.user_id = ?
             LIMIT 1`,
            [user.id]
          );
          targetOwner = ownerRes?.rows?.[0] || null;

          if (!targetOwner) {
            return ctx.notFound("Club owner profile not found for this account.");
          }
        }

        // 3. Extract uploaded file from multipart form-data
        const files: any = ctx.request.files;
        const rawFile =
          files?.file ||
          files?.File ||
          files?.document ||
          files?.image ||
          files?.governmentDoc ||
          files?.governmentId ||
          files?.attachment;

        if (!rawFile) {
          return ctx.badRequest(
            "Please provide a document file in form-data (key: 'file' or 'File')"
          );
        }

        const targetFile = Array.isArray(rawFile) ? rawFile[0] : rawFile;

        // 4. Extract document name
        const rawDocName =
          body.documentName ||
          body.name ||
          body.document_name ||
          body.data?.documentName ||
          (ctx.request.body as any)?.documentName;

        if (!rawDocName || typeof rawDocName !== "string" || !rawDocName.trim()) {
          return ctx.badRequest(
            'Document name is required. Please provide "documentName" in form-data.'
          );
        }

        const incoming = normalizeDocumentIdentifier(rawDocName);
        const documentName = incoming.displayName;

        // 5. Check if a document with the same or equivalent name already exists (Direct SQL)
        const docsRes = await strapi.db.connection.raw(
          `SELECT d.id, d.document_name, lnk.club_owner_document_ord
           FROM club_owner_documents d
           JOIN club_owner_documents_club_owner_lnk lnk ON lnk.club_owner_document_id = d.id
           WHERE lnk.club_owner_id = ?`,
          [targetOwner.id]
        );
        const existingDocs: any[] = docsRes?.rows || [];

        const duplicate = existingDocs.find((doc: any) => {
          if (!doc?.document_name) return false;
          const existingNormalized = normalizeDocumentIdentifier(doc.document_name);
          return existingNormalized.key === incoming.key;
        });

        if (duplicate) {
          return ctx.badRequest(
            `Document with this name already exists: "${duplicate.document_name}".`
          );
        }

        // 6. Optimize image (if image file) and upload directly via Strapi upload service
        await prepareAndOptimizeImage(targetFile, 1600, 85);
        const uploadedFiles = await uploadToFolder(targetFile);
        if (!uploadedFiles || uploadedFiles.length === 0) {
          return ctx.internalServerError("Failed to store uploaded file");
        }

        const uploadedFile = uploadedFiles[0];
        const fileId = uploadedFile.id;

        // 7. Insert new document record & relations via Direct PostgreSQL queries
        const docId = generateDocumentId();
        const insertRes = await strapi.db.connection.raw(
          `INSERT INTO club_owner_documents (
            document_id, document_name, created_at, updated_at, published_at
          ) VALUES (?, ?, NOW(), NOW(), NOW())
          RETURNING id, document_id, created_at, updated_at`,
          [docId, documentName]
        );
        const newDoc = insertRes.rows[0];

        const nextOrder = existingDocs.length + 1;
        const linkQuery = strapi.db.connection.raw(
          `INSERT INTO club_owner_documents_club_owner_lnk (
            club_owner_document_id, club_owner_id, club_owner_document_ord
          ) VALUES (?, ?, ?)`,
          [newDoc.id, targetOwner.id, nextOrder]
        );

        const fileRelationQuery = strapi.db.connection.raw(
          `INSERT INTO files_related_mph (
            file_id, related_id, related_type, field, "order"
          ) VALUES (?, ?, 'api::club-owner-document.club-owner-document', 'File', 1)`,
          [fileId, newDoc.id]
        );

        await Promise.all([linkQuery, fileRelationQuery]);

        // 8. 📝 Log Activity asynchronously in background (non-blocking)
        setImmediate(async () => {
          try {
            const activityLogService: any = strapi.service(
              "api::club-owner-activity-log.club-owner-activity-log"
            );
            if (activityLogService?.logActivity) {
              const targetOwnerId = targetOwner.document_id || targetOwner.id;
              await activityLogService.logActivity({
                clubOwnerId: targetOwnerId,
                category: "profile",
                actionType: "CREATE",
                entityName: "Club Document",
                entityId: newDoc.document_id || targetOwnerId,
                description: `Uploaded document: ${documentName}`,
              });
            }
          } catch (logErr) {
            strapi.log.warn(
              "[ActivityLog] Failed to log document upload activity in background:",
              logErr
            );
          }
        });

        // 9. Format response matching previous exact shape
        const formattedFile = {
          id: uploadedFile.id,
          name: uploadedFile.name,
          url: uploadedFile.url,
          mime: uploadedFile.mime,
          size: uploadedFile.size,
        };

        return ctx.send(
          {
            message: "Document uploaded successfully",
            data: {
              id: newDoc.id,
              documentId: newDoc.document_id,
              documentName: documentName,
              file: formattedFile,
              createdAt: newDoc.created_at,
              updatedAt: newDoc.updated_at,
            },
          },
          201
        );
      } catch (error) {
        strapi.log.error("UPLOAD CLUB OWNER DOCUMENT ERROR:", error);
        return ctx.internalServerError("Failed to upload club owner document");
      }
    },
  })
);
