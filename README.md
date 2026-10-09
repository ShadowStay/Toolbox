# Iprix's Spells

```
app.py                 routes, page serving, home-page SEO (robots.txt, sitemap.xml), cookie options on <html>
auth.py                password gate (home page + its assets are public so Google can read them)
chat.py                shared chat / voice room (unchanged)
set_password.py        python set_password.py
login.html
processing/            server-side processing, used when Options -> "On the server"
  core.py  text.py  image.py  files.py
shared/
  site.css             base + tool pages + options dialog (was base.css, tools.css, options.css)
  site.js              options (cookies) + options dialog + sidebar + Options.call/json/blob (was options.js, navigation.js)
pages/
  index.{html,css,js}  home page (public, SEO)
  text-tools.*  image-tools.*  omni-file-viewer.*
  live/chat.*
images/Iprix.png       (put your portrait here; also used as the social-sharing image)
```

Run: `pip install -r requirements.txt && python set_password.py && python app.py`

Options are cookies: `spells_motion` (on/off, default off) and `spells_process` (browser/server, default browser).

Set `SITE_URL=https://your-domain` so canonical links, the sitemap and social tags use the real address.
Server-processing state (uploaded files, chat) lives in memory: run a single process (threads are fine), not several workers.
Optional: LibreOffice on the PATH enables Word -> PDF on the server; `pillow-heif` adds HEIC.
