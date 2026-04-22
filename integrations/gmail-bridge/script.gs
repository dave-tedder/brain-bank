// ============================================================
// Brain Bank Gmail Bridge
//
// Google Apps Script that captures Gmail threads into Brain Bank.
// Paste this into a new Apps Script project at script.google.com,
// fill in the two constants below, save, authorize, and set up an
// hourly time-driven trigger on processEmails().
//
// Full walkthrough: docs/capture-sources/gmail-bridge.md
// ============================================================

// Replace both values below with yours.
var BRAIN_BANK_URL = 'https://<your-project-ref>.supabase.co/functions/v1/open-brain-mcp/capture';
var BRAIN_KEY = 'YOUR_BRAIN_KEY';

// Label names (must match the labels you created in Gmail).
var LABEL_CAPTURE = 'brain-capture';
var LABEL_PROCESSED = 'brain-processed';
var LABEL_SKIPPED = 'brain-capture-skipped';

// How far back the auto-capture pass looks. Should overlap the
// trigger interval so a slightly late trigger does not miss anything.
var SEARCH_WINDOW = '2h';

// ============================================================
// BLOCKLIST: senders and subject patterns to skip
//
// The defaults catch generic marketing, transactional, and automated
// mail. Add your own high-volume junk senders as you notice them.
// Watch the `brain-capture-skipped` label in Gmail to see what was
// filtered out.
// ============================================================

var BLOCKED_SENDERS = [
  // Status and monitoring
  'noreply@statuspage.io',
  'noreply@notify.statuspage.io',

  // Google automated
  'noreply@google.com',
  'no-reply@accounts.google.com',
  'googleplay-noreply@google.com',
  'googlecommunityteam-noreply@google.com',

  // Social media notifications
  'noreply@facebookmail.com',
  'no-reply@instagram.com',
  'info@x.com',
  'notify@twitter.com',

  // Common transactional sender prefixes (substring match).
  // These cover a lot of ground; most automated mail uses one of them.
  'noreply@',
  'no-reply@',
  'donotreply@',
  'do-not-reply@',
  'mailer-daemon@',
];

var BLOCKED_SUBJECT_PATTERNS = [
  /password\s*(reset|changed|updated|expir)/i,
  /verify\s*your\s*(email|account|identity)/i,
  /confirm\s*your\s*(email|account|subscription)/i,
  /sign[\s-]*in\s*(attempt|alert|notification)/i,
  /security\s*(alert|code|notification)/i,
  /two[\s-]*factor|2fa|verification\s*code/i,
  /billing\s*(statement|notification|update|receipt)/i,
  /payment\s*(received|processed|confirmed|failed|declined)/i,
  /order\s*(confirmation|shipped|delivered|tracking)/i,
  /shipping\s*(confirmation|update|notification)/i,
  /your\s*(receipt|invoice|statement)\s*(from|for|is)/i,
  /unsubscribe|opt[\s-]*out|email\s*preferences/i,
  /promo\s*code|coupon|discount|% off|limited[\s-]*time\s*offer/i,
  /subscription\s*(renewed|expir|cancel)/i,
  /account\s*(suspended|locked|deactivated|terminated)/i,
  /storage\s*(full|limit|quota)/i,
  /we\s*miss\s*you|come\s*back|re-?engage/i,
  /incident\s*(report|resolved|update|monitoring)/i,
];

// Subjects matching these patterns override the sender blocklist.
// Keep narrow and technical; anything broad (like "action required")
// will reopen the marketing firehose.
var ALLOWED_SUBJECT_PATTERNS = [
  /deprecat/i,
  /breaking[\s-]*change/i,
  /end[\s-]*of[\s-]*(life|support|service)|\beol\b/i,
  /security\s*(advisory|patch|notice|bulletin|disclosure)/i,
  /vulnerability|\bcve[\s-]*\d/i,
  /api\s*(migration|breaking|change|deprecat)/i,
  /scheduled\s*(maintenance|downtime)/i,
  /service\s*(disruption|incident)\s*(notice|post[\s-]*mortem)/i,
];

