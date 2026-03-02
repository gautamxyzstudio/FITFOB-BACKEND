import QRCode from "qrcode";
import crypto from "crypto";

const CLIENT_UID = "api::client-detail.client-detail";

/* -------- UNIQUE CLIENT ID -------- */
export async function generateClientId() {
  while (true) {
    const random = crypto.randomBytes(4).toString("hex").toUpperCase();
    const time = Date.now().toString(36).toUpperCase();
    const clientId = `CL-${time}-${random}`;

    // prevent duplicates
    const exists = await strapi.db.query(CLIENT_UID).findOne({
      where: { clientId },
      select: ["id"],
    });

    if (!exists) return clientId;
  }
}

/* -------- QR CODE -------- */
export async function generateClientQr(clientId: string) {
  return await QRCode.toDataURL(clientId, {
    errorCorrectionLevel: "H",
    width: 500,
    margin: 1,
  });
}

/* -------- MAIN -------- */
export async function generateClientAssets() {
  const clientId = await generateClientId();
  const qrCode = await generateClientQr(clientId);

  return { clientId, qrCode };
}