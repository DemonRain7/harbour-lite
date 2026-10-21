export interface CalendarEventDateTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface CalendarReminder { method: "popup" | "email"; minutes: number }
export interface CalendarReminders { useDefault: boolean; overrides?: CalendarReminder[] }

export interface CalendarEventInput {
  summary: string;
  description?: string;
  location?: string;
  start: CalendarEventDateTime;
  end: CalendarEventDateTime;
  recurrence?: string[];
  reminders?: CalendarReminders;
}

export interface CalendarEvent extends CalendarEventInput {
  id: string;
  calendarId: string;
  etag?: string;
  htmlLink?: string;
  status?: string;
  recurringEventId?: string;
}

export interface CalendarListItem {
  id: string;
  summary: string;
  timeZone: string;
  accessRole: string;
  primary?: boolean;
  defaultReminders?: CalendarReminder[];
}

export interface CalendarSlot { start: string; end: string; timeZone: string }

export interface CalendarStatus {
  configured: boolean;
  connected: boolean;
  redirectUri: string;
  missing: string[];
  scopes: string[];
  connectionError?: string;
}

export class CalendarServiceError extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus = 400,
    readonly writeOutcome?: "rejected" | "unknown") {
    super(message);
    this.name = "CalendarServiceError";
  }
}
