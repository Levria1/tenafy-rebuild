# Pending Viewing Calendar Holds

## Problems

Pending viewings are invisible to staff calendars. Today the Google Calendar write only happens after a viewing is confirmed, through `sendViewingConfirmation` or the public confirmation paths. While a relay conversation is negotiating a slot, or a public booking is awaiting approvals, staff can manually book over that time because nothing visible exists on their calendar.

In-flight relay negotiations are also invisible to the availability check. `checkStaffFree` currently checks `viewing_booking` rows and Google free/busy. A relay negotiation has no `viewing_booking` row until it confirms, so two negotiations can both lock the same staffer or unit at the same proposed time, pass availability, and later confirm into a double booking. The auto-confirm sweeper makes this worse because it can confirm without a human noticing the overlap.

## Design Constraint

Pending holds are written to Google Calendar as visible tentative events with:

- `status: 'tentative'`
- `transparency: 'transparent'`

The `transparent` setting is load-bearing. Google free/busy returns only opaque `{ start, end }` busy windows and does not include event IDs, so the availability check cannot exclude the current negotiation's own hold at the free/busy layer. If a pending hold were opaque, the auto-confirm sweeper would see the negotiation's own calendar event as busy and escalate every auto-confirmable negotiation to `NEEDS_STAFF` with a misleading staffing reason.

Therefore Google Calendar is only a visible projection for pending holds. Correct conflict detection for pending relay viewings lives in MySQL, inside `checkStaffFree`, where the current negotiation can be excluded by id. Every `checkStaffFree` call must pass `excludeNegotiationId`; missing that id would make the negotiation block its own confirmation and fail silently as a staffing problem.

## Lifecycle

| Phase | Trigger | Action |
|---|---|---|
| Created | Relay staff check succeeds and locks `current_proposed_datetime` plus `staff_employee_id`; public booking is inserted at `status = 0` | Create a tentative transparent event on the assigned staff calendar. |
| Moved | Relay locks a new proposed time for the same staff calendar | Patch the existing hold start/end and pending description instead of creating a second event. |
| Moved to other calendar | Relay locks a new proposed time whose staffer uses a different calendar | Delete the old hold using the stored calendar id, then create the new hold on the new calendar. |
| Promoted | Relay confirms to `CONFIRMED`/`AUTO_CONFIRMED`; public booking promotes from `status = 0` to `status = 1` | Delete the tentative hold first, then create the normal confirmed event. This avoids a brief duplicate on the staff calendar. |
| Removed | Relay cancellation, stale escalation, `NEEDS_STAFF`, post-commit reversal/reschedule cleanup, public decline/cancel | Delete the tentative hold and clear stored hold metadata. On `NEEDS_STAFF`, a human owns the request and a stale tentative block is worse than no projection. |

## Storage

Relay holds are stored on `viewing_negotiation` in separate columns: `gcal_hold_event_id`, `gcal_hold_datetime`, and `gcal_hold_calendar_id`.

This is separate from `viewing_booking.gcal_event_id` because a relay hold is tentative and belongs to the negotiation, while the confirmed event belongs to the booking. They have different lifetimes: confirmation deletes the hold and creates the booking event. Reusing one column would make "which event is this?" ambiguous and risks deleting the confirmed event during cleanup.

The hold datetime and calendar id are stored because relay proposals can move repeatedly, and the assigned staffer can change with the proposed time. Cleanup must use the calendar where the event was actually written, not the current `staff_employee_id`, which may already have moved on.

For non-relay public bookings, the existing `viewing_booking.gcal_event_id` can hold the tentative event id while `status = 0` and the confirmed event id once `status = 1`, because that flow has one booking row and one event lifecycle at a time.

## Out Of Scope

No settings or toggles are added; holds are unconditional when a calendar is configured. There is no backfill for existing in-flight negotiations, no change to `getFreeBusy`, no switch to `events.list`, no frontend work, and no attendee invitations on holds. Calendar writes keep `sendUpdates: 'none'`.

## How To Verify

Run the backend unit suite and syntax checks without a database or network. Confirm the Google Calendar service exports the new patch helper, every `checkStaffFree` call passes an exclude id, and `git status --short` contains no `frontend/` changes.
