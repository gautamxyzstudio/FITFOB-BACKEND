const CLUB_UID = "api::club-owner.club-owner";

function random8Digit() {
  // guarantees 8 digit number (10000000 - 99999999)
  return Math.floor(10000000 + Math.random() * 90000000);
}

export async function generateClubId(): Promise<string> {

  let clubId: string;
  let exists = true;
  let attempts = 0;

  while (exists) {
    if (attempts > 10) {
      throw new Error("Unable to generate unique club ID");
    }

    // 1️⃣ generate
    const randomNumber = random8Digit();
    clubId = `FFB${randomNumber}`;

    // 2️⃣ check DB
    const found = await strapi.db.query(CLUB_UID).findOne({
      where: { clubId },
      select: ["id"],
    });

    exists = !!found;
    attempts++;
  }

  return clubId!;
}