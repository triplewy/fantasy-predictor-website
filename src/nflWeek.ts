/**
 * The NFL fantasy week runs from Tuesday 4:00 AM Eastern to the next Tuesday 4:00 AM
 * Eastern (after Monday Night Football), matching the API's own `week` boundaries.
 * Computed in America/New_York so the boundary stays at 4 AM across daylight saving.
 */
const timeZone = "America/New_York";
const weekStartWeekday = 2; // Tuesday (0 = Sunday)
const weekStartHour = 4;

const zonedParts = new Intl.DateTimeFormat("en-US", {
  timeZone,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  weekday: "short",
});

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Wall-clock date/time in Eastern for an instant. */
function easternParts(date: Date) {
  const parts = Object.fromEntries(zonedParts.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: weekdays.indexOf(parts.weekday),
  };
}

/** The instant when Eastern wall-clock time reads year-month-day hour:00. */
function easternTimeToUtc(year: number, month: number, day: number, hour: number): Date {
  // Start from the same wall-clock time read as UTC, then correct by Eastern's offset at
  // that instant. A second pass handles instants right at a daylight-saving change.
  const target = Date.UTC(year, month - 1, day, hour);
  let guess = target;
  for (let pass = 0; pass < 2; pass++) {
    const parts = easternParts(new Date(guess));
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    guess += target - asUtc;
  }
  return new Date(guess);
}

/** Start (inclusive) and end (exclusive) of the NFL week containing `now`. */
export function currentNflWeek(now: Date = new Date()): { from: Date; to: Date } {
  const eastern = easternParts(now);
  // Days back to this week's Tuesday; before 4 AM on Tuesday still belongs to last week.
  let daysBack = (eastern.weekday - weekStartWeekday + 7) % 7;
  if (daysBack === 0 && eastern.hour < weekStartHour) daysBack = 7;

  // Calendar arithmetic on the Eastern date (UTC math avoids local-timezone effects).
  const startDay = new Date(Date.UTC(eastern.year, eastern.month - 1, eastern.day - daysBack));
  const endDay = new Date(Date.UTC(eastern.year, eastern.month - 1, eastern.day - daysBack + 7));
  return {
    from: easternTimeToUtc(startDay.getUTCFullYear(), startDay.getUTCMonth() + 1, startDay.getUTCDate(), weekStartHour),
    to: easternTimeToUtc(endDay.getUTCFullYear(), endDay.getUTCMonth() + 1, endDay.getUTCDate(), weekStartHour),
  };
}

export const NFL_REGULAR_SEASON_WEEKS = 18;

/**
 * Start of Week 1 for an NFL season (Tuesday 4:00 AM Eastern before the first Thursday after Labor Day).
 * Labor Day is the first Monday in September.
 */
export function nflSeasonWeek1Start(year: number): Date {
  const sep1 = new Date(Date.UTC(year, 8, 1));
  const sep1Weekday = sep1.getUTCDay();
  const firstMondayDate = 1 + ((1 - sep1Weekday + 7) % 7);
  const week1TuesdayDate = firstMondayDate + 1;
  return easternTimeToUtc(year, 9, week1TuesdayDate, weekStartHour);
}

/**
 * Returns the current 1-based NFL week number for the given season year.
 * Returns 1 if before Week 1, and 18 if after Week 18.
 */
export function currentNflWeekNumber(now: Date = new Date(), year?: number): number {
  const currentWeek = currentNflWeek(now);
  const seasonYear = year ?? easternParts(currentWeek.from).year;
  const week1 = nflSeasonWeek1Start(seasonYear);
  const diffMs = currentWeek.from.getTime() - week1.getTime();
  const weekIndex = Math.round(diffMs / (7 * 24 * 60 * 60 * 1000));
  const weekNum = weekIndex + 1;
  return Math.max(1, Math.min(NFL_REGULAR_SEASON_WEEKS, weekNum));
}

/**
 * Number of NFL weeks still available in the regular season (including the current week).
 * E.g. at Week 12, there are 7 weeks still available (Weeks 12 through 18).
 */
export function getWeeksRemaining(now: Date = new Date(), season: string = "season-2026"): number {
  const match = season.match(/\d{4}/);
  const year = match ? Number(match[0]) : undefined;
  const weekNum = currentNflWeekNumber(now, year);
  return Math.max(1, NFL_REGULAR_SEASON_WEEKS - weekNum + 1);
}
