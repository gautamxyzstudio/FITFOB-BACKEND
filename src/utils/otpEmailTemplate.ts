const FITFOB_LOGO_SVG = `data:image/svg+xml,%3csvg%20xmlns='http://www.w3.org/2000/svg'%20width='42'%20height='44'%20viewBox='0%200%2042%2044'%20fill='none'%3e%3cpath%20d='M37.5199%2024.1068C37.4813%2023.9793%2037.472%2023.8517%2037.492%2023.7241C37.5306%2023.4196%2037.7208%2023.1741%2037.9017%2022.9382C40.7126%2019.2141%2042.0855%2014.3599%2041.6572%209.65234C41.4762%207.69773%2040.9614%205.70197%2039.7801%204.14926C38.0361%201.87917%2035.1201%200.906665%2032.3278%200.592556C29.5355%200.278447%2026.686%200.49517%2023.9123%200.00274599V6.10524C26.0568%206.05586%2028.2384%206.00648%2030.307%206.6059C32.3756%207.19571%2034.3485%208.5413%2035.2052%2010.5659C36.2255%2012.9539%2034.4815%2019.0564%2032.9943%2021.1688C29.3532%2018.2005%2025.3131%2017.1292%2020.6624%2017.1292C16.0303%2017.1388%2012.1139%2018.3678%208.48218%2021.3347C7.02417%2019.232%205.52757%2013.0019%206.50933%2010.6235C7.35806%208.57971%209.34022%207.21353%2011.4075%206.61412C13.4854%206.0051%2015.6777%206.05311%2017.8315%206.10249C17.8408%204.06833%2017.8408%202.03416%2017.8408%200C17.2209%200.0493796%2016.6023%200.0877859%2015.9731%200.137166C15.3531%200.176944%2014.7346%200.226322%2014.1146%200.264728C13.4947%200.314108%2012.8761%200.352514%2012.2562%200.401894C11.627%200.441672%2011.0084%200.491051%2010.3885%200.529457C9.87365%200.569235%209.35884%200.62685%208.84401%200.706406C8.34781%200.774989%207.85293%200.864148%207.36737%200.98211C6.88181%201.09047%206.39491%201.22764%205.92798%201.39498C5.46104%201.55272%205.00342%201.74886%204.56575%201.97519C4.1374%202.20151%203.71705%202.46624%203.32727%202.77075C3.07052%202.96689%202.82175%203.19321%202.59294%203.41954C0.677312%205.37414%200.0108334%208.30263%200.000191055%2011.0747C-0.0184331%2015.2898%201.32515%2019.5063%203.77423%2022.8861C3.99373%2023.1906%204.24117%2023.5253%204.24117%2023.908C4.24117%2024.2221%204.08819%2024.4978%203.94585%2024.7721C1.02052%2030.2354%201.18147%2036.8495%201.70561%2043.07C1.72423%2043.2565%201.7442%2043.4623%201.88655%2043.5912C2.01958%2043.7188%202.22976%2043.7284%202.42%2043.7188C4.19328%2043.6598%205.97456%2043.6104%207.74785%2043.5514C7.94739%2043.5418%208.17619%2043.5322%208.32917%2043.3937C8.55798%2043.1975%208.54866%2042.8437%208.5194%2042.5488C8.03384%2037.3694%207.28091%2029.8527%209.53976%2025.2042C17.6972%2028.4276%2022.1483%2028.9186%2031.9939%2024.9875C34.5959%2029.4097%2033.6714%2037.3008%2033.2324%2042.45C33.2044%2042.7943%2033.2044%2043.2168%2033.4798%2043.4225C33.6421%2043.5405%2033.851%2043.5501%2034.0518%2043.5597C35.8052%2043.609%2037.5492%2043.657%2039.3025%2043.716C39.5021%2043.716%2039.7216%2043.716%2039.8746%2043.5789C39.9983%2043.4417%2040.0275%2043.2456%2040.0461%2043.0576C40.5703%2036.8276%2040.7126%2030.2148%2037.7966%2024.7405C37.6915%2024.5348%2037.5771%2024.3181%2037.5199%2024.1014V24.1068ZM20.8606%2025.8763C15.409%2025.8763%2010.9964%2024.314%2010.9964%2022.3676C10.9964%2020.4212%2015.409%2018.8603%2020.8606%2018.8603C26.3121%2018.8603%2030.7341%2020.4322%2030.7341%2022.3676C30.7341%2024.303%2026.3121%2025.8763%2020.8606%2025.8763Z'%20fill='%23E23744'%20style='fill:%23E23744;fill:color(display-p3%200.8863%200.2157%200.2667);fill-opacity:1;'/%3e%3c/svg%3e`;

interface OtpEmailOptions {
  title?: string;
  subtext?: string;
  validityMinutes?: number;
}

export const getOtpEmailTemplate = (
  otp: string,
  options?: OtpEmailOptions
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
            <td style="padding: 32px 32px 24px 32px; text-align: center; border-bottom: 1px solid #f0f0f0;">
              <table role="presentation" align="center" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="center" style="padding-bottom: 8px;">
                    <img src="${FITFOB_LOGO_SVG}" alt="FitFob Logo" width="42" height="44" style="display: block; margin: 0 auto; border: 0;" />
                  </td>
                </tr>
                <tr>
                  <td align="center" style="font-size: 24px; font-weight: 700; color: #1a1d1e; letter-spacing: -0.5px;">
                    FitFob
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
