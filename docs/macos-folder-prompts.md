# Why macOS asks for folders, and how to make it ask once

## Why it asks

Every agent runs as a child of agent-board. When an agent runs something like `find ~` or reads a file in Downloads,
macOS asks on agent-board's behalf: "agent-board would like to access files in your Downloads folder", or Desktop,
Documents, Photos, or other apps' data.

macOS remembers your answer against the app's signature. A build that isn't signed with a certificate is signed
*ad hoc*, and macOS ties an ad hoc app's answers to that exact build. So with an ad hoc build, every update
(`pnpm update:app` or `pnpm package`) is a new app to macOS, and it asks again.

## Make it ask once: `pnpm signing:setup`

Run this once on each Mac:

```sh
pnpm signing:setup
```

It makes a self-signed code-signing certificate called **agent-board local signing** in your login keychain. It is
only for signing your own builds on this Mac: it isn't trusted by anything, and it doesn't need to be. At the end it
signs a scratch file to try the certificate. If macOS asks whether `codesign` may use the key, type your login
password and choose **Always Allow**, so builds don't stop to ask.

From then on `pnpm package`, and so `pnpm update:app`, sign the app with that certificate. The
build prints the app's *designated requirement*, the rule macOS checks a later build against. It names the app's
bundle id and the certificate, so it is the same for every build:

```text
package: signed with "agent-board local signing": identifier "io.github.garethca.agent-board" and certificate leaf = H"…"
```

To check an installed app: `codesign -d -r- ~/Applications/agent-board.app`.

macOS asks once more for each folder after the first signed install, because the app's signature changed. After that,
your answers carry over across updates.

Without the certificate, the build stays ad hoc signed, works as before, and prints one line saying how to set it up.
Other Macs and Linux builds need nothing.

## Your answers

- **Don't Allow is fine.** The agent gets an error for that folder and carries on. With the certificate set up, the
  answer stays answered after the next update.
- **To change an answer later**, open System Settings, then Privacy & Security, then Files and Folders (or Photos, or
  App Management), and switch agent-board on or off.
- **Full Disk Access is your choice.** agent-board doesn't ask for it. Granting it in Privacy & Security, then Full
  Disk Access, stops the folder questions entirely, and lets every agent read everything your user account can.

## Details

- The signature has no hardened runtime, the same as the ad hoc one, so node-pty and the agents' own CLIs run as
  before. It is signed after electron-builder sets the Electron fuses, so the fuses are part of what is signed.
- **What the certificate lets other programs do.** After Always Allow, any program running as you can sign with it
  without asking. A program it signs as agent-board (the same bundle id) meets the same requirement, so it gets the
  folder answers you gave agent-board. Under ad hoc signing those answers belonged to one build. This is the same
  trade-off as any developer certificate on your Mac. Agents already have these answers, as part of the app. To undo
  it, delete the certificate (below).
- If the keychain holds more than one **agent-board local signing** certificate, the build stays ad hoc and says so,
  since each would sign with a different requirement. Delete all but one in Keychain Access.
- To remove it: delete **agent-board local signing** (the certificate and its private key) in Keychain Access. The
  next build is ad hoc again.
