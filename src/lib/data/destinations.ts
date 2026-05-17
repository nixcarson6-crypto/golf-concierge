/**
 * Curated knowledge base of premium golf destinations.
 *
 * The destination + itinerary agents are GROUNDED on this data — we feed it
 * to the prompt as authoritative reference so the model isn't guessing about
 * course names, hotel tiers, neighbourhood logistics, or seasonal weather.
 *
 * Add markets here as we expand. Each entry stays terse and factual; the
 * agent fills in voice + group-specific reasoning.
 */

export type Month =
  | "Jan" | "Feb" | "Mar" | "Apr" | "May" | "Jun"
  | "Jul" | "Aug" | "Sep" | "Oct" | "Nov" | "Dec";

export type WeatherWindow = {
  /** "great" / "good" / "fair" / "poor" by month — UX-friendly rather than numeric */
  rating: "great" | "good" | "fair" | "poor";
  note: string;
};

export type GolfCourse = {
  name: string;
  tier: "resort" | "championship" | "private-access" | "boutique";
  notes: string;
  /** Approx peak-season green fee per player, USD */
  greenFee?: number;
};

export type LodgingOption = {
  name: string;
  tier: "premium" | "luxury" | "ultra-luxury";
  notes: string;
  /** Approx nightly rate per room, USD */
  nightlyRate?: number;
};

export type DiningPick = {
  name: string;
  vibe: string;
  cuisine: string;
};

export type DestinationKB = {
  slug: string;
  name: string;
  region: string;
  airports: string[];
  bestMonths: Month[];
  weather: Record<Month, WeatherWindow>;
  courses: GolfCourse[];
  lodging: LodgingOption[];
  dining: DiningPick[];
  nightlife: DiningPick[];
  logistics: string;
  /** Honest 0–100 score on logistics: airport access, drive times, walkability */
  logisticsScore: number;
  /** Honest 0–100 score on nightlife depth */
  nightlifeScore: number;
  /** Honest 0–100 score on golf depth */
  golfScore: number;
  heroImageQuery: string;
};

