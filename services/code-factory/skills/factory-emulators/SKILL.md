---
name: factory-emulators
description: Validate Jarvis mobile and Wear OS app changes on the code host's Android and watch emulators during Code Factory tasks.
---

Enumerate devices through the configured mobile-mcp server or adb and select the phone for
apps/mobile, or the watch for apps/wear and apps/wear-factory. Preserve unrelated emulator
state. Use existing build/signing configuration and credentials without exposing them.

Build and install the changed app, then exercise the affected flow on the actual emulator.
Check navigation, visible state, relevant requests, failure behavior, and Android logs. A
successful build alone does not demonstrate that the requested interaction works. For Code
Factory, verify Sol starts selected, Terra/Sol/Astra can be chosen, tapping the current choice
keeps it selected, and creation sends the chosen model with the confirmed prompt.

If MCP is unavailable, use adb for installation, UI inspection, input, and logs. Use bounded
retries for device startup or connection failures. Complete checks that can run and accurately
report unavailable validation as a blocker; never ask for input during the unattended run.
