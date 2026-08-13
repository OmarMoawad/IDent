import { RealCalendarApiClient, type CalendarApiClient } from "./calendar-api-client.js";

export type { CalendarApiClient };

/** The default instance routes call through; tests inject a fake instead. */
export const calendarApiClient: CalendarApiClient = new RealCalendarApiClient();
