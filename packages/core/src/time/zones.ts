/**
 * Venue time zones: only **canonical IANA location names** are accepted
 * (`Australia/Sydney`, not the link `Australia/NSW`; not `GMT`, `EST`,
 * `UTC` or a fixed offset such as `+08:00`).
 *
 * The list of zones comes from `Intl.supportedValuesOf('timeZone')`, which
 * returns one canonical ID per zone from the ICU data shipped with the
 * runtime (Node 22 here). ICU follows CLDR, which still spells a few
 * renamed zones the old way (`Asia/Calcutta` for the IANA `Asia/Kolkata`)
 * and keeps some zones that IANA has since made links; {@link ICU_TO_IANA}
 * maps those to their IANA canonical names (checked against tzdata 2026c),
 * so the accepted set is the IANA canonical names. Every Australian zone is
 * the same in both.
 */

/**
 * ICU (CLDR) IDs that are links in IANA tzdata 2026c, with the IANA
 * canonical zone they point to.
 */
const ICU_TO_IANA: Readonly<Record<string, string>> = {
  'Africa/Asmera': 'Africa/Asmara',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Catamarca': 'America/Argentina/Catamarca',
  'America/Coral_Harbour': 'America/Atikokan',
  'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Godthab': 'America/Nuuk',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Jujuy': 'America/Argentina/Jujuy',
  'America/Kralendijk': 'America/Curacao',
  'America/Louisville': 'America/Kentucky/Louisville',
  'America/Lower_Princes': 'America/Curacao',
  'America/Marigot': 'America/Port_of_Spain',
  'America/Mendoza': 'America/Argentina/Mendoza',
  'America/St_Barthelemy': 'America/Port_of_Spain',
  'Arctic/Longyearbyen': 'Europe/Oslo',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Europe/Bratislava': 'Europe/Prague',
  'Europe/Busingen': 'Europe/Zurich',
  'Europe/Kiev': 'Europe/Kyiv',
  'Europe/Mariehamn': 'Europe/Helsinki',
  'Europe/Podgorica': 'Europe/Belgrade',
  'Europe/San_Marino': 'Europe/Rome',
  'Europe/Vatican': 'Europe/Rome',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk',
};

const toIana = (id: string): string => ICU_TO_IANA[id] ?? id;

let canonical: ReadonlySet<string> | undefined;

/** Canonical IANA location zones known to this runtime. */
export function canonicalTimeZones(): ReadonlySet<string> {
  canonical ??= new Set(Intl.supportedValuesOf('timeZone').map(toIana));
  return canonical;
}

/** The canonical zone a name resolves to (a link, or a different case), or `undefined`. */
function resolveZone(zone: string): string | undefined {
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions()
      .timeZone;
    const iana = toIana(resolved);
    return canonicalTimeZones().has(iana) ? iana : undefined;
  } catch {
    return undefined;
  }
}

const EXAMPLE = 'Use a canonical IANA time zone such as Australia/Perth or Australia/Sydney';

/**
 * `null` when `zone` is a canonical IANA location zone; otherwise a message
 * saying what is wrong and, for a link name, which canonical zone to use.
 */
export function timeZoneProblem(zone: string): string | null {
  if (canonicalTimeZones().has(zone)) return null;
  // Fixed offsets (+08:00), UTC/GMT/EST-style abbreviations and the Etc/
  // zones have no location and no daylight-saving rules for a venue.
  if (!zone.includes('/') || zone.startsWith('Etc/') || /^[+\-−]/.test(zone)) {
    return `"${zone}" is not a location time zone (fixed offsets, UTC, GMT and abbreviations such as EST are not accepted). ${EXAMPLE}.`;
  }
  const target = resolveZone(zone);
  if (target !== undefined) {
    return `"${zone}" is an alias of ${target}: use the canonical name ${target}.`;
  }
  return `Unknown time zone "${zone}". ${EXAMPLE}.`;
}
