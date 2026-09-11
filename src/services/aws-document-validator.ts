import AWS from "aws-sdk";

const awsConfig = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID as string,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY as string,
  region: process.env.AWS_REGION || "ap-south-1",
};

const textract = new AWS.Textract(awsConfig);
const rekognition = new AWS.Rekognition(awsConfig);

interface ValidationResult {
  valid: boolean;
  documentType:
  | "aadhaar"
  | "passport"
  | "driving-license"
  | "pan"
  | "voter-id"
  | "unknown";
}

type QueryField = {
  text: string;
  confidence: number;
};

type QueryFields = Record<string, QueryField>;

/**
 * ---------------------------------------------------------
 * GET OCR TEXT
 * ---------------------------------------------------------
 */
function getText(
  blocks: AWS.Textract.Block[] | undefined,
): string {
  if (!blocks?.length) {
    return "";
  }

  return blocks
    .filter(
      (block) =>
        block.BlockType === "LINE" &&
        !!block.Text,
    )
    .map((block) => block.Text || "")
    .join(" ")
    .trim();
}

/**
 * ---------------------------------------------------------
 * NORMALIZE TEXT
 * ---------------------------------------------------------
 */
function normalizeText(text: string): string {
  return text
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * ---------------------------------------------------------
 * GET TEXTRACT QUERY RESULTS
 *
 * IMPORTANT:
 *
 * QUERY block
 *      |
 *      | ANSWER relationship
 *      v
 * QUERY_RESULT block
 *
 * The Alias exists on QUERY.
 * The actual answer exists on QUERY_RESULT.
 * ---------------------------------------------------------
 */
function getQueryResults(
  blocks: AWS.Textract.Block[] | undefined,
): QueryFields {
  const results: QueryFields = {};

  if (!blocks?.length) {
    return results;
  }

  const queryResultMap = new Map<
    string,
    AWS.Textract.Block
  >();

  /**
   * First collect all QUERY_RESULT blocks.
   */
  for (const block of blocks) {
    if (
      block.BlockType === "QUERY_RESULT" &&
      block.Id
    ) {
      queryResultMap.set(block.Id, block);
    }
  }

  /**
   * Then connect QUERY -> ANSWER -> QUERY_RESULT.
   */
  for (const queryBlock of blocks) {
    if (
      queryBlock.BlockType !== "QUERY" ||
      !queryBlock.Query?.Alias
    ) {
      continue;
    }

    const answerRelationship =
      queryBlock.Relationships?.find(
        (relationship) =>
          relationship.Type === "ANSWER",
      );

    if (!answerRelationship?.Ids?.length) {
      continue;
    }

    for (const answerId of answerRelationship.Ids) {
      const answerBlock =
        queryResultMap.get(answerId);

      if (!answerBlock) {
        continue;
      }

      const answerText =
        answerBlock.Text?.trim() || "";

      if (!answerText) {
        continue;
      }

      results[queryBlock.Query.Alias] = {
        text: answerText,
        confidence:
          answerBlock.Confidence || 0,
      };

      break;
    }
  }

  return results;
}

/**
 * ---------------------------------------------------------
 * CHECK QUERY FIELD
 *
 * Query confidence is treated as supporting information.
 * It is NOT a hard validation requirement.
 *
 * This prevents valid documents from failing simply because
 * Textract returned a lower confidence score.
 * ---------------------------------------------------------
 */
function hasQueryField(
  fields: QueryFields,
  alias: string,
): boolean {
  const field = fields[alias];

  return !!(
    field &&
    field.text &&
    field.text.trim().length > 0
  );
}

/**
 * ---------------------------------------------------------
 * FACE / PHOTO CHECK
 *
 * Rekognition is used as a supporting photo check.
 *
 * IMPORTANT:
 * If Rekognition successfully processes the image and
 * explicitly returns zero faces -> false.
 *
 * If Rekognition itself fails because of:
 * - IAM permission
 * - unsupported image format
 * - image size
 * - AWS service error
 *
 * we do NOT make an otherwise valid government document
 * fail.
 *
 * This avoids false negatives caused by AWS/Rekognition.
 * ---------------------------------------------------------
 */
async function hasFace(
  buffer: Buffer,
): Promise<boolean> {
  try {
    if (!buffer || buffer.length === 0) {
      console.error(
        "Rekognition skipped: empty image buffer",
      );

      return true;
    }

    // console.log(
    //   "Rekognition image size:",
    //   buffer.length,
    //   "bytes",
    // );

    const response = await rekognition
      .detectFaces({
        Image: {
          Bytes: buffer,
        },
        Attributes: ["DEFAULT"],
      })
      .promise();

    const faces = response.FaceDetails || [];

    // console.log(
    //   "Rekognition detected faces:",
    //   faces.length,
    // );

    if (faces.length === 0) {
      return false;
    }

    const validFace = faces.some(
      (face) =>
        (face.Confidence || 0) >= 80,
    );

    // console.log(
    //   "Rekognition valid face:",
    //   validFace,
    // );

    return validFace;
  } catch (error: any) {
    console.error(
      "Rekognition face detection error:",
      {
        code: error?.code,
        message: error?.message,
        statusCode:
          error?.statusCode,
        requestId:
          error?.requestId,
      },
    );

    /**
     * Do not reject a valid document because the
     * external face-detection service failed.
     *
     * Document number + document identity + OCR
     * validation remain the primary checks.
     */
    return true;
  }
}

/**
 * ---------------------------------------------------------
 * CHECK DATE
 * ---------------------------------------------------------
 */
function hasDate(text: string): boolean {
  const normalized = normalizeText(text);

  return (
    /\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4}\b/.test(
      normalized,
    ) ||
    /\b\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2}\b/.test(
      normalized,
    ) ||
    /\b\d{1,2}\s+\d{1,2}\s+\d{4}\b/.test(
      normalized,
    )
  );
}