// Senders in this list always pass through, even if they match a
// blocked pattern. Domain fragments catch every mailbox on the
// domain (`noreply@`, `security@`, etc.). The defaults are a starter
// set of vendors whose product and security mail is usually worth
// capturing. Add or remove to taste.
var ALLOWED_SENDERS = [
  // AI / LLM vendors
  'anthropic.com',
  'openai.com',
  'openrouter.ai',
  'elevenlabs.io',
  'fal.ai',
  'hedra.com',
  'lumalabs.ai',

  // Infrastructure / hosting / DB
  'supabase.io',
  'supabase.com',
  'railway.app',
  'railway.com',
  'cloudflare.com',
  'cloudways.com',
  'vercel.com',

  // Dev tools / code hosting
  'github.com',
  'deno.com',

  // Domain / DNS
  'godaddy.com',

  // Business-critical SaaS
  'notion.so',
  'slack.com',
  'stripe.com',
];

function shouldSkip(from, subject) {
  var fromLower = (from || '').toLowerCase();
  var subjectLower = (subject || '').toLowerCase();

  // Sender allowlist wins first.
  for (var i = 0; i < ALLOWED_SENDERS.length; i++) {
    if (fromLower.indexOf(ALLOWED_SENDERS[i].toLowerCase()) !== -1) {
      return null;
    }
  }

  // Subject allowlist wins second; catches deprecation/security/EOL
  // from vendors we haven't explicitly enumerated yet.
  for (var i = 0; i < ALLOWED_SUBJECT_PATTERNS.length; i++) {
    if (ALLOWED_SUBJECT_PATTERNS[i].test(subjectLower)) {
      return null;
    }
  }

  for (var i = 0; i < BLOCKED_SENDERS.length; i++) {
    if (fromLower.indexOf(BLOCKED_SENDERS[i].toLowerCase()) !== -1) {
      return 'Blocked sender: ' + BLOCKED_SENDERS[i];
    }
  }

  for (var i = 0; i < BLOCKED_SUBJECT_PATTERNS.length; i++) {
    if (BLOCKED_SUBJECT_PATTERNS[i].test(subjectLower)) {
      return 'Blocked subject pattern: ' + BLOCKED_SUBJECT_PATTERNS[i];
    }
  }

  return null;
}

// ============================================================
// Ensure a Gmail label exists, create it if missing
// ============================================================
function ensureLabel(name) {
  var label = GmailApp.getUserLabelByName(name);
  if (!label) {
    label = GmailApp.createLabel(name);
    Logger.log('Created missing label: ' + name);
  }
  return label;
}

// ============================================================
// Build capture content from a thread
// ============================================================
function buildContent(thread) {
  var messages = thread.getMessages();
  var subject = thread.getFirstMessageSubject() || '';
  var parts = [];
  for (var m = 0; m < messages.length; m++) {
    var msgFrom = messages[m].getFrom();
    var date = messages[m].getDate().toLocaleDateString();
    var body = messages[m].getPlainBody();
    if (!body || body.trim() === '') {
      body = messages[m].getBody().replace(/<[^>]+>/g, '').substring(0, 500);
    } else {
      body = body.substring(0, 500);
    }
    parts.push(msgFrom + ' (' + date + '): ' + body.trim());
  }
  return {
    content: 'Email thread: ' + subject + '\n\n' + parts.join('\n\n---\n\n'),
    subject: subject,
    from: messages.length > 0 ? (messages[0].getFrom() || '') : ''
  };
}

// ============================================================
// Send a thought to Brain Bank. Returns true on success.
// ============================================================
function captureToBrainBank(content) {
  var response = UrlFetchApp.fetch(BRAIN_BANK_URL + '?key=' + BRAIN_KEY, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ content: content, source: 'gmail' }),
    muteHttpExceptions: true,
  });
  var code = response.getResponseCode();
  if (code >= 200 && code < 300) {
    return true;
  }
  Logger.log('Brain Bank returned ' + code + ': ' + response.getContentText());
  return false;
}

