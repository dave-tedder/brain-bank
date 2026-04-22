# Voice Capture

Apple Shortcut triggered by Siri that dictates a thought and POSTs it to Brain Bank. Works on iPhone, iPad, Apple Watch, and Mac. Say a trigger phrase ("Hey Siri, brain thought"), speak the thought, and Siri transcribes and forwards it directly to Brain Bank over the REST API.

## What it does

- Listens for a custom Siri phrase you record once.
- Uses Apple's built-in Dictation to transcribe your voice to text.
- POSTs the text to Brain Bank's REST `/capture` endpoint with `"source": "voice"` so captures tag correctly in the database.
- Shows a silent notification on success (or an "I didn't hear anything" prompt if the dictation was empty).

## Why no script file ships here

Apple Shortcuts cannot be exported to a plain text file. The Shortcut is built interactively inside the Shortcuts app using the step-by-step walkthrough, then iCloud syncs it to your other Apple devices automatically. There is nothing to copy from the repo.

## Files

- This README.

The Shortcut definition itself is constructed on-device per the dummies guide.

## Setup

See [`docs/capture-sources/voice-capture.md`](../../docs/capture-sources/voice-capture.md) for the full walkthrough. The short version: build a six-action Shortcut (Dictate Text, If-has-value, Get Contents of URL, Show Notification, Otherwise branch, End If), record a Siri trigger phrase, test on-device.

## Good use cases

- Stray thoughts while driving or walking (Apple Watch or CarPlay).
- Voice memos you want transcribed and captured at the same time, no editing step.
- Capturing ideas quickly without picking up the phone or opening an app.
