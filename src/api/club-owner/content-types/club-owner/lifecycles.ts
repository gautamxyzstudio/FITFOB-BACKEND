
import { randomBytes } from 'node:crypto';

const CLUB_CATEGORY_MAP: Record<string, string> = {
  Basic: 'basic',
  Premium: 'premium',
  Luxury: 'luxury',
};

const REQUIRED_DURATIONS = [
  'monthly',
  'six_months',
  'twelve_months',
];

const DEFAULT_PROMOTION_USER_LIMIT = 20;

const CLUB_OWNER_UID = 'api::club-owner.club-owner';
const GYM_CONTRACT_UID = 'api::gym-contract.gym-contract';

const GYM_CONTRACT_RATE_UID =
  'api::gym-contract-plan-rate.gym-contract-plan-rate';

const GYM_PROMOTION_UID =
  'api::gym-promotion.gym-promotion';

const MEMBERSHIP_TIER_UID =
  'api::membership-tier.membership-tier';

const MEMBERSHIP_PRICE_UID =
  'api::membership-plan-price.membership-plan-price';

/**
 * Generate a unique contract ID.
 * Example: GYM-CTR-20261105-A8F3C2D1
 */
function generateContractId(): string {
  const date = new Date()
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '');

  const randomCode = randomBytes(4)
    .toString('hex')
    .toUpperCase();

  return `GYM-CTR-${date}-${randomCode}`;
}

/**
 * Format date as YYYY-MM-DD.
 */
function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * Calculate contract end date one year after start date.
 */
function getContractEndDate(startDate: Date): Date {
  const endDate = new Date(startDate);

  endDate.setFullYear(
    endDate.getFullYear() + 1
  );

  return endDate;
}

export default {
  async afterCreate(event) {
    const clubOwnerId = event.result?.id;

    if (!clubOwnerId) {
      strapi.log.error(
        'Cannot create gym contract: club owner ID is missing.'
      );
      return;
    }

    try {
      // 1. Fetch newly created club owner
      const clubOwner = await strapi.db
        .query(CLUB_OWNER_UID)
        .findOne({
          where: {
            id: clubOwnerId,
          },
          select: [
            'id',
            'clubName',
            'clubCategory',
          ],
        });

      if (!clubOwner) {
        throw new Error(
          'New club owner could not be found.'
        );
      }

      // 2. Map club category to membership tier
      const membershipTierName =
        CLUB_CATEGORY_MAP[clubOwner.clubCategory];

      if (!membershipTierName) {
        throw new Error(
          `Invalid or missing clubCategory: ${clubOwner.clubCategory}`
        );
      }

      // 3. Find matching global membership tier
      const membershipTier = await strapi.db
        .query(MEMBERSHIP_TIER_UID)
        .findOne({
          where: {
            name: membershipTierName,
            isActive: true,
          },
        });

      if (!membershipTier) {
        throw new Error(
          `Membership tier not found: ${membershipTierName}`
        );
      }

      // 4. Fetch existing global membership prices
      const membershipPrices = await strapi.db
        .query(MEMBERSHIP_PRICE_UID)
        .findMany({
          where: {
            membership_tier: {
              id: membershipTier.id,
            },
            isActive: true,
            duration: {
              $in: REQUIRED_DURATIONS,
            },
          },
        });

      // 5. Validate all three membership prices
      const priceMap = new Map(
        membershipPrices.map((price) => [
          price.duration,
          price,
        ])
      );

      const missingDurations =
        REQUIRED_DURATIONS.filter(
          (duration) => !priceMap.has(duration)
        );

      if (missingDurations.length > 0) {
        throw new Error(
          `Missing global membership prices for ${membershipTierName}: ${missingDurations.join(', ')}`
        );
      }

      // 6. Validate currency consistency
      const currencies = [
        ...new Set(
          membershipPrices.map(
            (price) => price.currency
          )
        ),
      ];

      if (currencies.length !== 1) {
        throw new Error(
          `Inconsistent pricing currencies for ${membershipTierName}.`
        );
      }

      // 7. Find existing gym contract
      let gymContract = await strapi.db
        .query(GYM_CONTRACT_UID)
        .findOne({
          where: {
            club_owner: {
              id: clubOwnerId,
            },
          },
        });

      // 8. Create default gym contract if missing
      if (!gymContract) {
        const startDate = new Date();
        const endDate = getContractEndDate(startDate);

        gymContract = await strapi.db
          .query(GYM_CONTRACT_UID)
          .create({
            data: {
              contractId: generateContractId(),

              club_owner: clubOwnerId,

              membership_tier: membershipTier.id,

              contractStatus: 'active',

              startDate: formatDate(startDate),
              endDate: formatDate(endDate),

              currency: currencies[0],

              notes:
                'Automatically generated default gym contract.',
            },
          });
      }

      // 9. Create missing contract plan rates
      for (const duration of REQUIRED_DURATIONS) {
        const membershipPrice =
          priceMap.get(duration);

        if (!membershipPrice) {
          continue;
        }

        const existingRate = await strapi.db
          .query(GYM_CONTRACT_RATE_UID)
          .findOne({
            where: {
              gym_contract: {
                id: gymContract.id,
              },
              membership_plan_price: {
                id: membershipPrice.id,
              },
            },
          });

        if (existingRate) {
          continue;
        }

        await strapi.db
          .query(GYM_CONTRACT_RATE_UID)
          .create({
            data: {
              gym_contract: gymContract.id,

              membership_plan_price:
                membershipPrice.id,

              commissionMode: 'default',

              customCommission: null,

              isActive: true,
            },
          });
      }

      // 10. Find existing gym promotion
      const existingPromotion = await strapi.db
        .query(GYM_PROMOTION_UID)
        .findOne({
          where: {
            gym_contract: {
              id: gymContract.id,
            },
            promotionType: 'zero_commission',
          },
        });

      // 11. Create default zero-commission promotion
      if (!existingPromotion) {
        const promotionStartDate =
          gymContract.startDate;

        const promotionEndDate =
          gymContract.endDate;

        await strapi.db
          .query(GYM_PROMOTION_UID)
          .create({
            data: {
              gym_contract: gymContract.id,

              promotionType: 'zero_commission',

              userLimit: DEFAULT_PROMOTION_USER_LIMIT,

              usedUserCount: 0,

              // Starts with no checkout reservations.
              reservedUserCount: 0,

              isActive: true,

              startDate: promotionStartDate,

              endDate: promotionEndDate,
            },
          });

        strapi.log.info(
          `Default zero-commission promotion created for gym contract ${gymContract.contractId}.`
        );
      }

      strapi.log.info(
        `Gym contract, plan rates and promotion setup completed for club owner ${clubOwnerId}.`
      );
    } catch (error) {
      strapi.log.error(
        `Gym contract setup failed for club owner ${clubOwnerId}:`,
        error
      );
    }
  },
};
