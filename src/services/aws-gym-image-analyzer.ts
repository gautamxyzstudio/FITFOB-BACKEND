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

export interface PhotoAnalysisResult {
  description: string;
  suggestedTitles: string[];
  detectedLabels: DetectedLabelItem[];
  detectedText?: string[];
}

/**
 * Intelligent, generalized title generator for any uploaded image
 * using AWS Rekognition labels, scene elements, and detected text.
 */
function generateSuggestedTitles(
  labels: AWS.Rekognition.Label[],
  textLines: string[]
): string[] {
  const labelNames = labels.map((l) => (l.Name || "").toLowerCase());
  const textJoined = textLines.join(" ");
  const textLower = textJoined.toLowerCase();

  const titles: string[] = [];

  const hasLabel = (...keywords: string[]) =>
    keywords.some((k) =>
      labelNames.some((l) => l === k.toLowerCase() || l.includes(k.toLowerCase()))
    );

  const hasText = (...keywords: string[]) =>
    keywords.some((k) => textLower.includes(k.toLowerCase()));

  // 1. Digital UI / Mobile App / Web / Software Screenshot
  const isDigitalUI =
    hasLabel(
      "webpage",
      "screenshot",
      "user interface",
      "text message",
      "mobile phone",
      "operating system",
      "software"
    ) && (labels[0]?.Confidence || 0) > 48;

  if (isDigitalUI) {
    if (hasText("real estate", "property", "properties", "home", "homes", "condo", "mls")) {
      return [
        "Real Estate Application",
        "Property Listings View",
        "Real Estate Market Overview",
        "Mobile App Interface",
      ];
    }
    if (hasText("postman", "http", "api", "headers", "params", "form-data", "request", "endpoint")) {
      return [
        "API Client Interface",
        "Postman Request Screen",
        "Developer Tool View",
        "Software Interface",
      ];
    }
    if (hasText("dashboard", "analytics", "stats", "metrics", "chart", "report")) {
      return [
        "Dashboard Overview",
        "Analytics Screen",
        "Performance Metrics View",
        "System Dashboard",
      ];
    }
    if (hasText("fitness", "gym", "workout", "tracker", "calories", "training")) {
      return [
        "Fitness App Interface",
        "Workout Tracker Screen",
        "Fitness Mobile App",
        "Training Overview",
      ];
    }

    const prominentHeadline = textLines.find(
      (t) => t.length >= 4 && t.length <= 32 && !/^\d+$/.test(t)
    );
    if (prominentHeadline) {
      return [
        prominentHeadline,
        `${prominentHeadline} Screen`,
        "Mobile Application View",
        "Digital Interface",
      ];
    }
    return [
      "Mobile Application Interface",
      "Application View",
      "Digital Interface",
      "System Screen",
    ];
  }

  // 2. Strength / Weights / Bodybuilding / Gym Equipment
  if (
    hasLabel(
      "gym weights",
      "weightlifting",
      "dumbbell",
      "barbell",
      "dead lift",
      "leg press",
      "bench press",
      "bicep curls",
      "overhead press",
      "squat",
      "kettlebell",
      "weight plate",
      "powerlifting",
      "weight machine",
      "cable machine",
      "smith machine"
    )
  ) {
    return [
      "Strength Area",
      "Free Weights Area",
      "Strength Training Area",
      "Weightlifting Zone",
      "Dumbbells & Barbells Section",
    ];
  }

  // 3. Cardio & Aerobic Machines
  if (
    hasLabel(
      "treadmill",
      "stationary bike",
      "exercise bike",
      "elliptical",
      "rowing machine",
      "stair climber",
      "cardio",
      "spin bike",
      "spinning bike"
    )
  ) {
    return [
      "Cardio Area",
      "Cardio Zone",
      "Treadmills Section",
      "Cardiovascular Fitness Area",
      "Cycling & Spin Studio",
    ];
  }

  // 4. Yoga / Pilates / Meditation
  if (
    hasLabel(
      "yoga",
      "yoga mat",
      "pilates",
      "meditation",
      "stretching mat",
      "asana",
      "pranayama"
    )
  ) {
    return [
      "Yoga Area",
      "Yoga Studio",
      "Pilates & Stretching Studio",
      "Mind & Body Area",
      "Wellness & Meditation Zone",
    ];
  }

  // 5. Dance / Zumba / Aerobics Studio
  if (
    hasLabel(
      "dance",
      "dancing",
      "zumba",
      "aerobics studio",
      "dance studio",
      "ballet",
      "choreography"
    )
  ) {
    return [
      "Dance Studio",
      "Aerobics Studio",
      "Zumba Studio",
      "Group Fitness Studio",
      "Dance & Movement Studio",
    ];
  }

  // 6. Boxing & Combat Sports
  if (
    hasLabel(
      "boxing",
      "punching bag",
      "heavy bag",
      "boxing ring",
      "boxing glove",
      "martial arts",
      "mma",
      "kickboxing",
      "muay thai"
    )
  ) {
    return [
      "Boxing Area",
      "Combat Sports Zone",
      "Punching Bags Area",
      "Boxing Ring Section",
      "Martial Arts Studio",
    ];
  }

  // 7. Functional & CrossFit Area
  if (
    hasLabel(
      "crossfit",
      "battle ropes",
      "trx",
      "plyometrics",
      "plyo box",
      "agility ladder",
      "tire flip",
      "slam ball",
      "calisthenics",
      "turf"
    )
  ) {
    return [
      "Functional & CrossFit Area",
      "Functional Training Zone",
      "CrossFit Area",
      "HIIT & Conditioning Zone",
      "Athletic Turf Area",
    ];
  }

  // 8. Swimming Pool & Aquatics
  if (hasLabel("swimming pool", "lap pool", "aquatics center", "pool", "swimmer")) {
    return [
      "Swimming Pool Area",
      "Indoor Pool",
      "Aquatics Center",
      "Pool & Aquatic Zone",
    ];
  }

  // 9. Locker Room & Spa
  if (hasLabel("locker room", "sauna", "steam room", "changing room", "lockers")) {
    return [
      "Locker Room",
      "Sauna & Steam Area",
      "Changing Facilities",
      "Wellness & Locker Zone",
    ];
  }

  // 10. Reception / Front Desk / Lobby
  if (
    hasLabel("reception", "front desk", "welcome desk", "lobby", "lounge", "foyer", "waiting room")
  ) {
    return [
      "Reception & Front Desk",
      "Welcome Lounge",
      "Lobby Area",
      "Customer Service Desk",
    ];
  }

  // 11. Cafeteria / Juice Bar / Restaurant
  if (
    hasLabel(
      "cafeteria",
      "juice bar",
      "smoothie",
      "cafe",
      "restaurant",
      "coffee shop",
      "dining"
    )
  ) {
    return [
      "Cafeteria & Lounge",
      "Juice Bar & Cafe",
      "Dining Area",
      "Refreshment Zone",
    ];
  }

  // 12. General Fitness / Gym
  if (
    hasLabel(
      "gym",
      "fitness",
      "working out",
      "exercise",
      "physical fitness",
      "bodybuilding"
    )
  ) {
    return [
      "Main Gym Floor",
      "Fitness Training Zone",
      "General Workout Area",
      "Club Gym Floor",
    ];
  }

  // 13. Real Estate / Housing / Architecture
  if (
    hasLabel(
      "house",
      "housing",
      "villa",
      "building",
      "architecture",
      "residence",
      "apartment",
      "home",
      "interior design"
    )
  ) {
    return [
      "Property Overview",
      "Architecture & Building",
      "Residential Property",
      "Exterior View",
    ];
  }

  // 14. Nature / Landscape / Outdoors
  if (
    hasLabel(
      "nature",
      "landscape",
      "mountain",
      "forest",
      "park",
      "garden",
      "outdoor",
      "sky",
      "beach",
      "sea"
    )
  ) {
    return [
      "Outdoor Scenery",
      "Landscape View",
      "Nature & Scenic Area",
      "Outdoor Grounds",
    ];
  }

  // 15. Dynamic Fallback: Compose natural titles from top detected labels
  const filterWords = [
    "file",
    "text",
    "line",
    "paper",
    "black",
    "white",
    "grey",
    "pattern",
    "symbol",
    "sign",
    "font",
  ];
  const cleanLabels = labels
    .map((l) => l.Name || "")
    .filter((n) => n && !filterWords.includes(n.toLowerCase()))
    .slice(0, 4);

  if (cleanLabels.length > 0) {
    titles.push(
      cleanLabels[0],
      cleanLabels.slice(0, 2).join(" & "),
      `${cleanLabels[0]} Area`,
      `${cleanLabels[0]} Overview`
    );
  } else {
    titles.push("Facility Overview", "Uploaded Image", "Photo View");
  }

  return Array.from(new Set(titles));
}

