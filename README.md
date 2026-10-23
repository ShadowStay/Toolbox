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
  roles.py  campaigns.py  characters.py  enemies.py  battlemap.py      (tabletop)
rules/                 classes.json, races.json, weapons.json for the character sheet
shared/
  site.css             base + tool pages + options dialog + rules shared by several pages
  site.js              options (cookies) + options dialog + sidebar + Options.call/json/blob
  role.js              "who are you, which campaign": player / dungeon master dialog and bar
  sheet-utils.js       portrait, JSON export and import, used by the character and enemy sheets
  cloud-picker.js      "Open from cloud storage" button for pages with a file input
pages/
  index.*              home page (public, SEO)
  text-tools.*  image-tools.*  omni-file-viewer.*  calculator.*  cloud-storage.*
  live.*  live-board.js        shared room with voice, screen sharing and a drawing board
  tabletop.*           character sheet and dice
  tabletop-map.*       the Map tab, and the switching between the tabs
  tabletop-dm.js       the Dungeon Master HQ tab (enemies, campaigns, DM password): shown to the dungeon master only
images/Iprix.png       (put your portrait here; also used as the social-sharing image)
```

Run: `pip install -r requirements.txt && python set_password.py && python app.py`

Options are cookies: `spells_motion` (on/off, default off) and `spells_process` (browser/server, default browser).

Set `SITE_URL=https://your-domain` so canonical links, the sitemap and social tags use the real address.
Behind a reverse proxy or tunnel also set `BEHIND_PROXY=1`, so the real client address (login lockout) and https (Secure cookies) are seen.
Dungeon master password: chosen by the first person who picks the role, or set `DM_PASSWORD` in the environment.
Chat, the drawing board and uploaded files for server processing live in memory: run a single process (threads are fine), not several workers.
Optional: LibreOffice on the PATH enables Word -> PDF on the server; `pillow-heif` adds HEIC.
