# The Guide (removed from the app, kept here)

Removed on 2026-10-04 at the user's request. Nothing was deleted: everything is in this folder.

The Guide was the **book button at the top right** of the header. It opened a full page that teaches every
part of the app (the big picture, inputs, filters, EQ, gate, compressor, de-esser, dynamic EQ, saturation,
auto-tune, buses, ducking, FX, master, loudness, scenes, automation, chains, carrying mixes, remote...),
with worship and preaching recipes. The small **"?" buttons** on editor panels opened it at the right topic.

## Files here
- `guide.js`: all the Guide text and the page code (defines `window.openGuide(topic)`)
- `guide.css`: its styles

## To add it back
1. Move `guide.js` back to `web/guide.js`.
2. Paste `guide.css` into `web/style.css` (just before `/* master additions */`). The last rule belongs inside the
   existing `@media (max-width: 760px)` block, but it works where it is too.
3. In `web/index.html`:
   - in the header buttons, next to the other `hbtn` buttons:
     `<button class="hbtn" id="btnGuide" title="Guide: what everything does" data-ic="book"></button>`
   - with the other views (after the ROUTING section):
     ```html
     <!-- ======================= GUIDE ======================= -->
     <section id="view-guide" class="view">
       <div class="guide" id="guide"></div>
     </section>
     ```
   - with the other scripts (after the others): `<script src="/static/guide.js"></script>`
4. In `web/app.js`, with the other header button handlers:
   `$('#btnGuide').onclick = () => showView(S.view === 'guide' ? 'mixer' : 'guide');`
5. The "?" help buttons in `web/mixer.js` come back on their own: they appear whenever `window.openGuide` exists.
6. Optionally add back to README.md under the features list:
   `- **Guide** (book icon, top right): what every control does, plus worship and preaching recipes.`

Or just ask Claude: "add the Guide back" (it will follow this file).
