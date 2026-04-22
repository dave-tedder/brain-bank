// ============================================================
// Brain Bank Calendar Sync
//
// Google Apps Script that mirrors Google Calendar events into
// Brain Bank on a daily schedule. Writes to two endpoints:
//
//   1. POST /event    - upserts each event into business_events
//                        (for pre-appointment briefings in the
//                        morning digest)
//   2. POST /capture   - writes one combined thought summarizing
//                        the upcoming window (for semantic search)
//
// The /event endpoint upserts by gcal_event_id so re-runs are
// safe. Either endpoint can fail without blocking the other.
//
// Paste this into a new Apps Script project at script.google.com,
// fill in the three constants below, save, authorize, and set up
// a daily time-driven trigger on captureAndSync().
//
// Full walkthrough: docs/capture-sources/calendar-sync.md
// ============================================================

// Replace all three values below with yours.
var BRAIN_BANK_BASE = 'https://<your-project-ref>.supabase.co/functions/v1/open-brain-mcp';
var BRAIN_KEY = 'YOUR_BRAIN_KEY';

// Google Calendar IDs to sync. For your primary calendar, use the
// Gmail address the calendar belongs to. For secondary calendars,
// find the ID under Calendar settings → Integrate calendar →
// Calendar ID. One string per calendar, as many as you like.
//
// Leave this array exactly as shipped and nothing syncs, which is
// the safe default. Fill it in before the first real run.
var ALLOWED_CALENDARS = ['your-email@example.com'];

// How many days ahead to sync. 30 gives you a month of lookahead
// without overwhelming the digest's pre-brief section. Lower it
// if your calendar is very dense; raise it if you schedule far
// out.
var SYNC_WINDOW_DAYS = 30;

// ============================================================
// EVENT CLASSIFIER
//
// Maps event titles to one of the strings in profile.json's
// event_types array. The default maps to the four defaults in
// profile.example.json: meeting, travel, maintenance, event.
//
// If you changed event_types in your profile.json, update the
// buckets below to match. The Edge Function does NOT validate
// event_type, so a typo here just produces events with the
// wrong tag, not errors.
//
// The classifier is keyword-matched on a lowercased title. First
// match wins. Add your own keywords as you notice misclassifications.
// ============================================================
function classifyEvent(title, calendarName) {
  var t = (title || '').toLowerCase();

  if (t.indexOf('meeting') >= 0 || t.indexOf('call') >= 0 ||
      t.indexOf('sync') >= 0 || t.indexOf('standup') >= 0 ||
      t.indexOf('1:1') >= 0 || t.indexOf('1-1') >= 0) {
    return 'meeting';
  }

  if (t.indexOf('travel') >= 0 || t.indexOf('flight') >= 0 ||
      t.indexOf('trip') >= 0 || t.indexOf('hotel') >= 0) {
    return 'travel';
  }

  if (t.indexOf('maintenance') >= 0 || t.indexOf('repair') >= 0 ||
      t.indexOf('service') >= 0 || t.indexOf('appointment') >= 0) {
    return 'maintenance';
  }

  return 'event';
}

