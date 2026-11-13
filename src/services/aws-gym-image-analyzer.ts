import AWS from "aws-sdk";

const awsConfig = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID?.trim() as string,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY?.trim() as string,
  region: process.env.AWS_REGION?.trim() || "ap-south-1",
};

const rekognition = new AWS.Rekognition(awsConfig);

export interface DetectedLabelItem {
  name: string;
  confidence: number;
}

export interface GymPhotoAnalysisResult {
  description: string;
  detailedDescription: string;
  category: string;
  confidence: number;
  suggestedTitles: string[];
  detectedLabels: DetectedLabelItem[];
  detectedText?: string[];
  isGymPhoto: boolean;
}

interface CategoryDefinition {
  id: string;
  title: string;
  suggestedTitles: string[];
  baseDescription: string;
  primaryKeywords: string[];
  secondaryKeywords: string[];
}

/**
 * Specific gym zones prioritized over generic scene labels.
 * If any of these score >= 2.5, they take priority over "Main Gym Floor".
 */
export const SPECIFIC_GYM_CATEGORIES: CategoryDefinition[] = [
  {
    id: "strength_area",
    title: "Strength Area",
    suggestedTitles: [
      "Strength Area",
      "Free Weights Area",
      "Strength Training Area",
      "Dumbbells & Barbells Zone",
      "Weightlifting Section",
    ],
    baseDescription:
      "Strength area equipped with free weights, dumbbells, barbells, weight plates, and resistance machines.",
    primaryKeywords: [
      "gym weights",
      "weight plate",
      "weight plates",
      "free weights",
      "dumbbell",
      "dumbbells",
      "barbell",
      "barbells",
      "kettlebell",
      "kettlebells",
      "dead lift",
      "deadlift",
      "leg press",
      "bench press",
      "bicep curl",
      "bicep curls",
      "overhead press",
      "squat",
      "squats",
      "weightlifting",
      "powerlifting",
      "squat rack",
      "cable machine",
      "smith machine",
      "lat pulldown",
      "chest press",
      "shoulder press",
      "weight machine",
      "resistance machine",
      "leg curl",
      "leg extension",
      "pec fly",
      "tricep",
      "pull up",
      "pull-up",
      "dip station",
      "barbell rack",
      "weight rack",
      "weight tree",
      "weight bench",
      "olympic bar",
    ],
    secondaryKeywords: [
      "weights",
      "weight",
      "plate",
      "iron",
      "lifting",
      "lift",
      "bodybuilding",
      "muscle",
      "resistance training",
      "strength training",
      "heavy weights",
    ],
  },
  {
    id: "cardio_area",
    title: "Cardio Area",
    suggestedTitles: [
      "Cardio Area",
      "Cardio Zone",
      "Treadmills Section",
      "Cardiovascular Fitness Area",
      "Spin & Cycle Studio",
    ],
    baseDescription:
      "Cardio area equipped with cardiovascular workout machines including treadmills, stationary bikes, and ellipticals.",
    primaryKeywords: [
      "treadmill",
      "treadmills",
      "stationary bike",
      "exercise bike",
      "elliptical",
      "stair climber",
      "rowing machine",
      "cardio",
      "spinning bike",
      "step mill",
      "spin bike",
      "stepper",
      "cross trainer",
      "skierg",
      "assault bike",
      "air bike",
      "running machine",
      "cardio machine",
    ],
    secondaryKeywords: [
      "aerobic",
      "aerobics",
      "running track",
      "bicycle",
      "jogging",
      "running",
      "cardiovascular",
      "cycling",
      "endurance",
      "rowing",
    ],
  },
  {
    id: "yoga_area",
    title: "Yoga Area",
    suggestedTitles: [
      "Yoga Area",
      "Yoga Studio",
      "Pilates & Stretching Area",
      "Mind & Body Studio",
      "Stretching Zone",
    ],
    baseDescription:
      "Calm and spacious studio dedicated to yoga, pilates, stretching, and mindfulness practices.",
    primaryKeywords: [
      "yoga",
      "yoga mat",
      "pilates",
      "meditation",
      "stretching mat",
      "yoga pose",
      "asana",
      "lotus position",
      "namaste",
      "pranayama",
      "stretching",
    ],
    secondaryKeywords: [
      "flexibility",
      "mindfulness",
      "wellness",
      "zen",
      "mat",
    ],
  },
  {
    id: "dance_studio",
    title: "Dance Studio",
    suggestedTitles: [
      "Dance Studio",
      "Aerobics Studio",
      "Zumba Studio",
      "Group Fitness Studio",
      "Dance & Aerobics Studio",
    ],
    baseDescription:
      "Dedicated wooden-floor group fitness studio for dance, Zumba, aerobics, and choreographed group workouts.",
    primaryKeywords: [
      "dance",
      "dancing",
      "dancer",
      "zumba",
      "aerobics studio",
      "dance studio",
      "ballet",
      "ballet barre",
      "choreography",
      "mirror wall",
      "group fitness studio",
      "dance floor",
    ],
    secondaryKeywords: [
      "studio",
      "aerobics",
      "performance",
      "stage",
      "rhythm",
    ],
  },
  {
    id: "functional_crossfit",
    title: "Functional & CrossFit Area",
    suggestedTitles: [
      "Functional & CrossFit Area",
      "Functional Training Zone",
      "CrossFit Area",
      "HIIT & Conditioning Zone",
      "Athletic Turf Area",
    ],
    baseDescription:
      "High-intensity functional training and CrossFit area equipped with battle ropes, turf track, and conditioning equipment.",
    primaryKeywords: [
      "crossfit",
      "battle ropes",
      "trx",
      "plyometrics",
      "plyo box",
      "agility ladder",
      "tire flip",
      "slam ball",
      "medicine ball",
      "wall ball",
      "suspension training",
      "rope climbing",
      "monkey bars",
      "calisthenics",
      "sled push",
      "turf",
      "sled",
      "kettlebell swing",
    ],
    secondaryKeywords: [
      "functional training",
      "functional fitness",
      "pull-up bar",
      "gymnastic rings",
      "athletics",
      "hiit",
      "agility",
    ],
  },
  {
    id: "combat_sports",
    title: "Boxing & Combat Sports Area",
    suggestedTitles: [
      "Boxing Area",
      "Combat Sports Zone",
      "Punching Bags Area",
      "Boxing Ring Section",
      "Martial Arts Studio",
    ],
    baseDescription:
      "Combat sports area equipped with boxing bags, sparring ring, and martial arts training gear.",
    primaryKeywords: [
      "boxing",
      "punching bag",
      "heavy bag",
      "boxing ring",
      "boxing glove",
      "boxing gloves",
      "kickboxing",
      "martial arts",
      "mma",
      "muay thai",
      "wrestling ring",
      "octagon",
      "karate",
      "taekwondo",
      "judo",
      "sparring",
    ],
    secondaryKeywords: [
      "combat sport",
      "wrestling",
      "sparring",
      "self defense",
      "gloves",
    ],
  },
  {
    id: "swimming_pool",
    title: "Swimming Pool Area",
    suggestedTitles: [
      "Swimming Pool Area",
      "Indoor Pool",
      "Aquatics Center",
      "Lap Pool Zone",
      "Pool & Wet Area",
    ],
    baseDescription:
      "Swimming pool facility suitable for aquatic fitness, lap swimming, and water workouts.",
    primaryKeywords: [
      "swimming pool",
      "pool",
      "swimmer",
      "lap pool",
      "water sports",
      "diving board",
      "indoor pool",
      "outdoor pool",
    ],
    secondaryKeywords: [
      "aquatic",
      "water",
      "swimming",
      "swimwear",
    ],
  },
  {
    id: "locker_spa",
    title: "Locker Room & Spa Area",
    suggestedTitles: [
      "Locker Room & Spa Area",
      "Locker Room",
      "Sauna & Steam Area",
      "Wellness & Spa Zone",
      "Changing Room",
    ],
    baseDescription:
      "Clean and well-maintained locker room with secure lockers, changing facilities, and wellness amenities.",
    primaryKeywords: [
      "sauna",
      "steam room",
      "locker room",
      "locker",
      "jacuzzi",
      "hot tub",
      "spa",
      "shower room",
      "changing room",
    ],
    secondaryKeywords: [
      "showers",
      "relaxation",
      "wellness",
      "bath",
      "lockers",
    ],
  },
  {
    id: "reception",
    title: "Reception & Welcome Lounge",
    suggestedTitles: [
      "Reception & Welcome Lounge",
      "Front Desk Area",
      "Club Entrance & Lobby",
      "Client Welcome Desk",
      "Reception Area",
    ],
    baseDescription:
      "Front desk and reception lounge area welcoming members and visitors to the club.",
    primaryKeywords: [
      "reception",
      "front desk",
      "lobby",
      "lounge",
      "counter",
      "waiting area",
      "entrance",
      "foyer",
    ],
    secondaryKeywords: [
      "customer service",
      "office desk",
      "hall",
      "interior entrance",
    ],
  },
  {
    id: "cafeteria",
    title: "Cafeteria & Nutrition Bar",
    suggestedTitles: [
      "Cafeteria & Nutrition Bar",
      "Juice Bar & Cafe",
      "Protein Bar & Lounge",
      "Club Cafeteria",
      "Health Cafe",
    ],
    baseDescription:
      "Nutrition bar and cafeteria providing healthy drinks, protein shakes, and recovery meals.",
    primaryKeywords: [
      "cafeteria",
      "juice bar",
      "protein bar",
      "cafe",
      "coffee shop",
      "smoothie",
      "shake",
      "supplements",
      "smoothie bar",
    ],
    secondaryKeywords: [
      "dining table",
      "drink",
      "beverage",
      "nutrition",
      "bar",
    ],
  },
];

