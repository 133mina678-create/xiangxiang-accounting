import type { Event } from "./types";

/**
 * The selected identity is a browser preference, not authentication. This
 * prevents friends from accidentally seeing events they did not join while
 * keeping the existing shared secret-link security model unchanged.
 */
export function eventsVisibleToMember<T extends Event>(
  events: readonly T[],
  memberId: string,
): T[] {
  if (!memberId) return [];
  return events.filter((event) => event.members.includes(memberId));
}

