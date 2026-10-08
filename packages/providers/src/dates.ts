const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;
const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

const toDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
};
const toIso = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(iso: string, days: number): string {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
}

export function weekdayOf(iso: string): (typeof WEEKDAYS)[number] {
  return WEEKDAYS[toDate(iso).getUTCDay()] ?? 'sunday';
}

function validDate(year: number, month0: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month0, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month0 && d.getUTCDate() === day
    ? toIso(d)
    : null;
}

/** First date on or after `from` that falls on the given weekday (strictly after if `strict`). */
function nextWeekday(from: string, weekday: number, strict: boolean): string {
  const current = toDate(from).getUTCDay();
  let delta = (weekday - current + 7) % 7;
  if (delta === 0 && strict) delta = 7;
  return addDays(from, delta);
}

const monthPattern = MONTHS.join('|');
const weekdayPattern = WEEKDAYS.join('|');

/**
 * Dates mentioned in a sentence, resolved against the date of the call. Deliberately literal:
 * it understands "23rd of October", "Friday the 16th", "tomorrow", "by Monday" and
 * "end of the month", and ignores anything it cannot pin to a date.
 */
export function datesIn(sentence: string, callDate: string): string[] {
  const text = sentence.toLowerCase();
  const found: { at: number; date: string }[] = [];
  const consumed: [number, number][] = [];
  const claim = (start: number, end: number) => consumed.push([start, end]);
  const taken = (start: number, end: number) => consumed.some(([a, b]) => start < b && end > a);
  const callYear = Number(callDate.slice(0, 4));

  const withYear = (month0: number, day: number, yearText: string | undefined): string | null => {
    if (yearText !== undefined) return validDate(Number(yearText), month0, day);
    const thisYear = validDate(callYear, month0, day);
    if (thisYear !== null && thisYear >= addDays(callDate, -1)) return thisYear;
    return validDate(callYear + 1, month0, day);
  };

  // "23rd of October", "Friday 23rd October 2026"
  for (const m of text.matchAll(
    new RegExp(
      `(?:(?:${weekdayPattern})\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthPattern})(?:\\s+(\\d{4}))?`,
      'g',
    ),
  )) {
    const date = withYear(MONTHS.indexOf(m[2] as (typeof MONTHS)[number]), Number(m[1]), m[3]);
    claim(m.index, m.index + m[0].length); // even if impossible ("31st of February"): not a day of this month
    if (date !== null) found.push({ at: m.index, date });
  }
  // "October 23rd"
  for (const m of text.matchAll(
    new RegExp(`(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, 'g'),
  )) {
    if (taken(m.index, m.index + m[0].length)) continue;
    const date = withYear(MONTHS.indexOf(m[1] as (typeof MONTHS)[number]), Number(m[2]), m[3]);
    claim(m.index, m.index + m[0].length);
    if (date !== null) found.push({ at: m.index, date });
  }
  // "Friday the 16th", "on the 23rd" (this month, or next if already past)
  for (const m of text.matchAll(
    new RegExp(`(?:(?:${weekdayPattern})\\s+)?the\\s+(\\d{1,2})(?:st|nd|rd|th)\\b`, 'g'),
  )) {
    if (taken(m.index, m.index + m[0].length)) continue;
    const day = Number(m[1]);
    const month0 = Number(callDate.slice(5, 7)) - 1;
    let date = validDate(callYear, month0, day);
    if (date !== null && date < callDate)
      date = validDate(month0 === 11 ? callYear + 1 : callYear, (month0 + 1) % 12, day);
    if (date !== null) {
      found.push({ at: m.index, date });
      claim(m.index, m.index + m[0].length);
    }
  }
  // "next Friday", "by Monday"
  for (const m of text.matchAll(new RegExp(`\\b(next\\s+|this\\s+)?(${weekdayPattern})\\b`, 'g'))) {
    if (taken(m.index, m.index + m[0].length)) continue;
    const weekday = WEEKDAYS.indexOf(m[2] as (typeof WEEKDAYS)[number]);
    const date = nextWeekday(callDate, weekday, true);
    found.push({ at: m.index, date: m[1]?.trim() === 'next' ? addDays(date, 7) : date });
  }
  for (const m of text.matchAll(/\btomorrow\b/g))
    found.push({ at: m.index, date: addDays(callDate, 1) });
  for (const m of text.matchAll(/\bend of (?:the|this) month\b/g)) {
    const y = callYear;
    const mo = Number(callDate.slice(5, 7));
    found.push({ at: m.index, date: toIso(new Date(Date.UTC(y, mo, 0))) });
  }

  return [...new Set(found.sort((a, b) => a.at - b.at).map((f) => f.date))];
}