/**
 * ---------------------------------------------------------
 * EXTRACT DOCUMENT NUMBER FROM OCR
 * ---------------------------------------------------------
 */
function extractDocumentNumber(
  documentType: ValidationResult["documentType"],
  text: string,
): string | null {
  const normalized = normalizeText(text);

  switch (documentType) {
    /**
     * -----------------------------------------------------
     * PAN
     *
     * Example:
     * ABCDE1234F
     * -----------------------------------------------------
     */
    case "pan": {
      const matches = normalized.match(
        /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g,
      );

      if (matches?.length) {
        return matches[0];
      }

      /**
       * OCR can sometimes add spaces:
       *
       * ABCDE 1234 F
       */
      const compact = normalized.replace(
        /[^A-Z0-9]/g,
        "",
      );

      const compactMatch =
        compact.match(
          /[A-Z]{5}[0-9]{4}[A-Z]/,
        );

      return compactMatch?.[0] || null;
    }

    /**
     * -----------------------------------------------------
     * AADHAAR
     *
     * Supports:
     *
     * 4040 7912 0836
     * 404079120836
     * XXXX XXXX 0836
     * XXXX-XXXX-0836
     * -----------------------------------------------------
     */
    case "aadhaar": {
      const maskedMatch =
        normalized.match(
          /\b(?:X{4,8}|\*{4,8})[\s-]?[X*]?\s*[0-9]{4}\b/g,
        );

      if (maskedMatch?.[0]) {
        return maskedMatch[0]
          .replace(/\s+/g, "")
          .toUpperCase();
      }

      const groupedMatch =
        normalized.match(
          /\b\d{4}[\s-]\d{4}[\s-]\d{4}\b/g,
        );

      if (groupedMatch?.[0]) {
        return groupedMatch[0].replace(
          /[\s-]/g,
          "",
        );
      }

      const twelveDigit =
        normalized.match(/\b\d{12}\b/g);

      if (twelveDigit?.[0]) {
        return twelveDigit[0];
      }

      /**
       * OCR may split the Aadhaar number into
       * separate groups with inconsistent spaces.
       */
      const compact = normalized.replace(
        /[^0-9]/g,
        "",
      );

      const compactMatch =
        compact.match(/\d{12}/);

      return compactMatch?.[0] || null;
    }

    /**
     * -----------------------------------------------------
     * PASSPORT
     *
     * Example:
     * A1234567
     * -----------------------------------------------------
     */
    case "passport": {
      const matches = normalized.match(
        /\b[A-Z][0-9]{7}\b/g,
      );

      if (matches?.length) {
        return matches[0];
      }

      const compact = normalized.replace(
        /[^A-Z0-9]/g,
        "",
      );

      const compactMatch =
        compact.match(
          /[A-Z][0-9]{7}/,
        );

      return compactMatch?.[0] || null;
    }

    /**
     * -----------------------------------------------------
     * DRIVING LICENCE
     *
     * DL formats vary by state.
     * -----------------------------------------------------
     */
    case "driving-license": {
      const matches = normalized.match(
        /\b[A-Z]{1,5}[- ]?[0-9]{5,20}\b/g,
      );

      if (matches?.length) {
        return matches[0]
          .replace(/\s+/g, "")
          .toUpperCase();
      }

      /**
       * More permissive fallback.
       */
      const compact = normalized.replace(
        /[^A-Z0-9]/g,
        "",
      );

      const compactMatch =
        compact.match(
          /[A-Z]{1,5}[0-9]{5,20}/,
        );

      return compactMatch?.[0] || null;
    }

    /**
     * -----------------------------------------------------
     * VOTER ID / EPIC
     *
     * Example:
     * UGU1988278
     * -----------------------------------------------------
     */
    case "voter-id": {
      const matches = normalized.match(
        /\b[A-Z]{3}[0-9]{7}\b/g,
      );

      if (matches?.length) {
        return matches[0];
      }

      const compact = normalized.replace(
        /[^A-Z0-9]/g,
        "",
      );

      const compactMatch =
        compact.match(
          /[A-Z]{3}[0-9]{7}/,
        );

      return compactMatch?.[0] || null;
    }

    default:
      return null;
  }
}

