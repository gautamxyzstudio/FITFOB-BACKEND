import crypto from "crypto";

const CLIENT_UID = "api::client-detail.client-detail";

/* -------- GENERATE CL-123-456-789 STYLE -------- */
function buildFormattedId() {
  const numbers = crypto.randomInt(100000000, 999999999).toString();
  // 9 digit number

  return `CL-${numbers.slice(0, 3)}-${numbers.slice(3, 6)}-${numbers.slice(6, 9)}`;
}

/* -------- UNIQUE CLIENT ID -------- */
export async function generateClientId() {
  while (true) {
    const clientId = buildFormattedId();

    const exists = await strapi.db.query(CLIENT_UID).findOne({
      where: { clientId },
      select: ["id"],
    });

    if (!exists) return clientId;
  }
}

/* -------- MAIN -------- */
export async function generateClientAssets() {
  const clientId = await generateClientId();
  return { clientId };
}