export const DESTINATIONS: DestinationKB[] = [
  {
    slug: "scottsdale",
    name: "Scottsdale, AZ",
    region: "Sonoran Desert",
    airports: ["PHX (Sky Harbor) — 20 min"],
    bestMonths: ["Jan", "Feb", "Mar", "Apr", "Oct", "Nov"],
    weather: {
      Jan: { rating: "good", note: "Cool mornings, 65–70°F afternoons" },
      Feb: { rating: "great", note: "70°F afternoons, peak conditioning" },
      Mar: { rating: "great", note: "Mid-70s, ideal" },
      Apr: { rating: "great", note: "Warming, 80°F, still excellent" },
      May: { rating: "fair", note: "Mid-90s by afternoon — early tees only" },
      Jun: { rating: "poor", note: "Triple digits, brutal" },
      Jul: { rating: "poor", note: "Monsoon, 110°F" },
      Aug: { rating: "poor", note: "Same as July" },
      Sep: { rating: "fair", note: "Cooling, still hot, value rates" },
      Oct: { rating: "great", note: "80s, courses re-conditioning" },
      Nov: { rating: "great", note: "Crisp, 70s, prime" },
      Dec: { rating: "good", note: "60s–70s, lower demand" },
    },
    courses: [
      { name: "Troon North — Monument", tier: "championship", notes: "Iconic Sonoran desert routing, Tom Weiskopf design", greenFee: 350 },
      { name: "Troon North — Pinnacle", tier: "championship", notes: "Sister to Monument, dramatic elevation changes", greenFee: 325 },
      { name: "We-Ko-Pa — Saguaro", tier: "championship", notes: "Walkable, Coore/Crenshaw routing, no homes on course", greenFee: 295 },
      { name: "We-Ko-Pa — Cholla", tier: "championship", notes: "Bigger, bolder sister course", greenFee: 285 },
      { name: "TPC Scottsdale — Stadium", tier: "championship", notes: "Home of the WM Phoenix Open, the 16th hole", greenFee: 425 },
      { name: "Grayhawk — Raptor", tier: "championship", notes: "Tom Fazio, host of NCAA championships", greenFee: 295 },
      { name: "Boulders — North", tier: "resort", notes: "Boulder-strewn dramatic, scenic", greenFee: 235 },
      { name: "Talking Stick — O'odham", tier: "championship", notes: "Coore/Crenshaw flatter desert, fast greens", greenFee: 195 },
    ],
    lodging: [
      { name: "The Phoenician", tier: "luxury", notes: "Camelback foothills, multi-pool, refined", nightlyRate: 650 },
      { name: "Four Seasons Troon North", tier: "ultra-luxury", notes: "Casita-style, walking distance to Troon North", nightlyRate: 1100 },
      { name: "Boulders Resort", tier: "luxury", notes: "Casitas tucked into the boulders, 36 holes on site", nightlyRate: 580 },
      { name: "Andaz Scottsdale", tier: "luxury", notes: "Design-forward, Old Town adjacent", nightlyRate: 525 },
      { name: "Mountain Shadows", tier: "premium", notes: "Modernist, par-3 course, group-friendly", nightlyRate: 425 },
    ],
    dining: [
      { name: "FnB", vibe: "Chef-driven", cuisine: "New American, seasonal" },
      { name: "Citizen Public House", vibe: "Smart casual", cuisine: "American gastropub" },
      { name: "Mastro's Steakhouse", vibe: "Power dinner", cuisine: "Steak" },
      { name: "Maple & Ash", vibe: "Loud, fun, expensive", cuisine: "Steak" },
    ],
    nightlife: [
      { name: "Bottled Blonde", vibe: "Late night, packed", cuisine: "Bar + scene" },
      { name: "Maya Day + Nightclub", vibe: "Pool by day, club by night", cuisine: "Club" },
      { name: "Casa Amigos", vibe: "Old Town energy", cuisine: "Tequila bar" },
    ],
    logistics: "Sky Harbor is 20 minutes from most resorts; courses cluster 15–35 min apart in the north Scottsdale corridor.",
    logisticsScore: 88,
    nightlifeScore: 82,
    golfScore: 94,
    heroImageQuery: "Troon North Scottsdale Arizona desert golf sunrise",
  },
  {
    slug: "pinehurst",
    name: "Pinehurst, NC",
    region: "Sandhills, North Carolina",
    airports: ["RDU — 90 min", "FAY — 40 min"],
    bestMonths: ["Mar", "Apr", "May", "Sep", "Oct", "Nov"],
    weather: {
      Jan: { rating: "fair", note: "Chilly, low-50s, can be playable" },
      Feb: { rating: "fair", note: "Cool, occasional warm days" },
      Mar: { rating: "good", note: "Spring conditioning begins, 60s" },
      Apr: { rating: "great", note: "70s, dogwoods in bloom" },
      May: { rating: "great", note: "75–80°F, ideal" },
      Jun: { rating: "good", note: "85°F+, humid afternoons" },
      Jul: { rating: "fair", note: "Sticky, afternoon thunderstorms" },
      Aug: { rating: "fair", note: "Same as July" },
      Sep: { rating: "great", note: "80s, lower humidity returning" },
      Oct: { rating: "great", note: "Crisp, 70s, prime" },
      Nov: { rating: "great", note: "60s, gorgeous light" },
      Dec: { rating: "good", note: "50s, lower demand" },
    },
    courses: [
      { name: "Pinehurst No. 2", tier: "championship", notes: "Donald Ross masterpiece, host of multiple US Opens", greenFee: 575 },
      { name: "Pinehurst No. 4", tier: "championship", notes: "Hanse-redesigned, dramatic sandscape", greenFee: 425 },
      { name: "Pinehurst No. 8", tier: "championship", notes: "Centennial course, Fazio, longer", greenFee: 325 },
      { name: "Pinehurst No. 10", tier: "championship", notes: "Hanse, opened 2024, sandhills walkable", greenFee: 425 },
      { name: "Tobacco Road", tier: "championship", notes: "Mike Strantz, blind shots, unforgettable", greenFee: 195 },
      { name: "Pine Needles", tier: "championship", notes: "Donald Ross, hosted US Women's Opens", greenFee: 235 },
      { name: "Mid Pines", tier: "championship", notes: "Ross sister to Pine Needles, walkable", greenFee: 195 },
    ],
    lodging: [
      { name: "The Carolina Hotel (Pinehurst Resort)", tier: "luxury", notes: "Grand dame on resort, walk to clubhouse", nightlyRate: 595 },
      { name: "The Holly Inn", tier: "luxury", notes: "Boutique village option on resort", nightlyRate: 525 },
      { name: "The Cradle Cottages", tier: "premium", notes: "Group-friendly buyouts walking distance to Cradle short course", nightlyRate: 425 },
      { name: "Pine Crest Inn", tier: "premium", notes: "Classic village inn, walking everywhere", nightlyRate: 295 },
    ],
    dining: [
      { name: "1895 Grille", vibe: "Resort fine dining", cuisine: "American" },
      { name: "The Deuce", vibe: "On the 18th green of No. 2", cuisine: "American" },
      { name: "Drum & Quill Pub", vibe: "Village pub, classic", cuisine: "Pub" },
      { name: "Elliotts on Linden", vibe: "Local favourite", cuisine: "New American" },
    ],
    nightlife: [
      { name: "Pinehurst Brewing Company", vibe: "Brewery, relaxed", cuisine: "Brewery" },
      { name: "The Ryder Cup Lounge", vibe: "Resort bar, late", cuisine: "Cocktails" },
    ],
    logistics: "Village is fully walkable; courses cluster within 15 min. RDU 90 min drive, Fayetteville closer but smaller.",
    logisticsScore: 78,
    nightlifeScore: 55,
    golfScore: 97,
    heroImageQuery: "Pinehurst No 2 fairway sandhills North Carolina",
  },
  {
    slug: "myrtle-beach",
    name: "Myrtle Beach, SC",
    region: "Grand Strand, South Carolina",
    airports: ["MYR — 15 min"],
    bestMonths: ["Mar", "Apr", "May", "Sep", "Oct", "Nov"],
    weather: {
      Jan: { rating: "fair", note: "Mid-50s, can play in mid-day" },
      Feb: { rating: "fair", note: "Warming, 55–65" },
      Mar: { rating: "good", note: "60s, conditions improving" },
      Apr: { rating: "great", note: "70s, classic season" },
      May: { rating: "great", note: "75–80°F" },
      Jun: { rating: "good", note: "85°F, beach + afternoon storms" },
      Jul: { rating: "fair", note: "Hot, humid, busy" },
      Aug: { rating: "fair", note: "Same as July" },
      Sep: { rating: "great", note: "80s, prime, hurricane window" },
      Oct: { rating: "great", note: "70s, ideal" },
      Nov: { rating: "great", note: "60s, value pricing" },
      Dec: { rating: "good", note: "50s, very quiet" },
    },
    courses: [
      { name: "Caledonia Golf & Fish Club", tier: "championship", notes: "Mike Strantz, classic low-country routing", greenFee: 225 },
      { name: "True Blue", tier: "championship", notes: "Strantz sister to Caledonia, dramatic", greenFee: 215 },
      { name: "Dunes Golf & Beach Club", tier: "championship", notes: "RTJ Sr, oceanside, classic", greenFee: 285 },
      { name: "Tidewater", tier: "championship", notes: "Coastal marsh views, walkable", greenFee: 175 },
      { name: "TPC Myrtle Beach", tier: "championship", notes: "Tom Fazio, championship test", greenFee: 195 },
      { name: "Pine Lakes Country Club", tier: "resort", notes: "Original, classic, walkable village", greenFee: 145 },
    ],
    lodging: [
      { name: "Marina Inn at Grande Dunes", tier: "luxury", notes: "Intracoastal views, on course", nightlyRate: 395 },
      { name: "Hammock Beach (Pawleys Island)", tier: "luxury", notes: "South strand, quieter", nightlyRate: 495 },
      { name: "Litchfield Beach & Golf", tier: "premium", notes: "Multiple villa configurations, group-friendly", nightlyRate: 285 },
      { name: "Beach Club at Grande Dunes", tier: "premium", notes: "Beachfront, package-friendly", nightlyRate: 325 },
    ],
    dining: [
      { name: "Greg Norman's Australian Grille", vibe: "Steakhouse, group-friendly", cuisine: "Steak/seafood" },
      { name: "Frank's Restaurant (Pawleys)", vibe: "Refined, low-country", cuisine: "Southern" },
      { name: "Sea Captain's House", vibe: "Oceanfront classic", cuisine: "Seafood" },
    ],
    nightlife: [
      { name: "Broadway at the Beach", vibe: "Touristy entertainment district", cuisine: "Bars + clubs" },
      { name: "The Boathouse", vibe: "Waterfront", cuisine: "Bar + live music" },
    ],
    logistics: "MYR is 15 min from most lodging. Courses spread north–south across 60 miles of strand; pick a base and stay regional.",
    logisticsScore: 82,
    nightlifeScore: 70,
    golfScore: 88,
    heroImageQuery: "Caledonia Golf Fish Club South Carolina coastal",
  },
  {
    slug: "las-vegas",
    name: "Las Vegas, NV",
    region: "Mojave Desert",
    airports: ["LAS (Harry Reid) — 15 min"],
    bestMonths: ["Feb", "Mar", "Apr", "Oct", "Nov", "Dec"],
    weather: {
      Jan: { rating: "fair", note: "50–60°F, cold mornings" },
      Feb: { rating: "good", note: "60s, comfortable" },
      Mar: { rating: "great", note: "70s, prime" },
      Apr: { rating: "great", note: "80°F, ideal" },
      May: { rating: "good", note: "90°F, early tees only" },
      Jun: { rating: "poor", note: "100°F+" },
      Jul: { rating: "poor", note: "110°F" },
      Aug: { rating: "poor", note: "Same as July" },
      Sep: { rating: "fair", note: "Cooling, low 90s" },
      Oct: { rating: "great", note: "80s, ideal" },
      Nov: { rating: "great", note: "70s, prime" },
      Dec: { rating: "good", note: "60s, lower demand" },
    },
    courses: [
      { name: "Shadow Creek", tier: "private-access", notes: "MGM resort guest-only, Tom Fazio, legendary", greenFee: 1250 },
      { name: "Wynn Golf Club", tier: "private-access", notes: "Steve Wynn redesign, on-property, helicopter tee box", greenFee: 950 },
      { name: "Cascata", tier: "championship", notes: "Caesars-affiliated, a waterfall through the clubhouse", greenFee: 525 },
      { name: "Reflection Bay", tier: "championship", notes: "Jack Nicklaus, Lake Las Vegas, walkable resort", greenFee: 295 },
      { name: "Bali Hai", tier: "resort", notes: "On the Strip, novelty, fine course", greenFee: 295 },
      { name: "Las Vegas Paiute — Snow Mountain", tier: "championship", notes: "30 min north, wide open, value", greenFee: 195 },
    ],
    lodging: [
      { name: "Wynn / Encore", tier: "ultra-luxury", notes: "On-Strip, on-property golf", nightlyRate: 750 },
      { name: "Aria", tier: "luxury", notes: "Modern, central Strip", nightlyRate: 525 },
      { name: "Four Seasons (in Mandalay Bay)", tier: "ultra-luxury", notes: "South Strip, no casino on floor", nightlyRate: 695 },
      { name: "Bellagio", tier: "luxury", notes: "Iconic, central, suites for groups", nightlyRate: 595 },
    ],
    dining: [
      { name: "Carbone", vibe: "Power dinner, theatrical", cuisine: "Italian-American" },
      { name: "Bavette's Steakhouse", vibe: "Speakeasy steak", cuisine: "Steak" },
      { name: "Sushi Roku (Caesars)", vibe: "Group sushi", cuisine: "Japanese" },
      { name: "Bazaar Meat by José Andrés", vibe: "Carnivore-driven, fun", cuisine: "Steak/Spanish" },
    ],
    nightlife: [
      { name: "XS Nightclub (Encore)", vibe: "Megaclub", cuisine: "Club" },
      { name: "Hakkasan (MGM Grand)", vibe: "Megaclub + dining", cuisine: "Club" },
      { name: "Stadium Swim (Circa)", vibe: "Pool + sportsbook", cuisine: "Day club" },
    ],
    logistics: "LAS is 15 min from the Strip. Most courses 20–40 min away. Shadow Creek + Wynn are on-property perks.",
    logisticsScore: 92,
    nightlifeScore: 98,
    golfScore: 86,
    heroImageQuery: "Shadow Creek golf course Las Vegas pine forest",
  },
  {
    slug: "naples",
    name: "Naples, FL",
    region: "Southwest Florida",
    airports: ["RSW (Fort Myers) — 35 min", "APF (Naples) — 10 min"],
    bestMonths: ["Jan", "Feb", "Mar", "Apr", "Nov", "Dec"],
    weather: {
      Jan: { rating: "great", note: "75°F, dry season" },
      Feb: { rating: "great", note: "Same, peak demand" },
      Mar: { rating: "great", note: "80°F, prime" },
      Apr: { rating: "great", note: "85°F, ideal" },
      May: { rating: "good", note: "90°F, humidity rising" },
      Jun: { rating: "fair", note: "Wet season begins, daily storms" },
      Jul: { rating: "poor", note: "Stormy, humid" },
      Aug: { rating: "poor", note: "Same" },
      Sep: { rating: "poor", note: "Hurricane season peak" },
      Oct: { rating: "fair", note: "Drying out" },
      Nov: { rating: "great", note: "Dry season returns, 80°F" },
      Dec: { rating: "great", note: "75°F, ideal" },
    },
    courses: [
      { name: "Tiburón (Ritz-Carlton Naples) — Black", tier: "resort", notes: "Greg Norman, host of QBE Shootout", greenFee: 425 },
      { name: "Tiburón — Gold", tier: "resort", notes: "Sister to Black, classic resort routing", greenFee: 395 },
      { name: "Calusa Pines", tier: "private-access", notes: "Ultra-private, requires member sponsorship", greenFee: 0 },
      { name: "Old Corkscrew", tier: "championship", notes: "Jack Nicklaus public access, scenic", greenFee: 245 },
      { name: "Tarpon Cove", tier: "boutique", notes: "Walkable, intimate", greenFee: 165 },
    ],
    lodging: [
      { name: "Ritz-Carlton Naples (Beach)", tier: "ultra-luxury", notes: "Beachfront, classic, on-property golf", nightlyRate: 1100 },
      { name: "Ritz-Carlton Naples (Tiburón)", tier: "ultra-luxury", notes: "Golf-resort campus", nightlyRate: 895 },
      { name: "Inn on Fifth", tier: "luxury", notes: "Downtown Naples, walkable", nightlyRate: 625 },
      { name: "LaPlaya Beach Resort", tier: "luxury", notes: "Beachfront, smaller scale", nightlyRate: 595 },
    ],
    dining: [
      { name: "Sails", vibe: "White-tablecloth, harbour view", cuisine: "Seafood/Mediterranean" },
      { name: "Bleu Provence", vibe: "Romantic, French", cuisine: "French" },
      { name: "USS Nemo", vibe: "Local seafood institution", cuisine: "Seafood" },
    ],
    nightlife: [
      { name: "Bar Tulia", vibe: "Cocktails on Fifth", cuisine: "Cocktails" },
      { name: "The Continental", vibe: "Upscale piano bar", cuisine: "Cocktails" },
    ],
    logistics: "RSW is 35 min, Naples small airport is 10 min for private. Tight cluster around 41/Vanderbilt corridors.",
    logisticsScore: 80,
    nightlifeScore: 60,
    golfScore: 84,
    heroImageQuery: "Ritz Carlton Naples Florida palm trees beach golf",
  },
  {
    slug: "streamsong",
    name: "Streamsong, FL (Central Florida)",
    region: "Central Florida sandhills",
    airports: ["TPA — 75 min", "MCO — 90 min"],
    bestMonths: ["Jan", "Feb", "Mar", "Apr", "Nov", "Dec"],
    weather: {
      Jan: { rating: "great", note: "70°F, dry" },
      Feb: { rating: "great", note: "75°F" },
      Mar: { rating: "great", note: "80°F" },
      Apr: { rating: "great", note: "85°F" },
      May: { rating: "good", note: "Hot, humidity rising" },
      Jun: { rating: "fair", note: "Wet, stormy afternoons" },
      Jul: { rating: "poor", note: "Stormy" },
      Aug: { rating: "poor", note: "Same" },
      Sep: { rating: "fair", note: "Improving" },
      Oct: { rating: "good", note: "Drying" },
      Nov: { rating: "great", note: "75°F" },
      Dec: { rating: "great", note: "70°F" },
    },
    courses: [
      { name: "Streamsong Red", tier: "championship", notes: "Coore/Crenshaw, sandy heaving routing", greenFee: 295 },
      { name: "Streamsong Blue", tier: "championship", notes: "Tom Doak, expansive walking course", greenFee: 295 },
      { name: "Streamsong Black", tier: "championship", notes: "Gil Hanse, the biggest of the three", greenFee: 295 },
      { name: "The Chain (Streamsong)", tier: "boutique", notes: "Hanse short course, 19 holes, post-round play", greenFee: 95 },
    ],
    lodging: [
      { name: "The Lodge at Streamsong", tier: "luxury", notes: "Modernist, on property, walking to all courses", nightlyRate: 525 },
    ],
    dining: [
      { name: "P2O5 (Streamsong)", vibe: "Resort fine dining", cuisine: "American" },
      { name: "Restaurant Fragmentary Blue", vibe: "Casual on property", cuisine: "American" },
    ],
    nightlife: [
      { name: "Resort bar", vibe: "Quiet, golfers", cuisine: "Cocktails" },
    ],
    logistics: "Remote — 75–90 min from both major airports. The point is the golf bubble: stay on property.",
    logisticsScore: 60,
    nightlifeScore: 25,
    golfScore: 96,
    heroImageQuery: "Streamsong Black golf course Florida sandhills",
  },
];

