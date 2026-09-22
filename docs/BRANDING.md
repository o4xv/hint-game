# Hint logo assets

The canonical artwork is client/public/assets/logo.png: a transparent 1254 by 1254 PNG.
The landing screen and offline screen display it as a non-interactive CSS background.
Do not replace it with an image containing a painted checkerboard.

Installed-app icons are exported from that artwork. Small browser icons use
client/public/assets/brand-mark.svg, a simplified dial without lettering:

- favicon-16-v4.png, favicon-32-v4.png, and favicon-48-v4.png: transparent dial icons.
- client/public/favicon.ico: the same three favicon sizes in one container.
- apple-touch-icon-v4.png: 180 by 180, opaque navy background for the iPhone Home Screen.
- icon-192-v4.png and icon-512-v4.png: regular installed-app icons on the same navy background.
- icon-maskable-512-v4.png: Android adaptive icon, with the full logo inside the circular safe area.

PNG derivatives live in client/public/assets. Regenerate them with:

    node scripts/generateBrandIcons.mjs

This uses the existing e2e Playwright dependency and its Chromium installation to resize the
master artwork. It does not call an image-generation API. The manifest, HTML icon links, and
service-worker precache list must agree when icon filenames change. Use a new filename version
when changing artwork so installed clients can fetch the new assets.

The older icon versions remain available for previously installed clients; current
HTML and the manifest reference v4. Installed Home Screen icon refresh timing is controlled by
the device, so deploying the new files does not guarantee an immediate launcher-icon change.