// ============================================================
// MAIN: sync the next SYNC_WINDOW_DAYS of events to Brain Bank.
// Trigger: daily (Time-driven), pre-digest (e.g. 3-5 AM window).
// ============================================================
function captureAndSync() {
  var now = new Date();
  var windowEnd = new Date(now);
  windowEnd.setDate(windowEnd.getDate() + SYNC_WINDOW_DAYS);
  windowEnd.setHours(23, 59, 59);

  var calendars = CalendarApp.getAllCalendars();
  var events = [];

  for (var c = 0; c < calendars.length; c++) {
    var cal = calendars[c];
    if (cal.getName().toLowerCase().indexOf('holidays') >= 0) continue;
    if (ALLOWED_CALENDARS.indexOf(cal.getId()) < 0) {
      Logger.log('Skipping calendar: ' + cal.getName() + ' (' + cal.getId() + ')');
      continue;
    }

    var calEvents = cal.getEvents(now, windowEnd);
    for (var i = 0; i < calEvents.length; i++) {
      var e = calEvents[i];
      if ((e.getDescription() || '').indexOf('reclaim.ai') >= 0) continue;

      var guestNames = [];
      var guestEmails = '';
      try {
        var guestList = e.getGuestList();
        for (var g = 0; g < guestList.length; g++) {
          var name = guestList[g].getName();
          guestNames.push(name || guestList[g].getEmail());
          guestEmails += (guestEmails ? ', ' : '') + guestList[g].getEmail();
        }
      } catch (err) {
        // Read-only calendar, skip guests.
      }

      events.push({
        title: e.getTitle(),
        start: e.getStartTime(),
        end: e.getEndTime(),
        location: e.getLocation() || '',
        description: (e.getDescription() || '').substring(0, 300),
        guestNames: guestNames,
        guestEmails: guestEmails,
        calendar: cal.getName(),
        allDay: e.isAllDayEvent(),
        gcalId: e.getId()
      });
    }
  }

  if (events.length === 0) {
    Logger.log('No events in the next ' + SYNC_WINDOW_DAYS + ' days.');
    return;
  }

  events.sort(function(a, b) { return a.start - b.start; });

  // --- Part 1: upsert each event to business_events via /event ---
  var syncedCount = 0;
  var eventErrorCount = 0;

  for (var j = 0; j < events.length; j++) {
    var ev = events[j];
    var payload = {
      title: ev.title,
      event_type: classifyEvent(ev.title, ev.calendar),
      date_start: formatDate(ev.start),
      date_end: formatDate(ev.end),
      location: ev.location || null,
      notes: ev.description || null,
      metadata: {
        gcal_event_id: ev.gcalId,
        attendees: ev.guestNames,
        calendar: ev.calendar,
        start_time: formatTime(ev.start),
        end_time: formatTime(ev.end),
        all_day: ev.allDay
      }
    };

    try {
      var resp = UrlFetchApp.fetch(BRAIN_BANK_BASE + '/event?key=' + BRAIN_KEY, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      var code = resp.getResponseCode();
      if (code >= 200 && code < 300) {
        syncedCount++;
      } else {
        Logger.log('Event sync error (' + ev.title + '): ' + code + ' ' + resp.getContentText());
        eventErrorCount++;
      }
    } catch (err) {
      Logger.log('Event sync exception (' + ev.title + '): ' + err);
      eventErrorCount++;
    }
  }

  // --- Part 2: capture combined thought for semantic search ---
  var lines = [];
  for (var k = 0; k < events.length; k++) {
    var evt = events[k];
    var date = evt.start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    var line;
    if (evt.allDay) {
      line = date + ' (all day): ' + evt.title;
    } else {
      var time = evt.start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      line = date + ' ' + time + ': ' + evt.title;
    }
    if (evt.location) line += ' at ' + evt.location;
    if (evt.guestEmails) line += ' (with ' + evt.guestEmails + ')';
    if (evt.description) line += ' - ' + evt.description;
    lines.push(line);
  }

  var content = '[Calendar Sync] Schedule for the next ' + SYNC_WINDOW_DAYS + ' days:\n' + lines.join('\n');

  try {
    var captureResp = UrlFetchApp.fetch(BRAIN_BANK_BASE + '/capture?key=' + BRAIN_KEY, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ content: content, source: 'gcal' }),
      muteHttpExceptions: true
    });
    if (captureResp.getResponseCode() !== 200) {
      Logger.log('Capture failed: ' + captureResp.getResponseCode() + ' ' + captureResp.getContentText());
    } else {
      Logger.log('Thought capture: ' + captureResp.getContentText());
    }
  } catch (err) {
    Logger.log('Thought capture error: ' + err);
  }

  Logger.log('Calendar sync complete. Events synced to business_events: ' + syncedCount + ', sync errors: ' + eventErrorCount);
}

// ============================================================
// Helpers
// ============================================================
function formatDate(d) {
  var year = d.getFullYear();
  var month = ('0' + (d.getMonth() + 1)).slice(-2);
  var day = ('0' + d.getDate()).slice(-2);
  return year + '-' + month + '-' + day;
}

function formatTime(d) {
  var hours = ('0' + d.getHours()).slice(-2);
  var minutes = ('0' + d.getMinutes()).slice(-2);
  return hours + ':' + minutes;
}