/**
 * Analyze any uploaded image buffer using AWS Rekognition detectLabels (and detectText)
 * and suggest titles without keyword or gym restrictions.
 */
export async function analyzeGymPhoto(
  imageBuffer: Buffer
): Promise<PhotoAnalysisResult> {
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw new Error("Valid image buffer is required for analysis.");
  }

  const [labelsRes, textRes] = await Promise.all([
    rekognition
      .detectLabels({
        Image: { Bytes: imageBuffer },
        MaxLabels: 50,
        MinConfidence: 40,
      })
      .promise(),
    rekognition
      .detectText({
        Image: { Bytes: imageBuffer },
      })
      .promise()
      .catch(() => ({ TextDetections: [] })),
  ]);

  const rawLabels = labelsRes.Labels || [];
  const detectedLabels: DetectedLabelItem[] = rawLabels.map((lbl) => ({
    name: lbl.Name || "",
    confidence: Number((lbl.Confidence || 0).toFixed(1)),
  }));

  const detectedTextLines: string[] = (textRes.TextDetections || [])
    .filter((t) => t.Type === "LINE" && t.DetectedText)
    .map((t) => (t.DetectedText || "").trim());

  const suggestedTitles = generateSuggestedTitles(rawLabels, detectedTextLines);
  const description = suggestedTitles[0] || "Uploaded Photo";

  return {
    description,
    suggestedTitles,
    detectedLabels,
    detectedText: detectedTextLines.length > 0 ? detectedTextLines : undefined,
  };
}
