import speakeasy from "speakeasy";
import QRCode from "qrcode";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { cognitoLogin } from "../../../services/cognito-auth";
import { createCognitoUser } from "../../../services/cognito-provision";
import { addUserToCognitoGroup } from "../../../services/cognito-groups";
import { generateClientId } from "../../../utils/generateClientId";
import { sendTwilioOtp } from "../../../services/twilio-sms";
import { v4 as uuidv4 } from "uuid";

/* ================= PHONE + EMAIL HELPERS (SAFE) ================= */

// email detector
const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

// phone formatter
const formatPhone = (value: string): string => {
  if (!value) return value;

  const digits = value.replace(/\D/g, "");

  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (value.startsWith("+91")) return value;

  return value;
};

// extract clean 10 digits
const extract10Digits = (value: string): string => {
  if (!value) return "";
  return value.replace(/\D/g, "").slice(-10);
};

/* ================= CLIENT DETAIL DATA POPULATOR ================= */
async function getClientDetailData(userId: number, userEmail?: string, userPhone?: string) {
  try {
    const userWithClientDetail: any = await strapi.db
      .query("plugin::users-permissions.user")
      .findOne({
        where: { id: userId },
        populate: {
          client_detail: {
            populate: {
              selfieUpload: true,
              local_subscriptions: {
                populate: {
                  local_membership_plan: {
                    populate: ["club_owner"],
                  },
                  membership_plan_price: {
                    populate: ["membership_tier"],
                  },
                  club_owner: true,
                },
              },
              outdoor_subscriptions: true,
            },
          },
        },
      });

    const detail = userWithClientDetail?.client_detail;
    if (!detail) return null;

    const getUniqueSubscriptions = (subscriptions: any[] = []) => {
      const uniqueMap = new Map<string, any>();
      for (const subscription of subscriptions) {
        const key = subscription.documentId ?? String(subscription.id);
        const existing = uniqueMap.get(key);
        if (!existing) {
          uniqueMap.set(key, subscription);
          continue;
        }
        if (!existing.publishedAt && subscription.publishedAt) {
          uniqueMap.set(key, subscription);
        }
      }
      return Array.from(uniqueMap.values());
    };

    const localSubscriptions = await Promise.all(
      getUniqueSubscriptions(detail.local_subscriptions).map(
        async (sub: any) => {
          let clubName =
            sub.local_membership_plan?.club_owner?.clubName ||
            sub.local_membership_plan?.club_owner?.club_name ||
            sub.club_owner?.clubName ||
            sub.club_owner?.club_name ||
            null;

          if (!clubName && (sub.local_membership_plan || sub.id)) {
            const planId =
              typeof sub.local_membership_plan === "object"
                ? sub.local_membership_plan?.id ||
                  sub.local_membership_plan?.documentId
                : sub.local_membership_plan;

            if (planId) {
              const plan: any = await strapi.db
                .query("api::local-membership-plan.local-membership-plan")
                .findOne({
                  where:
                    typeof planId === "number"
                      ? { id: planId }
                      : { documentId: planId },
                  populate: ["club_owner"],
                });

              clubName =
                plan?.club_owner?.clubName ||
                plan?.club_owner?.club_name ||
                null;
            }

            if (!clubName && sub.id) {
              const fullSub: any = await strapi.db
                .query("api::local-subscription.local-subscription")
                .findOne({
                  where: { id: sub.id },
                  populate: {
                    local_membership_plan: {
                      populate: ["club_owner"],
                    },
                    club_owner: true,
                  },
                });

              clubName =
                fullSub?.local_membership_plan?.club_owner?.clubName ||
                fullSub?.local_membership_plan?.club_owner?.club_name ||
                fullSub?.club_owner?.clubName ||
                fullSub?.club_owner?.club_name ||
                null;
            }
          }

          const planTitle =
            sub.membership_plan_price?.title ||
            sub.membership_plan_price?.membership_tier?.name ||
            sub.local_membership_plan?.name ||
            sub.local_membership_plan?.title ||
            null;

          return {
            id: sub.id,
            documentId: sub.documentId,
            startDate: sub.startDate,
            endDate: sub.endDate,
            subscriptionStatus: sub.subscriptionStatus,
            claimStatus: sub.claimStatus,
            paymentStatus: sub.paymentStatus,
            planTitle,
            clubName,
          };
        },
      ),
    );

    const outdoorSubscriptions = getUniqueSubscriptions(
      detail.outdoor_subscriptions,
    ).map((sub: any) => ({
      totalVisitsAllowed: sub.totalVisitsAllowed,
      totalVisits: sub.totalVisitsAllowed,
      usedVisits: sub.usedVisits,
      remainingVisits: sub.remainingVisits,
      subscriptionStatus: sub.subscriptionStatus,
    }));

    return {
      email: detail.email ?? userEmail,
      phone: detail.phoneNumber ?? userPhone,
      selfieUrl: detail.selfieUpload?.url ?? null,
      clientId: detail.clientId,
      name: detail.name ?? null,
      outdoor_subscriptions: outdoorSubscriptions,
      local_subscriptions: localSubscriptions,
    };
  } catch (err) {
    strapi.log.error("[getClientDetailData] Error fetching client detail:", err);
    return null;
  }
}

