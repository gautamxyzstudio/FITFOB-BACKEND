export const normalizeIdentifier = (input: string): string => {
  if (!input) throw new Error("Identifier required");

  let identifier = input.trim();

  /* ---------------- EMAIL ---------------- */
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (emailRegex.test(identifier)) {
    return identifier.toLowerCase();
  }

  /* ---------------- PHONE ---------------- */

  // remove all non-digits
  let digits = identifier.replace(/\D/g, "");

  // 8687455555 → +918687455555
  if (digits.length === 10) {
    return `+91${digits}`;
  }

  // 918687455555 → +918687455555
  if (digits.length === 12 && digits.startsWith("91")) {
    return `+${digits}`;
  }

  // already correct
  if (identifier.startsWith("+91") && digits.length === 12) {
    return identifier;
  }

  throw new Error("Invalid email or phone number format");
};