/**
 * Fallback category for general gym scenes when no specific zone is dominant.
 */
export const GENERAL_GYM_CATEGORY: CategoryDefinition = {
  id: "general_gym",
  title: "Main Gym Floor",
  suggestedTitles: [
    "Main Gym Floor",
    "General Workout Area",
    "Fitness Training Zone",
    "Club Gym Floor",
  ],
  baseDescription:
    "Main gym floor featuring an extensive range of fitness and training equipment.",
  primaryKeywords: [
    "gym",
    "fitness center",
    "physical fitness",
    "sports club",
    "exercise",
    "workout",
    "working out",
    "gymnasium",
    "fitness",
  ],
  secondaryKeywords: [
    "sport",
    "athlete",
    "training",
  ],
};

/**
 * Format a list of items into an English sentence (e.g. ["treadmills", "bikes"] -> "treadmills and bikes")
 */
function formatItemNames(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/**
 * Analyze a gym photo buffer using AWS Rekognition detectLabels (and detectText)
 * and classify the gym area with high accuracy.
 */
export async function analyzeGymPhoto(
  imageBuffer: Buffer
): Promise<GymPhotoAnalysisResult> {
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw new Error("Valid image buffer is required for analysis.");
  }

  // 1. Run Rekognition detectLabels (MinConfidence 35 to capture specific gym equipment) and detectText
  const [labelsRes, textRes] = await Promise.all([
    rekognition
      .detectLabels({
        Image: { Bytes: imageBuffer },
        MaxLabels: 50,
        MinConfidence: 35,
      })
      .promise(),
    rekognition
      .detectText({
        Image: { Bytes: imageBuffer },
      })
      .promise()
      .catch(() => {
        // Non-fatal if detectText fails
        return { TextDetections: [] };
      }),
  ]);

  const rawLabels = labelsRes.Labels || [];
  const detectedLabels: DetectedLabelItem[] = rawLabels.map((lbl) => ({
    name: lbl.Name || "",
    confidence: Number((lbl.Confidence || 0).toFixed(1)),
  }));

  const detectedTextLines: string[] = (textRes.TextDetections || [])
    .filter((t) => t.Type === "LINE" && t.DetectedText)
    .map((t) => (t.DetectedText || "").trim());

  const textLower = detectedTextLines.join(" ").toLowerCase();

  // 2. Score each specific category
  const scoredSpecific = SPECIFIC_GYM_CATEGORIES.map((cat) => {
    let score = 0;
    let highestConfidence = 0;
    const matchedLabels: string[] = [];

    for (const lbl of rawLabels) {
      const labelName = (lbl.Name || "").toLowerCase();
      const conf = lbl.Confidence || 0;
      const confWeight = conf / 100;

      // Check parents for weights / weightlifting
      const hasParentWeight = (lbl.Parents || []).some(
        (p) =>
          p.Name?.toLowerCase().includes("weights") ||
          p.Name?.toLowerCase().includes("weightlifting")
      );

      // Primary keyword match
      const isPrimary = cat.primaryKeywords.some(
        (kw) => labelName === kw || labelName.includes(kw)
      );

      if (isPrimary || (cat.id === "strength_area" && hasParentWeight)) {
        score += 10 * confWeight;
        if (conf > highestConfidence) highestConfidence = conf;
        matchedLabels.push(lbl.Name || "");
        continue;
      }

      // Secondary keyword match
      const isSecondary = cat.secondaryKeywords.some(
        (kw) => labelName === kw || labelName.includes(kw)
      );

      if (isSecondary) {
        score += 4 * confWeight;
        if (conf > highestConfidence) highestConfidence = conf;
        matchedLabels.push(lbl.Name || "");
      }
    }

    // Text bonus
    for (const kw of cat.primaryKeywords) {
      if (textLower.includes(kw)) {
        score += 6;
      }
    }

    // Strength specific bonus from weight plates text (e.g. "20", "25", "15", "10", "5", "kg", "lbs")
    if (cat.id === "strength_area") {
      const weightNumberMatch = textLower.match(/\b(2\.5|5|10|15|20|25|30|35|40|45|50|kg|lbs)\b/);
      if (weightNumberMatch) {
        score += 5;
      }
    }

    return {
      category: cat,
      score,
      highestConfidence,
      matchedLabels: Array.from(new Set(matchedLabels)),
    };
  });

  // Sort specific categories by score descending
  scoredSpecific.sort((a, b) => b.score - a.score);
  const topSpecific = scoredSpecific[0];

  // 3. Check for general gym labels
  const gymRelatedKeywords = [
    "gym",
    "fitness",
    "exercise",
    "sport",
    "workout",
    "working out",
    "bodybuilding",
    "training",
    "athletic",
  ];

  const hasAnyGymLabel = rawLabels.some((lbl) => {
    const n = (lbl.Name || "").toLowerCase();
    return gymRelatedKeywords.some((kw) => n.includes(kw));
  });

  const isGymPhoto = hasAnyGymLabel || (topSpecific && topSpecific.score > 2.0);

  // If not gym-related and low score
  if (!isGymPhoto && (!topSpecific || topSpecific.score < 2.0)) {
    const topLabelNames = detectedLabels.slice(0, 3).map((l) => l.name);
    return {
      description: "Club Area",
      detailedDescription:
        topLabelNames.length > 0
          ? `Club area featuring ${formatItemNames(topLabelNames.map((s) => s.toLowerCase()))}.`
          : "Club facility and general area.",
      category: "other",
      confidence: detectedLabels[0]?.confidence || 50,
      suggestedTitles: ["Club Area", "Facility Overview", "Club Photos"],
      detectedLabels,
      detectedText: detectedTextLines.length > 0 ? detectedTextLines : undefined,
      isGymPhoto: false,
    };
  }

  // 4. Decision: If a specific zone has a score >= 2.5, select that specific zone!
  // Otherwise, if it's a gym photo, fall back to "Main Gym Floor".
  let chosenCategory = GENERAL_GYM_CATEGORY;
  let chosenConfidence = 85;
  let matchedEquipments: string[] = [];

  if (topSpecific && topSpecific.score >= 2.5) {
    chosenCategory = topSpecific.category;
    chosenConfidence = topSpecific.highestConfidence || 90;
    matchedEquipments = topSpecific.matchedLabels;
  } else {
    // Fallback to Main Gym Floor
    const topGymLabel = detectedLabels.find((l) =>
      gymRelatedKeywords.some((kw) => l.name.toLowerCase().includes(kw))
    );
    if (topGymLabel) {
      chosenConfidence = topGymLabel.confidence;
    }
    matchedEquipments = detectedLabels
      .filter((l) => !["clothing", "footwear", "shoe", "person", "floor", "indoors", "room"].includes(l.name.toLowerCase()))
      .slice(0, 3)
      .map((l) => l.name);
  }

  // Filter generic non-equipment names for detailed description
  const cleanEquipments = matchedEquipments
    .filter(
      (m) =>
        ![
          "gym",
          "fitness",
          "sport",
          "workout",
          "working out",
          "exercise",
          "physical fitness",
          "person",
          "clothing",
          "footwear",
          "shoe",
          "floor",
          "flooring",
        ].includes(m.toLowerCase())
    )
    .slice(0, 4)
    .map((m) => m.toLowerCase());

  let detailedDescription = chosenCategory.baseDescription;
  if (cleanEquipments.length > 0) {
    detailedDescription = `${chosenCategory.title} featuring ${formatItemNames(
      cleanEquipments
    )}.`;
  }

  return {
    description: chosenCategory.title,
    detailedDescription,
    category: chosenCategory.id,
    confidence: Number(chosenConfidence.toFixed(1)),
    suggestedTitles: chosenCategory.suggestedTitles,
    detectedLabels,
    detectedText: detectedTextLines.length > 0 ? detectedTextLines : undefined,
    isGymPhoto: true,
  };
}