export function findDestination(query: string): DestinationKB | null {
  const q = query.toLowerCase().trim();
  return (
    DESTINATIONS.find((d) => d.slug === q) ??
    DESTINATIONS.find((d) => d.name.toLowerCase() === q) ??
    DESTINATIONS.find((d) => q.includes(d.slug) || d.name.toLowerCase().includes(q)) ??
    null
  );
}

/** Compact representation handed to AI agents as grounding context. */
export function destinationBriefForAI(d: DestinationKB) {
  return {
    name: d.name,
    region: d.region,
    airports: d.airports,
    bestMonths: d.bestMonths,
    scores: {
      golf: d.golfScore,
      nightlife: d.nightlifeScore,
      logistics: d.logisticsScore,
    },
    courses: d.courses.map((c) => ({
      name: c.name,
      tier: c.tier,
      notes: c.notes,
      greenFee: c.greenFee ?? null,
    })),
    lodging: d.lodging.map((l) => ({
      name: l.name,
      tier: l.tier,
      notes: l.notes,
      nightlyRate: l.nightlyRate ?? null,
    })),
    dining: d.dining,
    nightlife: d.nightlife,
    logistics: d.logistics,
  };
}

export function allDestinationsBriefForAI() {
  return DESTINATIONS.map(destinationBriefForAI);
}

export function weatherFitForMonth(d: DestinationKB, month: Month) {
  return d.weather[month];
}

export function monthFromDate(date: Date | string | null | undefined): Month | null {
  if (!date) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return (["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"] as Month[])[d.getMonth()];
}