export default {
  /**
   * POST /api/login/send-otp
   * Payload: { "identifier": "+917018235911", "role": "client" } (or { "identifier": "7018235911", "role": "client" })
   */
  async sendOtp(ctx: any) {
    try {
      const body = (ctx.request.body as any)?.data || ctx.request.body || {};
      let identifier = body.identifier || body.phoneNumber || body.phone;
      const role = (body.role || "client").trim().toLowerCase();

      if (!identifier) {
        return ctx.badRequest("Identifier (phone number) is required");
      }

      identifier = String(identifier).trim();
      const clean10 = extract10Digits(identifier);

      if (clean10.length !== 10) {
        return ctx.badRequest("Please provide a valid 10-digit mobile number");
      }

      const formattedPhone = `+91${clean10}`;
      strapi.log.info(`[LOGIN SEND-OTP] Processing OTP request for: ${formattedPhone}`);

      // Check if client detail or offline member exists
      const phoneVariants = [formattedPhone, clean10, `91${clean10}`];
      const clientDetail = await strapi.db
        .query("api::client-detail.client-detail")
        .findOne({
          where: {
            phoneNumber: { $in: phoneVariants },
          },
        });

      // Generate 6-digit OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const otpHash = await bcrypt.hash(otp, 10);
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      // Delete older OTP records for this phone number
      await strapi.db.query("api::otp-request.otp-request").deleteMany({
        where: {
          identifier: { $in: phoneVariants },
        },
      });

      // Save new OTP request
      await strapi.db.query("api::otp-request.otp-request").create({
        data: {
          identifier: formattedPhone,
          otp_hash: otpHash,
          purpose: "login",
          expires_at: expiresAt,
          attempts: 0,
          verified: false,
          last_sent_at: new Date(),
        },
      });

      // Send OTP via Twilio SMS
      let twilioSent = false;
      let twilioError: string | null = null;
      try {
        await sendTwilioOtp(formattedPhone, otp);
        twilioSent = true;
        strapi.log.info(`[LOGIN SEND-OTP] Twilio OTP sent to ${formattedPhone}`);
      } catch (smsErr: any) {
        twilioError = smsErr?.message || "Twilio dispatch error";
        strapi.log.warn(
          `[LOGIN SEND-OTP] Failed to send Twilio SMS to ${formattedPhone}: ${twilioError}`,
        );
      }

      return ctx.send({
        success: true,
        message: `OTP sent successfully to ${formattedPhone}`,
        identifier: formattedPhone,
        role: "client",
        isOfflineMember: !!clientDetail,
        ...(process.env.NODE_ENV !== "production" && {
          devOtp: otp,
          twilioSent,
          twilioError,
        }),
      });
    } catch (err: any) {
      strapi.log.error("[LOGIN SEND-OTP] Error:", err);
      return ctx.internalServerError({
        message: err?.message || "Failed to send OTP",
      });
    }
  },

  /**
   * POST /api/login/verify-otp
   * Payload: { "identifier": "+917018235911", "otp": "123456", "role": "client" }
   */
  async verifyOtp(ctx: any) {
    try {
      const body = (ctx.request.body as any)?.data || ctx.request.body || {};
      let identifier = body.identifier || body.phoneNumber || body.phone;
      const otp = body.otp || body.code;
      const role = (body.role || "client").trim().toLowerCase();

      if (!identifier || !otp) {
        return ctx.badRequest("Identifier and OTP are required");
      }

      identifier = String(identifier).trim();
      const clean10 = extract10Digits(identifier);

      if (clean10.length !== 10) {
        return ctx.badRequest("Please provide a valid 10-digit mobile number");
      }

      const formattedPhone = `+91${clean10}`;
      const phoneVariants = [formattedPhone, clean10, `91${clean10}`];

      strapi.log.info(`[LOGIN VERIFY-OTP] Verifying OTP for: ${formattedPhone}`);

      // Fetch latest active OTP request for this phone
      const records: any[] = await strapi.entityService.findMany(
        "api::otp-request.otp-request",
        {
          filters: {
            identifier: { $in: phoneVariants },
          },
          sort: { id: "desc" },
          limit: 1,
        },
      );

      const record = records?.[0];
      if (!record) {
        return ctx.badRequest("No OTP request found. Please request a new OTP.");
      }

      // Check expiry
      if (Date.now() >= new Date(record.expires_at).getTime()) {
        await strapi.entityService.delete("api::otp-request.otp-request", record.id);
        return ctx.badRequest("OTP expired. Please request a new OTP.");
      }

      // Check max attempts
      if ((record.attempts || 0) >= 5) {
        await strapi.entityService.delete("api::otp-request.otp-request", record.id);
        return ctx.badRequest("Too many failed attempts. Please request a new OTP.");
      }

      // Validate OTP hash
      const isValid = await bcrypt.compare(String(otp).trim(), record.otp_hash);
      if (!isValid) {
        await strapi.entityService.update("api::otp-request.otp-request", record.id, {
          data: { attempts: (record.attempts || 0) + 1 },
        });
        return ctx.badRequest("Invalid OTP");
      }

      // OTP is valid -> delete consumed record
      await strapi.entityService.delete("api::otp-request.otp-request", record.id);

      // Check if Strapi user exists
      let user: any = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
          where: {
            $or: [
              { phoneNumber: { $in: phoneVariants } },
              { username: { $in: phoneVariants } },
            ],
          },
          populate: ["role"],
        });

      // Find client_detail (e.g. created by club owner during offline onboarding)
      let clientDetail: any = await strapi.db
        .query("api::client-detail.client-detail")
        .findOne({
          where: {
            phoneNumber: { $in: phoneVariants },
          },
          populate: ["user"],
        });

      // If no user exists, auto-provision user as Client (Passwordless / Offline Member Flow)
      const randomPassword = crypto.randomBytes(16).toString("hex") + "Aa1!";
      let cognitoSub: string | null = user?.cognitoSub || null;

      if (!user) {
        let clientRole: any = await strapi.db
          .query("plugin::users-permissions.role")
          .findOne({
            where: { type: "client" },
          });

        if (!clientRole) {
          clientRole = await strapi.db
            .query("plugin::users-permissions.role")
            .findOne({
              where: { name: "Client" },
            });
        }

        if (!clientRole) {
          strapi.log.error("[LOGIN VERIFY-OTP] Client role not found in Strapi");
          return ctx.internalServerError("Client role configuration not found.");
        }

        const memberName = clientDetail?.name || "Client";
        const userService = strapi.plugin("users-permissions").service("user");

        user = await userService.add({
          username: formattedPhone,
          phoneNumber: formattedPhone,
          email: clientDetail?.email || `client_${clean10}@fitfob.client`,
          fullName: memberName,
          password: randomPassword,
          confirmed: true,
          provider: "local",
          role: clientRole.id,
          isVerified: true,
          verification_status: "approved",
        });

        strapi.log.info(
          `[LOGIN VERIFY-OTP] Created new Client user ${user.id} for ${formattedPhone}`,
        );

        // Provision user in Cognito
        try {
          const cognitoResult = await createCognitoUser(
            formattedPhone,
            randomPassword,
            formattedPhone,
            true,
          );
          if (cognitoResult?.sub) {
            cognitoSub = cognitoResult.sub;
            await addUserToCognitoGroup(cognitoSub, "Client");
            await strapi.db.query("plugin::users-permissions.user").update({
              where: { id: user.id },
              data: { cognitoSub },
            });
            user.cognitoSub = cognitoSub;
            strapi.log.info(
              `[LOGIN VERIFY-OTP] Cognito user saved with sub: ${cognitoSub}`,
            );
          }
        } catch (cognitoErr: any) {
          strapi.log.warn(
            `[LOGIN VERIFY-OTP] Cognito creation error: ${cognitoErr?.message || cognitoErr}`,
          );
        }
      } else if (!user.cognitoSub) {
        // User already existed in Strapi, but cognitoSub is missing
        try {
          const cognitoResult = await createCognitoUser(
            formattedPhone,
            randomPassword,
            formattedPhone,
            true,
          );
          if (cognitoResult?.sub) {
            cognitoSub = cognitoResult.sub;
            await addUserToCognitoGroup(cognitoSub, "Client");
            await strapi.db.query("plugin::users-permissions.user").update({
              where: { id: user.id },
              data: { cognitoSub },
            });
            user.cognitoSub = cognitoSub;
          }
        } catch (cognitoErr: any) {
          strapi.log.warn(
            `[LOGIN VERIFY-OTP] Cognito sync warning: ${cognitoErr?.message || cognitoErr}`,
          );
        }
      }

      // Link client_detail with user and ensure clientId is generated
      if (clientDetail) {
        let updateData: any = {};
        if (!clientDetail.user || clientDetail.user.id !== user.id) {
          updateData.user = user.id;
        }
        if (!clientDetail.clientId) {
          const newClientId = await generateClientId();
          updateData.clientId = newClientId;
          clientDetail.clientId = newClientId;
        }
        if (Object.keys(updateData).length > 0) {
          await strapi.db.query("api::client-detail.client-detail").update({
            where: { id: clientDetail.id },
            data: updateData,
          });
        }
      } else {
        const newClientId = await generateClientId();
        clientDetail = await strapi.db.query("api::client-detail.client-detail").create({
          data: {
            name: user.fullName || "Client",
            phoneNumber: formattedPhone,
            email:user.email,
            user: user.id,
            clientId: newClientId,
          },
        });
      }

      // Issue Strapi JWT
      const jwtService = strapi.plugin("users-permissions").service("jwt");
      const strapiJwt = jwtService.issue({ id: user.id }) as string;

      // Populate full clientDetail
      const fullClientDetail = await getClientDetailData(
        user.id,
        user.email,
        user.phoneNumber,
      );

      // Check for unclaimed pass (Flowchart 1 / Step 2 from process guide)
      const pendingSub: any = await strapi.db
        .query("api::local-subscription.local-subscription")
        .findOne({
          where: {
            $or: [
              { client_detail: clientDetail.id },
              { invitedPhone: { $in: phoneVariants } },
            ],
            claimStatus: "unclaimed",
          },
          populate: {
            club_owner: true,
            membership_plan_price: {
              populate: ["membership_tier"],
            },
            local_membership_plan: true,
          },
        });

      let pendingClaim: any = null;
      if (pendingSub) {
        const gymName =
          pendingSub.club_owner?.clubName ||
          pendingSub.club_owner?.club_name ||
          "Gym";
        const planName =
          pendingSub.membership_plan_price?.title ||
          pendingSub.membership_plan_price?.membership_tier?.name ||
          pendingSub.local_membership_plan?.name ||
          "Membership Plan";

        pendingClaim = {
          id: pendingSub.id,
          documentId: pendingSub.documentId,
          gymName,
          planName,
          startDate: pendingSub.startDate,
          endDate: pendingSub.endDate,
          claimStatus: pendingSub.claimStatus,
          claimUrl: `/api/client/claim-membership/${pendingSub.documentId || pendingSub.id}`,
        };
      }

      return ctx.send({
        jwt: strapiJwt,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          phoneNumber: user.phoneNumber,
          fullName: user.fullName || clientDetail?.name,
          role: user.role || { name: "Client", type: "client" },
          isVerified: true,
          verification_status: user.verification_status || "approved",
          cognitoSub: user.cognitoSub || cognitoSub || null,
          clientDetail: fullClientDetail,
        },
        pendingClaim,
        message: pendingClaim
          ? `Welcome ${clientDetail?.name || ""}! ${pendingClaim.gymName} has linked your active membership.`
          : "Login successful",
      });
    } catch (err: any) {
      strapi.log.error("[LOGIN VERIFY-OTP] Error:", err);
      return ctx.internalServerError({
        message: err?.message || "OTP verification failed",
      });
    }
  },

  async login(ctx: any) {
    try {
      const body = (ctx.request.body as any)?.data || ctx.request.body || {};
      let { identifier, password, otp } = body;
      identifier = identifier || body.phoneNumber || body.phone;

      // If user passed identifier & otp to /login -> delegate to verifyOtp
      if (identifier && (otp || body.code)) {
        return (this as any).verifyOtp(ctx);
      }

      // If user passed only identifier without password to /login -> delegate to sendOtp
      if (identifier && !password) {
        return (this as any).sendOtp(ctx);
      }

      if (!identifier || !password) {
        return ctx.badRequest("Identifier and password required");
      }

      /* ========= NORMALIZE IDENTIFIER ========= */

      identifier = identifier.trim();

      if (isEmail(identifier)) identifier = identifier.toLowerCase();
      else identifier = formatPhone(identifier);

      /* ========= FIND USER ========= */

      let user: any;

      if (isEmail(identifier)) {
        const users = await strapi.entityService.findMany(
          "plugin::users-permissions.user",
          {
            filters: { email: identifier },
            populate: ["role"],
          },
        );

        user = users[0];
      } else {
        strapi.log.info(`[LOGIN] Searching phone: ${identifier}`);

        const users = await strapi.entityService.findMany(
          "plugin::users-permissions.user",
          {
            filters: { phoneNumber: identifier },
            populate: ["role"],
          },
        );

        user = users[0];
      }

      if (!user) return ctx.badRequest("User not found");
      if (user.blocked) return ctx.badRequest("User is blocked");

      /* ======================================================
         🔐 VERY IMPORTANT — VERIFY STRAPI PASSWORD FIRST
         This DOES NOT affect Cognito login.
         It only prevents MFA bypass.
      ====================================================== */

      const validPassword = await strapi
        .plugin("users-permissions")
        .service("user")
        .validatePassword(password, user.password);

      if (!validPassword) {
        return ctx.unauthorized("Invalid credentials");
      }

      /* ======================================================
         🔐 ADMIN MFA SYSTEM (QR SETUP + OTP LOGIN)
      ====================================================== */

      if (user.role?.name === "Admin") {
        // ---------- FIRST TIME LOGIN (NO MFA YET) ----------
        if (!user.mfa_secret) {
          // create secret for authenticator
          const secret = speakeasy.generateSecret({
            length: 20,
            name: `FitFob (${user.email})`,
            issuer: "FitFob",
          });

          // store temporary secret (NOT ACTIVE YET)
          await strapi.entityService.update(
            "plugin::users-permissions.user",
            user.id,
            {
              data: { mfa_temp_secret: secret.base32 },
            },
          );

          // generate QR code
          const qr = await QRCode.toDataURL(secret.otpauth_url);

          // tell frontend to scan
          return ctx.send({
            mfaSetup: true,
            qr,
          });
        }

        // ---------- MFA ALREADY ENABLED (NORMAL ADMIN LOGIN) ----------
        const tempToken = uuidv4();

        await strapi.entityService.update(
          "plugin::users-permissions.user",
          user.id,
          {
            data: {
              mfa_temp_token: tempToken,
              mfa_identifier: identifier,
            },
          },
        );

        return ctx.send({
          mfaRequired: true,
          tempToken,
        });
      }

      /* ======================================================
         NORMAL USERS → CONTINUE OLD FLOW 
      ====================================================== */

      let tokens;
      try {
        tokens = await cognitoLogin(identifier, password);
      } catch (err) {
        strapi.log.error("COGNITO LOGIN FAILED");
        strapi.log.error(err);
        return ctx.unauthorized("Invalid credentials");
      }

      const jwtService = strapi.plugin("users-permissions").service("jwt");
      const strapiJwt = jwtService.issue({ id: user.id }) as string;
      /* ======================================================
               GET USER ROLE
            ====================================================== */

      const roleName = user.role?.name?.toLowerCase();

      let clientDetail: any = null;
      let clubOwnerDetail: any = null;

      /* ======================================================
        CLIENT ROLE → GET CLIENT DETAIL
     ====================================================== */

      if (roleName === "client") {
        const userWithClientDetail: any = await strapi.db
          .query("plugin::users-permissions.user")
          .findOne({
            where: {
              id: user.id,
            },

            populate: {
              client_detail: {
                populate: {
                  selfieUpload: true,
                  local_subscriptions: {
                    populate: {
                      local_membership_plan: {
                        populate: {
                          club_owner: true,
                        },
                      },
                      club_owner: true,
                    },
                  },
                  outdoor_subscriptions: true,
                },
              },
            },
          });

        const detail = userWithClientDetail?.client_detail;

        if (detail) {
          const getUniqueSubscriptions = (subscriptions: any[] = []) => {
            const uniqueMap = new Map<string, any>();

            for (const subscription of subscriptions) {
              const key = subscription.documentId ?? String(subscription.id);

              const existing = uniqueMap.get(key);

              if (!existing) {
                uniqueMap.set(key, subscription);
                continue;
              }

              if (!existing.publishedAt && subscription.publishedAt) {
                uniqueMap.set(key, subscription);
              }
            }

            return Array.from(uniqueMap.values());
          };

          const localSubscriptions = await Promise.all(
            getUniqueSubscriptions(detail.local_subscriptions).map(
              async (sub: any) => {
                let clubName =
                  sub.local_membership_plan?.club_owner?.clubName ||
                  sub.local_membership_plan?.club_owner?.club_name ||
                  sub.club_owner?.clubName ||
                  sub.club_owner?.club_name ||
                  null;

                if (!clubName && (sub.local_membership_plan || sub.id)) {
                  const planId =
                    typeof sub.local_membership_plan === "object"
                      ? sub.local_membership_plan?.id ||
                        sub.local_membership_plan?.documentId
                      : sub.local_membership_plan;

                  if (planId) {
                    const plan: any = await strapi.db
                      .query("api::local-membership-plan.local-membership-plan")
                      .findOne({
                        where:
                          typeof planId === "number"
                            ? { id: planId }
                            : { documentId: planId },
                        populate: ["club_owner"],
                      });

                    clubName =
                      plan?.club_owner?.clubName ||
                      plan?.club_owner?.club_name ||
                      null;
                  }

                  if (!clubName && sub.id) {
                    const fullSub: any = await strapi.db
                      .query("api::local-subscription.local-subscription")
                      .findOne({
                        where: { id: sub.id },
                        populate: {
                          local_membership_plan: {
                            populate: ["club_owner"],
                          },
                          club_owner: true,
                        },
                      });

                    clubName =
                      fullSub?.local_membership_plan?.club_owner?.clubName ||
                      fullSub?.local_membership_plan?.club_owner?.club_name ||
                      fullSub?.club_owner?.clubName ||
                      fullSub?.club_owner?.club_name ||
                      null;
                  }
                }

                return {
                  startDate: sub.startDate,
                  endDate: sub.endDate,
                  subscriptionStatus: sub.subscriptionStatus,
                  clubName,
                };
              },
            ),
          );

          const outdoorSubscriptions = getUniqueSubscriptions(
            detail.outdoor_subscriptions,
          ).map((sub: any) => ({
            totalVisitsAllowed: sub.totalVisitsAllowed,
            totalVisits: sub.totalVisitsAllowed,
            usedVisits: sub.usedVisits,
            remainingVisits: sub.remainingVisits,
            subscriptionStatus: sub.subscriptionStatus,
          }));

          clientDetail = {
            email: detail.email ?? user.email,

            phone: detail.phoneNumber ?? user.phoneNumber,

            selfieUrl: detail.selfieUpload?.url ?? null,

            clientId: detail.clientId,

            name: detail.name ?? null,

            outdoor_subscriptions: outdoorSubscriptions,

            local_subscriptions: localSubscriptions,
          };
        }
      } else if (roleName === "clubowner") {
        /* ======================================================
         CLUB OWNER ROLE → GET CLUB OWNER DETAIL
      ====================================================== */
        const userWithClubOwnerDetail: any = await strapi.db
          .query("plugin::users-permissions.user")
          .findOne({
            where: {
              id: user.id,
            },

            populate: {
              club_owner: {
                populate: {
                  logo: true,
                },
              },
            },
          });

        const detail = userWithClubOwnerDetail?.club_owner;

        if (detail) {
          clubOwnerDetail = {
            clubId: detail.clubId,
            ownerName: detail.ownerName ?? null,
            clubName: detail.clubName ?? null,
            logoUrl: detail.logo?.url ?? null,
            phoneNumber: detail.phoneNumber ?? user.phoneNumber,
            email: detail.email ?? user.email,
          };
        }
      }

      ctx.body = {
        jwt: strapiJwt,
        cognito: {
          accessToken: tokens!.AccessToken,
          idToken: tokens!.IdToken,
          refreshToken: tokens!.RefreshToken,
          expiresIn: tokens!.ExpiresIn,
        },
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          phoneNumber: user.phoneNumber,
          isVerified: user.isVerified,
          verification_status: user.verification_status,
          cognitoSub: user.cognitoSub,
          confirmed: user.confirmed,
          blocked: user.blocked,
          role: user.role,
          ...((roleName === "admin" || roleName === "super-admin") && {
            fullName: user.fullName,
          }),
          // Only returned for Client
          ...(roleName === "client" && {
            clientDetail,
          }),

          // Only returned for ClubOwner
          ...(roleName === "clubowner" && {
            clubOwnerDetail,
          }),
        },
      };
    } catch (err) {
      strapi.log.error("CUSTOM LOGIN ERROR");
      strapi.log.error(err);
      ctx.internalServerError("Login failed");
    }
  },
};