/**
 * ---------------------------------------------------------
 * GET QUERY VALUE
 * ---------------------------------------------------------
 */
function getQueryValue(
  fields: QueryFields,
  alias: string,
): string {
  return (
    fields[alias]?.text
      ?.replace(/\s+/g, " ")
      .trim()
      .toUpperCase() || ""
  );
}

/**
 * ---------------------------------------------------------
 * VALIDATE DOCUMENT NUMBER
 *
 * Query result OR OCR result.
 * ---------------------------------------------------------
 */
function validateDocumentNumber(
  documentType: ValidationResult["documentType"],
  text: string,
  fields: QueryFields,
): boolean {
  switch (documentType) {
    /**
     * -----------------------------------------------------
     * PAN
     * -----------------------------------------------------
     */
    case "pan": {
      const queryValue = getQueryValue(
        fields,
        "PAN_NUMBER",
      );

      const queryPan = queryValue
        .replace(/[^A-Z0-9]/g, "")
        .toUpperCase();

      const ocrPan =
        extractDocumentNumber(
          documentType,
          text,
        );

      /**
       * Prefer OCR if Query result is not a valid PAN.
       */
      const pan =
        /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(
          queryPan,
        )
          ? queryPan
          : ocrPan || "";

      return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(
        pan,
      );
    }

    /**
     * -----------------------------------------------------
     * AADHAAR
     * -----------------------------------------------------
     */
    case "aadhaar": {
      const queryValue = getQueryValue(
        fields,
        "AADHAAR_NUMBER",
      );

      const queryAadhaar = queryValue
        .replace(/[\s-]/g, "")
        .toUpperCase();

      const ocrAadhaar =
        extractDocumentNumber(
          documentType,
          text,
        );

      /**
       * IMPORTANT:
       *
       * Textract returned:
       *
       * AADHAAR_NUMBER: AA 1
       * confidence: 42
       *
       * This is NOT a valid Aadhaar number.
       *
       * OCR returned:
       *
       * 404079120836
       *
       * Therefore use Query only when the Query result
       * itself matches a valid Aadhaar format.
       */
      const validQueryAadhaar =
        /^[0-9]{12}$/.test(
          queryAadhaar,
        ) ||
        /^[X*]{4,}[0-9]{4}$/.test(
          queryAadhaar,
        );

      const aadhaar =
        validQueryAadhaar
          ? queryAadhaar
          : ocrAadhaar || "";

      // console.log(
      //   "Aadhaar number validation:",
      //   {
      //     queryValue,
      //     queryAadhaar,
      //     ocrAadhaar,
      //     selectedAadhaar: aadhaar,
      //   },
      // );

      /**
       * Full Aadhaar number.
       */
      if (/^[0-9]{12}$/.test(aadhaar)) {
        return true;
      }

      /**
       * Masked Aadhaar.
       */
      if (
        /^[X*]{4,}[0-9]{4}$/.test(
          aadhaar,
        )
      ) {
        return true;
      }

      return false;
    }

    /**
     * -----------------------------------------------------
     * PASSPORT
     * -----------------------------------------------------
     */
    case "passport": {
      const queryValue = getQueryValue(
        fields,
        "PASSPORT_NUMBER",
      );

      const queryPassport =
        queryValue
          .replace(/[^A-Z0-9]/g, "")
          .toUpperCase();

      const ocrPassport =
        extractDocumentNumber(
          documentType,
          text,
        );

      /**
       * Use Query only when it is actually a valid
       * passport number.
       */
      const passport =
        /^[A-Z][0-9]{7}$/.test(
          queryPassport,
        )
          ? queryPassport
          : ocrPassport || "";

      return /^[A-Z][0-9]{7}$/.test(
        passport,
      );
    }

    /**
     * -----------------------------------------------------
     * DRIVING LICENCE
     * -----------------------------------------------------
     */
    case "driving-license": {
      const queryValue = getQueryValue(
        fields,
        "DL_NUMBER",
      );

      const queryDl =
        queryValue
          .replace(/[^A-Z0-9]/g, "")
          .toUpperCase();

      const ocrDl =
        extractDocumentNumber(
          documentType,
          text,
        );

      /**
       * Query result must contain a reasonable
       * DL value before we trust it.
       */
      const validQueryDl =
        queryDl.length >= 6 &&
        queryDl.length <= 30 &&
        /^[A-Z0-9]+$/.test(queryDl);

      const dl =
        validQueryDl
          ? queryDl
          : ocrDl || "";

      return (
        dl.length >= 6 &&
        dl.length <= 30 &&
        /^[A-Z0-9]+$/.test(dl)
      );
    }

    /**
     * -----------------------------------------------------
     * VOTER ID
     * -----------------------------------------------------
     */
    case "voter-id": {
      const queryValue = getQueryValue(
        fields,
        "EPIC_NUMBER",
      );

      const queryEpic =
        queryValue
          .replace(/[^A-Z0-9]/g, "")
          .toUpperCase();

      const ocrEpic =
        extractDocumentNumber(
          documentType,
          text,
        );

      /**
       * Only trust Query if it matches the EPIC format.
       */
      const validQueryEpic =
        /^[A-Z]{3}[0-9]{7}$/.test(
          queryEpic,
        );

      const epic =
        validQueryEpic
          ? queryEpic
          : ocrEpic || "";

      return /^[A-Z]{3}[0-9]{7}$/.test(
        epic,
      );
    }

    default:
      return false;
  }
}

