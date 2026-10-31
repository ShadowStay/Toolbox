# Iprix's Spells

```
app.py                 routes, page serving, home-page SEO (robots.txt, sitemap.xml), cookie options on <html>
auth.py                password gate (home page + its assets are public so Google can read them)
errors.py              Fail + JSON error handlers shared by every API blueprint
chat.py                shared room: chat, voice, presence (every connection has a public id and a private key)
board.py               the drawing board of the Live page (rides on chat.py)
storage.py             cloud storage (SQLite index + files on disk, chunked uploads)
set_password.py        python set_password.py
login.html
deploy-homeserver.sh   commit and push to GitHub
processing/            server-side processing, used when Options -> "On the server", and the tabletop API
  core.py  text.py  image.py  files.py
  roles.py  campaigns.py  characters.py  enemies.py  battlemap.py  rolls.py      (tabletop)
rules/                 classes.json, races.json, weapons.json for the character sheet
shared/
  site.css             base + tool pages + options dialog + rules shared by several pages
  site.js              options (cookies), sidebar, options dialog, Options.call/json/blob
  cloud-picker.js      "Open from cloud storage" button for pages with a file input
pages/                 one .html, .js and .css per page (served at /<name>; the .js and .css are attached automatically)
  index.*              home page (public, SEO)
  text-tools.*  image-tools.*  omni-file-viewer.*  calculator.*  cloud-storage.*  fortune-wheel.*
  live.*               room: drawing board, then chat / voice / screen sharing
  tabletop.*           role and campaign dialog, portrait helpers, dice, map (sidebar drawer, measuring), token window,
                       combat mode, Dungeon Master HQ tab and the character sheet, as numbered sections of one file
images/Iprix.png       (put your portrait here; also used as the social-sharing image)
```

Run: `pip install -r requirements.txt && python set_password.py && python app.py`

Options are cookies: `spells_motion` (on/off, default off), `spells_process` (browser/server, default browser) and `spells_nav` (open/closed, default closed: the sidebar is a narrow strip of icons that pops out after 0.75 s of hovering; clicking it opens it for good and the « button next to the title retracts it).

Set `SITE_URL=https://your-domain` so canonical links, the sitemap and social tags use the real address.
Behind a reverse proxy or tunnel also set `BEHIND_PROXY=1`, so the real client address (login lockout) and https (Secure cookies) are seen.
Dungeon master password: chosen by the first person who picks the role, or set `DM_PASSWORD` in the environment.
The tabletop dice log, chat, the drawing board and uploaded files for server processing live in memory: run a single process (threads are fine), not several workers.
Optional: LibreOffice on the PATH enables Word -> PDF on the server; `pillow-heif` adds HEIC.