// ============================================================
// MAIN: auto-capture recent emails plus process manual labels.
// Trigger: hourly (Time-driven).
// ============================================================
function processEmails() {
  try {
    var processedLabel = ensureLabel(LABEL_PROCESSED);
    var skippedLabel = ensureLabel(LABEL_SKIPPED);
    var captureLabel = ensureLabel(LABEL_CAPTURE);

    var captured = 0;
    var skipped = 0;
    var errors = 0;

    // --- PART 1: auto-capture recent threads ---
    var query = 'newer_than:' + SEARCH_WINDOW
      + ' -label:' + LABEL_PROCESSED
      + ' -label:' + LABEL_SKIPPED
      + ' -label:' + LABEL_CAPTURE;
    var threads = GmailApp.search(query, 0, 50);
    Logger.log('Auto-capture: ' + threads.length + ' new threads');

    for (var t = 0; t < threads.length; t++) {
      try {
        var info = buildContent(threads[t]);

        var skipReason = shouldSkip(info.from, info.subject);
        if (skipReason) {
          Logger.log('SKIPPED "' + info.subject + '" - ' + skipReason);
          threads[t].addLabel(skippedLabel);
          skipped++;
          continue;
        }

        if (captureToBrainBank(info.content)) {
          Logger.log('Captured "' + info.subject + '"');
          threads[t].addLabel(processedLabel);
          captured++;
        } else {
          errors++;
        }
      } catch (e) {
        Logger.log('Error on "' + (info ? info.subject : '?') + '": ' + e.message);
        errors++;
      }
    }

    // --- PART 2: manual captures (brain-capture label) ---
    // These bypass the blocklist since the user explicitly labeled them.
    var manualThreads = captureLabel.getThreads();
    Logger.log('Manual capture: ' + manualThreads.length + ' threads');

    for (var t = 0; t < manualThreads.length; t++) {
      try {
        var info = buildContent(manualThreads[t]);

        if (captureToBrainBank(info.content)) {
          Logger.log('Manual captured "' + info.subject + '"');
          manualThreads[t].removeLabel(captureLabel);
          manualThreads[t].addLabel(processedLabel);
          captured++;
        } else {
          errors++;
        }
      } catch (e) {
        Logger.log('Error on manual "' + (info ? info.subject : '?') + '": ' + e.message);
        errors++;
      }
    }

    Logger.log('Done. Captured: ' + captured + ', Skipped: ' + skipped + ', Errors: ' + errors);

    // Record last successful run for the health check function.
    PropertiesService.getScriptProperties().setProperty('lastSuccessfulRun', new Date().toISOString());

  } catch (e) {
    Logger.log('FATAL: ' + e.message);
    sendAlert('Gmail Bridge Error', 'The Brain Bank Gmail Bridge failed:\n\n' + e.message + '\n\nCheck the execution log at script.google.com');
  }
}

// ============================================================
// ALERT: send email notification on failure
// ============================================================
function sendAlert(subject, body) {
  try {
    MailApp.sendEmail(
      Session.getEffectiveUser().getEmail(),
      '[Brain Bank] ' + subject,
      body
    );
  } catch (e) {
    Logger.log('Could not send alert: ' + e.message);
  }
}

// ============================================================
// HEALTH CHECK: run as a separate daily trigger.
// Alerts if no successful processEmails run in the last 3 hours.
// ============================================================
function healthCheck() {
  var lastRun = PropertiesService.getScriptProperties().getProperty('lastSuccessfulRun');
  if (!lastRun) {
    sendAlert('Health Check', 'No successful Gmail Bridge runs recorded. Check if the hourly trigger exists and processEmails is running.');
    return;
  }
  var hoursSince = (new Date() - new Date(lastRun)) / (1000 * 60 * 60);
  if (hoursSince > 3) {
    sendAlert('Health Check', 'No successful run in ' + Math.round(hoursSince) + ' hours.\nLast success: ' + new Date(lastRun).toLocaleString() + '\n\nCheck the execution log at script.google.com');
  } else {
    Logger.log('Health check OK. Last run ' + Math.round(hoursSince * 10) / 10 + ' hours ago.');
  }
}
