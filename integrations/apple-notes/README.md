# Apple Notes Bridge

Apple Shortcut that captures notes from a designated "Brain Capture" folder into Brain Bank and moves them to an archive folder on success. Runs on your schedule or on demand from any Apple device signed into the same iCloud account.

## What it does

- Scans a Notes folder named `Brain Capture` for any note with text content.
- POSTs each note to Brain Bank's REST `/capture` endpoint with `"source": "apple-notes"` so captures tag correctly in the database.
- Moves successful captures to a `Brain Archived` folder (local backup that you can delete any time).
- Skips duplicates without moving them, so a double-run is safe.

## Why no script file ships here

Apple Shortcuts cannot be exported to a plain text file the way Google Apps Script can. The Shortcut is built interactively inside the Shortcuts app on your device using the step-by-step walkthrough. Once built, it lives on your device and syncs through iCloud to your other Apple devices automatically.

## Files

- This README.

The Shortcut definition itself is constructed on-device per the dummies guide. There is no artifact to copy from the repo.

## Setup

See [`docs/capture-sources/apple-notes.md`](../../docs/capture-sources/apple-notes.md) for the full walkthrough. The short version: create two Notes folders (`Brain Capture`, `Brain Archived`), build a Shortcut with the eight actions described in the guide, wire it to an optional daily automation, and drop notes in the capture folder from any Apple device.

## Good use cases

- Quick thoughts dictated to Notes via Siri that you want in Brain Bank later.
- Reference material you save on your phone.
- Capturing ideas when you do not have Slack, ChatGPT, or the dashboard open.
