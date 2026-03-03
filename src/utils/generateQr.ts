import QRCode from "qrcode";

export async function generateQR(clientId: string) {
  return await QRCode.toDataURL(clientId, {
    errorCorrectionLevel: "H",
    type: "image/png",
    width: 300,
  });
}