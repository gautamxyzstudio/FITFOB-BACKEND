const FITFOB_LOGO_SVG = "https://admin.fitfob.com/logo.png";
interface OtpEmailOptions {
  title?: string;
  subtext?: string;
  validityMinutes?: number;
}

export const getOtpEmailTemplate = (
  otp: string,
  options?: OtpEmailOptions,
): string => {
  const title = options?.title ?? "Password Reset Verification Code";
  const subtext =
    options?.subtext ??
    "We received a request to verify your FitFob account. Use the One-Time Password (OTP) below to proceed:";
  const validityMinutes = options?.validityMinutes ?? 2;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f6f8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1a1d1e;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #f4f6f8; padding: 40px 10px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 520px; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05); border: 1px solid #eaeaea;">
          
          <!-- Header -->
          <tr>
            <td style="padding: 12px 32px; text-align: center; border-bottom: 1px solid #f0f0f0;">
              <table role="presentation" align="center" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="center">
                    <img src="${FITFOB_LOGO_SVG}" alt="FitFob Logo" style="display: block; margin: 0 auto; border: 0; width:100px; height: 35px; object-fit: cover;" />
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Content Body -->
          <tr>
            <td style="padding: 32px; text-align: center;">
              <h1 style="margin: 0 0 12px 0; font-size: 20px; font-weight: 600; color: #1a1d1e;">
                ${title}
              </h1>
              <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 1.5; color: #5a6065;">
                ${subtext}
              </p>

              <!-- OTP Code Display Box -->
              <div style="background-color: #fdf2f4; border: 1.5px dashed #e23744; border-radius: 12px; padding: 20px 16px; margin-bottom: 20px;">
                <span style="font-family: 'Courier New', Courier, monospace; font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #e23744; display: block;">
                  ${otp}
                </span>
              </div>

              <!-- Expiration Notice -->
              <p style="margin: 0 0 24px 0; font-size: 13px; font-weight: 500; color: #7a828a;">
                ⏱️ This code is valid for <strong>${validityMinutes} minutes</strong>.
              </p>

              <hr style="border: none; border-top: 1px solid #f0f0f0; margin: 24px 0;" />

              <!-- Security Notice -->
              <p style="margin: 0; font-size: 12px; line-height: 1.4; color: #8c939b;">
                If you did not request this OTP, please ignore this email or contact support if you have concerns about your account security.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #fafbfc; padding: 20px 32px; text-align: center; border-top: 1px solid #f0f0f0;">
              <p style="margin: 0; font-size: 12px; color: #9aa0a6;">
                &copy; ${new Date().getFullYear()} FitFob. All rights reserved.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
};