/**
 * ---------------------------------------------------------
 * DOCUMENT TYPE DETECTION
 * ---------------------------------------------------------
 */
function detectDocumentType(
  text: string,
): ValidationResult["documentType"] {
  const normalized = normalizeText(text);
  const compact = normalized.replace(
    /[^A-Z0-9]/g,
    "",
  );

  /**
   * -------------------------------------------------------
   * AADHAAR
   *
   * Aadhaar OCR is not guaranteed to contain the word
   * "AADHAAR".
   *
   * Therefore also detect Aadhaar using:
   * - Government of India
   * - Aadhaar number pattern
   * - VID pattern
   * - DOB
   * -------------------------------------------------------
   */
  const hasAadhaarNumber =
    /\b\d{4}[\s-]\d{4}[\s-]\d{4}\b/.test(
      normalized,
    ) ||
    /\b\d{12}\b/.test(normalized) ||
    /\b(?:X{4,8}|\*{4,8})[\s-]?\d{4}\b/.test(
      normalized,
    );

  const hasVID =
    /\b\d{4}[\s-]\d{4}[\s-]\d{4}[\s-]\d{4}\b/.test(
      normalized,
    ) ||
    /\b\d{16}\b/.test(normalized);

  const hasAadhaarIdentity =
    normalized.includes("AADHAAR") ||
    normalized.includes("AADHAR") ||
    normalized.includes("UIDAI") ||
    normalized.includes(
      "UNIQUE IDENTIFICATION AUTHORITY",
    ) ||
    normalized.includes("MERA AADHAAR");

  if (
    hasAadhaarIdentity ||
    (
      normalized.includes("GOVERNMENT OF INDIA") &&
      hasAadhaarNumber &&
      hasVID
    )
  ) {
    return "aadhaar";
  }

  /**
   * -------------------------------------------------------
   * PASSPORT
   * -------------------------------------------------------
   */
  if (
    normalized.includes("PASSPORT") ||
    normalized.includes("REPUBLIC OF INDIA") ||
    normalized.includes(
      "PASSPORT AUTHORITY",
    )
  ) {
    return "passport";
  }

  /**
   * -------------------------------------------------------
   * DRIVING LICENCE
   * -------------------------------------------------------
   */
  if (
    normalized.includes("DRIVING LICENCE") ||
    normalized.includes("DRIVING LICENSE") ||
    normalized.includes("LICENCE TO DRIVE") ||
    normalized.includes("LICENSE TO DRIVE") ||
    normalized.includes("TRANSPORT DEPARTMENT") ||
    normalized.includes("MOTOR VEHICLES") ||
    normalized.includes("MOTOR VEHICLE")
  ) {
    return "driving-license";
  }

  /**
   * -------------------------------------------------------
   * PAN
   * -------------------------------------------------------
   */
  const hasPanNumber =
    /\b[A-Z]{5}[0-9]{4}[A-Z]\b/.test(
      normalized,
    ) ||
    /[A-Z]{5}[0-9]{4}[A-Z]/.test(
      compact,
    );

  if (
    normalized.includes(
      "INCOME TAX DEPARTMENT",
    ) ||
    normalized.includes(
      "PERMANENT ACCOUNT NUMBER",
    ) ||
    (
      normalized.includes("INCOME TAX") &&
      hasPanNumber
    )
  ) {
    return "pan";
  }

  /**
   * -------------------------------------------------------
   * VOTER ID
   * -------------------------------------------------------
   */
  const hasEpicNumber =
    /\b[A-Z]{3}[0-9]{7}\b/.test(
      normalized,
    ) ||
    /[A-Z]{3}[0-9]{7}/.test(
      compact,
    );

  if (
    normalized.includes(
      "ELECTION COMMISSION",
    ) ||
    normalized.includes(
      "ELECTOR PHOTO IDENTITY CARD",
    ) ||
    normalized.includes(
      "ELECTORAL PHOTO IDENTITY CARD",
    ) ||
    normalized.includes("VOTER") ||
    (
      normalized.includes("ELECTOR") &&
      hasEpicNumber
    )
  ) {
    return "voter-id";
  }

  return "unknown";
}

