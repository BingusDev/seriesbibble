# Series Bible (seriesbibble)

An application designed to help you keep your Series Bible organized when writing a screenplay: a web-based word processor for TV and film series bibles.

- **Sections**: every bible starts with **Characters** and **World**; add any others you need (Episodes, Themes, Tone & Style…). Rename, reorder or delete them from the section page.
- **Section templates**: when you add a section, pick a template (Episodes, Season Arcs, Themes, Timeline, Locations, Tone & Style, or Blank). Each new page starts with that template's headings, and a **Writing prompts** panel above the editor says what to put under each one. Prompts are never saved into the page, so they stay out of exports. Change a section's template from its section page. Templates live in `src/templates.js`.
- **Pages** inside each section. Drag pages in the sidebar to reorder them or move them between sections.
- **Navigation**: sidebar with collapsible, labeled sections and a filter box; breadcrumbs; an "On this page" outline; and **Jump to…** (Ctrl/Cmd+K) to search every section, page and heading.
- **Cross-reference links**: select text and press **§ Link** (Ctrl/Cmd+L) to link to any section, page, or heading on the same or another page. Clicking the link jumps straight there, and each page shows which pages link to it ("Linked from").
- **Relationship map**: connect characters with labeled relationships (sibling, mentor of, rival…), colored by kind and one-way or mutual. The map is an interactive graph: drag characters to arrange it, click one to open their page, click a line to edit it. Each character page lists its relationships in the right bar.
- **Export** to PDF and Word (.docx) with a title page and table of contents. Cross-reference links stay clickable in both. A JSON backup export is also available.
- **Accounts and sharing**: everyone signs in with a username and password. Each bible belongs to the person who made it; press **Share** to give other accounts edit access by username. Collaborators can edit, add and export; only the owner can share or delete the bible, and a collaborator can leave it from the home screen.
- **Working together**: you can see who else has a bible open and who is on the same page. Changes other people save show up within a few seconds. If two people edit the same page at once, the second save is refused instead of silently overwriting the first, and that person picks **Keep my version** or **Load their version**.
- Autosaves as you type. Everything is stored as JSON files in the data volume, with no external services.

## Run with Docker

```sh
docker compose up -d --build
```

Then open http://localhost:3000. Your bibles are stored in the `bible-data` volume, so they survive restarts and rebuilds.

Without Compose:

```sh
docker build -t series-bible .
docker run -d -p 3000:3000 -v series-bible-data:/data --name series-bible series-bible
```

To back up, either use **Export → Backup (.json)** per bible, or copy the volume: `docker run --rm -v series-bible_bible-data:/data -v "$PWD":/backup alpine tar czf /backup/bibles.tgz -C /data .`

## Accounts

The first time you open the app it asks you to create an account. Bibles that existed before accounts were added belong to that first account. After that, anyone who can reach the server can create an account from the sign-in screen, which is fine on a private network such as Tailscale. To turn that off, set `ALLOW_SIGNUP=false` and create accounts from the command line instead.

Accounts and sign-in sessions are stored in `users.json` and `sessions.json` in the data directory, next to the bibles. Passwords are hashed with scrypt. Account maintenance, for example when someone forgets their password:

```sh
docker compose exec series-bible node src/users-cli.js list
docker compose exec series-bible node src/users-cli.js add <username> <password>
docker compose exec series-bible node src/users-cli.js reset-password <username> <new password>
```

Behind a reverse proxy that terminates HTTPS (Caddy, nginx), the sign-in cookie is marked Secure when the proxy sends `X-Forwarded-Proto: https` and its address is listed in `TRUST_PROXY`.

## Run without Docker

Requires Node.js 20+.

```sh
npm install
npm start
```

PDF export needs Chromium or Chrome installed; set `CHROMIUM_PATH` if it is not in a standard location. Word export works without it.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` (`/data` in Docker) | Where bibles are stored |
| `CHROMIUM_PATH` | auto-detected | Browser used for PDF export |
| `TRUST_PROXY` | `loopback` | Reverse proxy addresses allowed to set `X-Forwarded-*` headers ([Express syntax](https://expressjs.com/en/guide/behind-proxies.html)), e.g. the Docker gateway `172.17.0.1` when Caddy runs on the host |
| `ALLOW_SIGNUP` | `true` | Set to `false` so only the first account can be created from the sign-in screen |

## Tests

```sh
npm test
```
