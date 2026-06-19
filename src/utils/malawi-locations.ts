/** Major Malawian cities and towns used for location validation and cross-sell matching. */
export const MALAWI_CITIES = [
  "Blantyre",
  "Lilongwe",
  "Mzuzu",
  "Zomba",
  "Kasungu",
  "Mangochi",
  "Salima",
  "Nkhotakota",
  "Karonga",
  "Nkhata Bay",
  "Dedza",
  "Ntcheu",
  "Balaka",
  "Mchinji",
  "Rumphi",
  "Chitipa",
  "Thyolo",
  "Mulanje",
  "Nsanje",
  "Chikwawa",
] as const;

export type MalawiCity = (typeof MALAWI_CITIES)[number];

function normalizeForMatch(value: string): string {
  return value.trim().toLowerCase();
}

/** True when text contains a known Malawi place name (city or town). */
export function textContainsMalawiPlace(text: string): boolean {
  const hay = normalizeForMatch(text);
  if (!hay) return false;
  return MALAWI_CITIES.some((city) => hay.includes(normalizeForMatch(city)));
}

/** Extract the first matching Malawi place from free-form location text. */
export function extractMalawiPlace(text: string): string | null {
  const hay = normalizeForMatch(text);
  if (!hay) return null;
  for (const city of MALAWI_CITIES) {
    if (hay.includes(normalizeForMatch(city))) return city;
  }
  return null;
}

export function assertListingLocation(
  kind: "event" | "travel",
  status: string,
  location: string,
  routeFrom: string | null | undefined,
  routeTo: string | null | undefined,
  eventFormat: "physical" | "virtual" = "physical",
): void {
  const publishing = status === "published" || status === "sold_out";
  if (!publishing) return;

  if (kind === "event" && eventFormat === "virtual") {
    return;
  }

  const loc = location.trim();
  if (kind === "event" && normalizeForMatch(loc) === "online") {
    return;
  }

  if (kind === "event") {
    if (!loc) {
      throw new Error("Venue / location is required before publishing. Include the city, e.g. Amaryllis Hotel, Blantyre.");
    }
    if (loc.length < 5) {
      throw new Error("Location is too short. Enter the venue and city, e.g. BICC, Lilongwe.");
    }
    if (!textContainsMalawiPlace(loc)) {
      throw new Error(
        `Location must include a Malawian city or town (${MALAWI_CITIES.slice(0, 5).join(", ")}, …).`,
      );
    }
    return;
  }

  const from = String(routeFrom ?? "").trim();
  const to = String(routeTo ?? "").trim();
  if (!from || !to) {
    throw new Error("Route from and route to are required before publishing travel.");
  }
  if (!textContainsMalawiPlace(from)) {
    throw new Error(`Route from must be a known Malawian city (e.g. Blantyre).`);
  }
  if (!textContainsMalawiPlace(to)) {
    throw new Error(`Route to must be a known Malawian city (e.g. Lilongwe).`);
  }
  if (!loc) {
    throw new Error("Boarding / arrival point is required before publishing (e.g. Wenela Terminal, Lilongwe).");
  }
}