/**
 * ---------------------------------------------------------
 * GET DOCUMENT QUERIES
 * ---------------------------------------------------------
 */
function getDocumentQueries(
  documentType: ValidationResult["documentType"],
) {
  const queries = {
    aadhaar: [
      {
        Text: "What is the Aadhaar number?",
        Alias: "AADHAAR_NUMBER",
      },
      {
        Text: "What is the name of the Aadhaar holder?",
        Alias: "NAME",
      },
      {
        Text: "What is the date of birth?",
        Alias: "DOB",
      },
    ],

    passport: [
      {
        Text: "What is the passport number?",
        Alias: "PASSPORT_NUMBER",
      },
      {
        Text: "What is the name of the passport holder?",
        Alias: "NAME",
      },
      {
        Text: "What is the date of birth?",
        Alias: "DOB",
      },
      {
        Text: "What is the nationality?",
        Alias: "NATIONALITY",
      },
    ],

    "driving-license": [
      {
        Text: "What is the driving licence number?",
        Alias: "DL_NUMBER",
      },
      {
        Text: "What is the name of the licence holder?",
        Alias: "NAME",
      },
      {
        Text: "What is the date of birth?",
        Alias: "DOB",
      },
    ],

    pan: [
      {
        Text: "What is the PAN number?",
        Alias: "PAN_NUMBER",
      },
      {
        Text: "What is the name of the PAN card holder?",
        Alias: "NAME",
      },
      {
        Text: "What is the date of birth?",
        Alias: "DOB",
      },
    ],

    "voter-id": [
      {
        Text:
          "What is the EPIC number or voter ID number?",
        Alias: "EPIC_NUMBER",
      },
      {
        Text: "What is the name of the voter?",
        Alias: "NAME",
      },
    ],
  };

  return queries[documentType];
}

