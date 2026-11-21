# Local UI native-browser acceptance

Run the existing repository runner with one exact browser target:

```powershell
node scripts/node-foundation/build-scripts.cjs test.js tests/node/reports/local-ui-server-browser.test.ts
```

The test uses an already installed Chrome/Edge/Chromium executable. Set
`GARDA_BROWSER_EXECUTABLE` to a known local executable when it is outside the
documented standard locations in the test helper. It never installs a browser.
An unavailable browser is reported as a skipped case, which does not qualify
browser acceptance. The diagnostic identifies the actual browser product/user
agent, OS, Node version and ephemeral fixture origins; action tokens stay private.

A fresh fixture-owned profile and loopback DevTools transport drive real browser
requests with normal Origin, Fetch Metadata, CORS and sandbox enforcement. Only
the three local fixture origins are admitted by request interception. The test
checks canonical page/token, report, file preview and authorized action behavior,
invalid token denial, and hostile-origin GET/POST responses before workspace reads
or action execution. Server observations distinguish browser CORS refusal from
actual Garda rejection. Browser shutdown precedes fixture/profile removal.

`rebind.invalid` is statically mapped to loopback inside this browser process.
That proves rejection of a controlled foreign hostname, **not an actual DNS
answer transition**. T-206-1 retains the real DNS-rebinding acceptance obligation;
T-206 cannot close while that mandatory evidence remains unavailable. The owning
HTTP admission/network suites separately cover malformed/duplicate Host, wrong
port, null Origin, Fetch Metadata, unsafe URLs, traversal and token provenance.
