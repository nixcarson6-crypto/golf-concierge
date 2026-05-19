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
    slug: "hilton-head",
    name: "Hilton Head Island, SC",
    region: "Low Country, South Carolina",
    airports: ["HHH — 10 min", "SAV — 40 min"],
    bestMonths: ["Mar", "Apr", "May", "Sep", "Oct", "Nov"],
    weather: {
      Jan: { rating: "fair", note: "Cool, mid-50s, possible play" },
      Feb: { rating: "fair", note: "55–65, warming" },
      Mar: { rating: "good", note: "60s–70s, season opening" },
      Apr: { rating: "great", note: "70s, classic" },
      May: { rating: "great", note: "75–82°F" },
      Jun: { rating: "good", note: "85°F, humid, afternoon storms" },
      Jul: { rating: "fair", note: "Hot, humid, busy beaches" },
      Aug: { rating: "fair", note: "Same as July" },
      Sep: { rating: "great", note: "80s, lower humidity, hurricane window" },
      Oct: { rating: "great", note: "70s, prime" },
      Nov: { rating: "great", note: "60s, gorgeous light" },
      Dec: { rating: "good", note: "50s, quiet" },
    },
    courses: [
      { name: "Harbour Town Golf Links", tier: "championship", notes: "RTJ Sr / Pete Dye, host of RBC Heritage", greenFee: 425 },
      { name: "Atlantic Dunes (Sea Pines)", tier: "championship", notes: "Davis Love III redesign, ocean adjacent", greenFee: 275 },
      { name: "Heron Point", tier: "championship", notes: "Pete Dye, Sea Pines third course", greenFee: 245 },
      { name: "May River (Palmetto Bluff)", tier: "championship", notes: "Jack Nicklaus, low country river views", greenFee: 295 },
      { name: "Colleton River (Dye)", tier: "private-access", notes: "Member-sponsored only, top 100 nationally", greenFee: 0 },
    ],
    lodging: [
      { name: "Montage Palmetto Bluff", tier: "ultra-luxury", notes: "Riverfront cottages, Auberge-tier, on May River", nightlyRate: 1250 },
      { name: "Inn & Club at Harbour Town", tier: "luxury", notes: "Walk to first tee, sea pines plantation", nightlyRate: 595 },
      { name: "Sea Pines Resort villas", tier: "premium", notes: "Group-friendly buyouts, oceanside or course-side", nightlyRate: 425 },
    ],
    dining: [
      { name: "Quarterdeck Restaurant", vibe: "Harbour Town classic", cuisine: "Low country" },
      { name: "Old Fort Pub", vibe: "Sunset oyster scene", cuisine: "Southern seafood" },
      { name: "Skull Creek Boathouse", vibe: "Waterfront, group-friendly", cuisine: "Seafood" },
    ],
    nightlife: [
      { name: "The Salty Dog Cafe", vibe: "Iconic waterfront, casual", cuisine: "Bar + casual" },
      { name: "Holy Tequila", vibe: "Late night, lively", cuisine: "Mexican / bar" },
    ],
    logistics: "HHH local airport is 10 min, Savannah 40 min, Charleston 2 hr. Courses cluster south end of the island; Palmetto Bluff is across the bridge in Bluffton.",
    logisticsScore: 78,
    nightlifeScore: 58,
    golfScore: 90,
    heroImageQuery: "Harbour Town lighthouse golf course South Carolina",
  },
  {
    slug: "bandon-dunes",
    name: "Bandon Dunes, OR",
    region: "Oregon coast, links country",
    airports: ["EUG — 2.5 hr drive", "PDX — 4.5 hr drive", "OTH (North Bend) — 30 min"],
    bestMonths: ["May", "Jun", "Jul", "Aug", "Sep", "Oct"],
    weather: {
      Jan: { rating: "fair", note: "Wet, 50°F, true links weather" },
      Feb: { rating: "fair", note: "Same — value pricing" },
      Mar: { rating: "good", note: "Drying, 55°F" },
      Apr: { rating: "good", note: "60°F, fewer rain days" },
      May: { rating: "great", note: "60–65°F, classic conditions" },
      Jun: { rating: "great", note: "65°F, prime light" },
      Jul: { rating: "great", note: "65–70°F, gorgeous" },
      Aug: { rating: "great", note: "Same — high demand" },
      Sep: { rating: "great", note: "65°F, prime" },
      Oct: { rating: "good", note: "55–60°F, value returning" },
      Nov: { rating: "fair", note: "Wet, true links experience" },
      Dec: { rating: "fair", note: "Same" },
    },
    courses: [
      { name: "Pacific Dunes", tier: "championship", notes: "Tom Doak masterpiece, walkable, ranked top 5 US public", greenFee: 425 },
      { name: "Bandon Dunes", tier: "championship", notes: "David McLay Kidd, the original, classic links", greenFee: 425 },
      { name: "Old Macdonald", tier: "championship", notes: "Doak + Urbina tribute to CB Macdonald, expansive", greenFee: 395 },
      { name: "Bandon Trails", tier: "championship", notes: "Coore/Crenshaw, inland through the dunes and forest", greenFee: 395 },
      { name: "Sheep Ranch", tier: "championship", notes: "Coore/Crenshaw 2020 cliff-edge routing", greenFee: 425 },
      { name: "Shorty's / Punchbowl", tier: "boutique", notes: "Par-3 + putting course, post-round play", greenFee: 95 },
    ],
    lodging: [
      { name: "The Lodge at Bandon Dunes", tier: "luxury", notes: "On property, walking to all courses", nightlyRate: 575 },
      { name: "Chrome Lake Suites", tier: "luxury", notes: "Larger units, group-friendly", nightlyRate: 695 },
      { name: "Lily Pond Cottages", tier: "luxury", notes: "Multi-bedroom, walkable", nightlyRate: 825 },
    ],
    dining: [
      { name: "The Gallery", vibe: "Resort fine dining, post-golf", cuisine: "Pacific Northwest" },
      { name: "Trails End", vibe: "Casual, on property", cuisine: "American" },
      { name: "Pacific Grill", vibe: "Steaks + seafood", cuisine: "American" },
    ],
    nightlife: [
      { name: "Bunker Bar", vibe: "On-property, post-round cigars", cuisine: "Cocktails + cigars" },
    ],
    logistics: "Truly remote — fly into North Bend (OTH) if you can, otherwise plan the drive in. Once you arrive, everything is walkable on property.",
    logisticsScore: 45,
    nightlifeScore: 30,
    golfScore: 99,
    heroImageQuery: "Pacific Dunes Bandon Oregon coastal links sunset",
  },
  {
    slug: "sea-island",
    name: "Sea Island, GA",
    region: "Georgia coast, Golden Isles",
    airports: ["SAV — 75 min", "JAX — 90 min", "BQK — 15 min"],
    bestMonths: ["Mar", "Apr", "May", "Sep", "Oct", "Nov"],
    weather: {
      Jan: { rating: "fair", note: "Cool, mid-50s" },
      Feb: { rating: "fair", note: "55–65, mostly playable" },
      Mar: { rating: "good", note: "60s, warming" },
      Apr: { rating: "great", note: "70s, prime" },
      May: { rating: "great", note: "75–82°F" },
      Jun: { rating: "good", note: "Hot, humid, afternoon storms" },
      Jul: { rating: "fair", note: "Hot, humid, busy" },
      Aug: { rating: "fair", note: "Same" },
      Sep: { rating: "great", note: "80s, lower humidity" },
      Oct: { rating: "great", note: "70s, prime" },
      Nov: { rating: "great", note: "60s, beautiful" },
      Dec: { rating: "good", note: "50s, lower demand" },
    },
    courses: [
      { name: "Seaside Course (Sea Island)", tier: "championship", notes: "Host of RSM Classic, oceanfront, Tom Fazio redesign", greenFee: 495 },
      { name: "Plantation Course (Sea Island)", tier: "championship", notes: "Davis Love III redesign, parkland", greenFee: 425 },
      { name: "Retreat Course (Sea Island)", tier: "championship", notes: "Davis Love III, third resort course", greenFee: 375 },
      { name: "Frederica Golf Club", tier: "private-access", notes: "Tom Fazio, member sponsorship required", greenFee: 0 },
    ],
    lodging: [
      { name: "The Cloister at Sea Island", tier: "ultra-luxury", notes: "Forbes 5-star, Auberge-tier resort", nightlyRate: 1450 },
      { name: "The Lodge at Sea Island", tier: "ultra-luxury", notes: "Adult-leaning, golf-focused on the resort", nightlyRate: 1250 },
      { name: "The Inn at Sea Island", tier: "luxury", notes: "Smaller scale, refined", nightlyRate: 575 },
    ],
    dining: [
      { name: "Georgian Room (The Cloister)", vibe: "Resort fine dining", cuisine: "American" },
      { name: "Tavola", vibe: "Wood-fired Italian", cuisine: "Italian" },
      { name: "Halyards (St Simons)", vibe: "Local favourite", cuisine: "New Southern" },
    ],
    nightlife: [
      { name: "The Lodge's Oak Room", vibe: "Cigars + bourbons", cuisine: "Cocktails" },
      { name: "Mullet Bay", vibe: "St Simons casual late", cuisine: "Bar + casual" },
    ],
    logistics: "Brunswick (BQK) is 15 min, Jacksonville 90 min, Savannah 75 min. The Cloister/Lodge campus is contained — golf is steps away.",
    logisticsScore: 70,
    nightlifeScore: 50,
    golfScore: 92,
    heroImageQuery: "Seaside Course Sea Island Georgia oceanfront",
  },
  {
    slug: "cabo-san-lucas",
    name: "Cabo San Lucas, Mexico",
    region: "Baja California Sur",
    airports: ["SJD (Los Cabos) — 30 min to Cabo, 50 min to East Cape"],
    bestMonths: ["Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May"],
    weather: {
      Jan: { rating: "great", note: "75°F, ideal" },
      Feb: { rating: "great", note: "75°F, peak demand" },
      Mar: { rating: "great", note: "78°F" },
      Apr: { rating: "great", note: "80°F" },
      May: { rating: "great", note: "85°F" },
      Jun: { rating: "good", note: "90°F" },
      Jul: { rating: "fair", note: "Humid, hot, hurricane risk" },
      Aug: { rating: "poor", note: "Same — peak hurricane" },
      Sep: { rating: "poor", note: "Same" },
      Oct: { rating: "good", note: "Cooling, drying" },
      Nov: { rating: "great", note: "80°F, ideal" },
      Dec: { rating: "great", note: "75°F" },
    },
    courses: [
      { name: "Cabo del Sol Cove Club", tier: "private-access", notes: "Tom Doak member club, ocean course", greenFee: 0 },
      { name: "Quivira Golf Club", tier: "championship", notes: "Jack Nicklaus, Pueblo Bonito guests only, dramatic cliffs", greenFee: 595 },
      { name: "Cabo Del Sol Ocean", tier: "championship", notes: "Jack Nicklaus, oceanfront classic", greenFee: 475 },
      { name: "Diamante Dunes", tier: "championship", notes: "Davis Love III, top-10 in Mexico", greenFee: 525 },
      { name: "Querencia", tier: "private-access", notes: "Tom Fazio private — member sponsorship required", greenFee: 0 },
    ],
    lodging: [
      { name: "Waldorf Astoria Los Cabos Pedregal", tier: "ultra-luxury", notes: "Tunnel-entrance, ocean-facing casitas", nightlyRate: 1450 },
      { name: "One&Only Palmilla", tier: "ultra-luxury", notes: "Auberge-tier, beachfront, classic", nightlyRate: 1850 },
      { name: "Las Ventanas al Paraíso", tier: "ultra-luxury", notes: "Rosewood, oceanfront, refined", nightlyRate: 1650 },
      { name: "Solaz, Auberge", tier: "luxury", notes: "Modernist beachfront", nightlyRate: 925 },
    ],
    dining: [
      { name: "El Farallon (Pedregal)", vibe: "Cliffside seafood, theatrical", cuisine: "Seafood" },
      { name: "Edith's", vibe: "Cabo institution", cuisine: "Mexican / steak" },
      { name: "Manta (Solaz)", vibe: "Enrique Olvera, ocean view", cuisine: "Modern Mexican" },
      { name: "Sunset Monalisa", vibe: "Cliffside, sunset", cuisine: "Italian / seafood" },
    ],
    nightlife: [
      { name: "The Cape Rooftop", vibe: "Cocktail bar, arch views", cuisine: "Cocktails" },
      { name: "Mandala", vibe: "Late nightclub, downtown Cabo", cuisine: "Club" },
      { name: "El Squid Roe", vibe: "Iconic late night, raucous", cuisine: "Bar" },
    ],
    logistics: "SJD is 30 min to Cabo, 50 min to East Cape. Plan ground transport — Uber is improving but private SUVs are still the move.",
    logisticsScore: 75,
    nightlifeScore: 88,
    golfScore: 90,
    heroImageQuery: "Quivira Cabo San Lucas golf course ocean cliffs",
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