/**
 * ---------------------------------------------------------
 * MAIN GOVERNMENT DOCUMENT VALIDATION
 * ---------------------------------------------------------
 */
export const validateGovernmentDocument =
  async (
    buffer: Buffer,
  ): Promise<ValidationResult> => {
    try {
      /**
       * -----------------------------------------------------
       * BASIC BUFFER CHECK
       * -----------------------------------------------------
       */
      if (
        !buffer ||
        !Buffer.isBuffer(buffer) ||
        buffer.length === 0
      ) {
        console.error(
          "Government document validation failed: empty buffer",
        );

        return {
          valid: false,
          documentType: "unknown",
        };
      }

      // console.log(
      //   "Government document size:",
      //   buffer.length,
      //   "bytes",
      // );

      /**
       * -----------------------------------------------------
       * STEP 1: OCR
       * -----------------------------------------------------
       */
      let ocrResponse:
        | AWS.Textract.DetectDocumentTextResponse
        | undefined;

      try {
        ocrResponse = await textract
          .detectDocumentText({
            Document: {
              Bytes: buffer,
            },
          })
          .promise();
      } catch (error) {
        console.error(
          "Textract OCR error:",
          error,
        );

        return {
          valid: false,
          documentType: "unknown",
        };
      }

      const text = getText(
        ocrResponse.Blocks,
      );

      // console.log(
      //   "Textract OCR text:",
      //   text,
      // );

      /**
       * -----------------------------------------------------
       * STEP 2: DETECT DOCUMENT TYPE
       * -----------------------------------------------------
       */
      const documentType =
        detectDocumentType(text);

      // console.log(
      //   "Detected document type:",
      //   documentType,
      // );

      if (
        documentType === "unknown"
      ) {
        return {
          valid: false,
          documentType: "unknown",
        };
      }

      /**
       * -----------------------------------------------------
       * STEP 3: TEXTRACT QUERIES
       *
       * Queries are supporting validation only.
       * OCR remains the fallback.
       * -----------------------------------------------------
       */
      let fields: QueryFields = {};

      try {
        const queries =
          getDocumentQueries(
            documentType,
          );

        const analyzeResponse =
          await textract
            .analyzeDocument({
              Document: {
                Bytes: buffer,
              },
              FeatureTypes: [
                "QUERIES",
                "FORMS",
                "LAYOUT",
              ],
              QueriesConfig: {
                Queries: queries,
              },
            })
            .promise();

        fields = getQueryResults(
          analyzeResponse.Blocks,
        );

        // console.log(
        //   "Textract query fields:",
        //   fields,
        // );
      } catch (error) {
        /**
         * AnalyzeDocument is NOT required for the
         * complete validation because OCR fallback
         * is available.
         */
        console.error(
          "Textract AnalyzeDocument error:",
          error,
        );

        fields = {};
      }

      /**
       * -----------------------------------------------------
       * STEP 4: DOCUMENT NUMBER
       *
       * Query result OR OCR.
       * -----------------------------------------------------
       */
      const documentNumberValid =
        validateDocumentNumber(
          documentType,
          text,
          fields,
        );

      // console.log(
      //   "Document number valid:",
      //   documentNumberValid,
      // );

      if (!documentNumberValid) {
        console.log(
          "DOCUMENT NUMBER VALIDATION FAILED",
          {
            documentType,
            extractedNumber:
              extractDocumentNumber(
                documentType,
                text,
              ),
            queryFields: fields,
          },
        );

        return {
          valid: false,
          documentType,
        };
      }

      /**
       * -----------------------------------------------------
       * STEP 5: DOCUMENT-SPECIFIC VALIDATION
       * -----------------------------------------------------
       */
      const normalizedText =
        normalizeText(text);

      switch (documentType) {
        /**
         * ---------------------------------------------------
         * AADHAAR
         * ---------------------------------------------------
         */
        case "aadhaar": {
          const hasAadhaarIdentity =
            normalizedText.includes(
              "AADHAAR",
            ) ||
            normalizedText.includes(
              "UIDAI",
            ) ||
            normalizedText.includes(
              "GOVERNMENT OF INDIA",
            ) ||
            normalizedText.includes(
              "UNIQUE IDENTIFICATION",
            );

          if (!hasAadhaarIdentity) {
            return {
              valid: false,
              documentType,
            };
          }

          /**
           * DOB is intentionally NOT a hard requirement.
           *
           * OCR can miss DOB even when the Aadhaar is valid.
           */
          break;
        }

        /**
         * ---------------------------------------------------
         * PASSPORT
         * ---------------------------------------------------
         */
        case "passport": {
          const hasPassportIdentity =
            normalizedText.includes(
              "PASSPORT",
            ) ||
            normalizedText.includes(
              "REPUBLIC OF INDIA",
            );

          if (!hasPassportIdentity) {
            return {
              valid: false,
              documentType,
            };
          }

          /**
           * DOB is supporting information only.
           * It is NOT mandatory.
           */
          break;
        }

        /**
         * ---------------------------------------------------
         * DRIVING LICENCE
         * ---------------------------------------------------
         */
        case "driving-license": {
          const hasDrivingIdentity =
            normalizedText.includes(
              "DRIVING LICENCE",
            ) ||
            normalizedText.includes(
              "DRIVING LICENSE",
            ) ||
            normalizedText.includes(
              "LICENCE TO DRIVE",
            ) ||
            normalizedText.includes(
              "LICENSE TO DRIVE",
            ) ||
            normalizedText.includes(
              "TRANSPORT",
            ) ||
            normalizedText.includes(
              "MOTOR VEHICLES",
            ) ||
            normalizedText.includes(
              "MOTOR VEHICLE",
            );

          if (!hasDrivingIdentity) {
            return {
              valid: false,
              documentType,
            };
          }

          /**
           * DOB is supporting information only.
           */
          break;
        }

        /**
         * ---------------------------------------------------
         * PAN
         * ---------------------------------------------------
         */
        case "pan": {
          const hasPanIdentity =
            normalizedText.includes(
              "INCOME TAX",
            ) ||
            normalizedText.includes(
              "PERMANENT ACCOUNT NUMBER",
            );

          if (!hasPanIdentity) {
            return {
              valid: false,
              documentType,
            };
          }

          /**
           * DOB is supporting information only.
           */
          break;
        }

        /**
         * ---------------------------------------------------
         * VOTER ID
         * ---------------------------------------------------
         */
        case "voter-id": {
          const hasVoterIdentity =
            normalizedText.includes(
              "ELECTION COMMISSION",
            ) ||
            normalizedText.includes(
              "ELECTOR PHOTO IDENTITY CARD",
            ) ||
            normalizedText.includes(
              "ELECTOR PHOTO",
            ) ||
            normalizedText.includes(
              "ELECTORAL PHOTO IDENTITY CARD",
            ) ||
            normalizedText.includes(
              "ELECTOR",
            ) ||
            normalizedText.includes(
              "EPIC",
            ) ||
            normalizedText.includes(
              "VOTER",
            );

          if (!hasVoterIdentity) {
            return {
              valid: false,
              documentType,
            };
          }

          break;
        }

        default:
          return {
            valid: false,
            documentType: "unknown",
          };
      }

      /**
       * -----------------------------------------------------
       * STEP 6: PHOTO / FACE CHECK
       *
       * If Rekognition works:
       *   face found    -> continue
       *   no face found -> invalid
       *
       * If Rekognition itself fails:
       *   continue using document/OCR validation
       * -----------------------------------------------------
       */
      const photoExists =
        await hasFace(buffer);

      if (!photoExists) {
        console.log(
          "DOCUMENT PHOTO / FACE NOT DETECTED",
        );

        return {
          valid: false,
          documentType,
        };
      }

      /**
       * -----------------------------------------------------
       * STEP 7: VALID
       * -----------------------------------------------------
       */
      // console.log(
      //   "GOVERNMENT DOCUMENT VALID:",
      //   documentType,
      // );

      return {
        valid: true,
        documentType,
      };
    } catch (error) {
      console.error(
        "Government document validation error:",
        error,
      );

      return {
        valid: false,
        documentType: "unknown",
      };
    }
  };