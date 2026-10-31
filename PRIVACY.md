# TrackPilot – Privacy

**English** · [Deutsch](#deutsch)

Last updated: 2026-10-30

TrackPilot is a browser extension that runs entirely in your browser. It has no server, no account and no analytics.

## What TrackPilot reads from Bandcamp

TrackPilot only talks to Bandcamp (`bandcamp.com`, `*.bandcamp.com`) and Bandcamp's media servers (`*.bcbits.com`). It reads:

- **your own data:** your collection, your wishlist and the fans you follow (you are logged in to Bandcamp in the same browser);
- **public data of other fans:** public collections and the buyer lists ("supported by") shown on release pages;
- **release pages:** title, artist, tags, release date, pre-order status;
- **preview streams:** the same audio previews Bandcamp plays, to draw the waveform and estimate the BPM.

TrackPilot only changes something on your Bandcamp account when you ask it to: ♥ puts a track on your wishlist or removes it. For this it may briefly open the track page in a background tab and click Bandcamp's own wishlist button there.

## Where the data is stored

Everything TrackPilot reads or learns (fan profiles, suggestions, your settings, play history, hidden tracks) is stored only in your browser, in `chrome.storage.local`.

Nothing is sent to the author or to any third party. There is no analytics, no tracking and no advertising. The only network requests go to Bandcamp, as described above.

TrackPilot keeps no visible log. Internal status messages exist only in memory while the panel is open and are discarded when it closes.

## How to delete your data

- **Settings → Delete everything** removes your data (only the learned Bandcamp request rate is kept, so the rate limit stays respected), or
- remove the extension in `chrome://extensions` (Opera: `opera://extensions`); the browser then deletes all of its data.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Save your settings, suggestions and fan profiles locally. |
| `unlimitedStorage` | Fan profiles can exceed the default storage quota; still only stored locally. |
| `sidePanel` | Show TrackPilot in Chrome's side panel. |
| Host access `bandcamp.com`, `*.bandcamp.com` | Read your collection, public fan collections and release pages; show the player bar on Bandcamp pages. |
| Host access `*.bcbits.com` | Load cover images and audio previews for the waveform and BPM. |

## Contact

Questions: please open an issue on GitHub.

---

<a id="deutsch"></a>

# TrackPilot – Datenschutz

[English](#trackpilot--privacy) · **Deutsch**

Stand: 30.10.2026

TrackPilot ist eine Browser-Erweiterung, die vollständig in deinem Browser läuft. Es gibt keinen Server, kein Konto und keine Analyse.

## Was TrackPilot von Bandcamp liest

TrackPilot spricht nur mit Bandcamp (`bandcamp.com`, `*.bandcamp.com`) und Bandcamps Medienservern (`*.bcbits.com`). Es liest:

- **deine eigenen Daten:** deine Sammlung, deine Wishlist und die Fans, denen du folgst (du bist im selben Browser bei Bandcamp angemeldet);
- **öffentliche Daten anderer Fans:** öffentliche Sammlungen und die Käuferlisten („supported by“) auf Release-Seiten;
- **Release-Seiten:** Titel, Künstler, Tags, Erscheinungsdatum, Pre-Order-Status;
- **Hörproben:** dieselben Vorschau-Streams, die Bandcamp abspielt, um die Wellenform zu zeichnen und die BPM zu schätzen.

An deinem Bandcamp-Konto ändert TrackPilot nur etwas, wenn du es willst: ♥ setzt einen Track auf deine Wishlist oder nimmt ihn herunter. Dafür öffnet es die Track-Seite eventuell kurz in einem Hintergrund-Tab und klickt dort Bandcamps eigenen Wishlist-Knopf.

## Wo die Daten liegen

Alles, was TrackPilot liest oder lernt (Fan-Profile, Vorschläge, deine Einstellungen, Wiedergabeverlauf, ausgeblendete Lieder), liegt nur in deinem Browser, in `chrome.storage.local`.

Nichts wird an den Autor oder an Dritte geschickt. Es gibt keine Analyse, kein Tracking und keine Werbung. Die einzigen Netzwerkanfragen gehen wie oben beschrieben an Bandcamp.

TrackPilot zeigt kein Protokoll an. Interne Statusmeldungen gibt es nur im Arbeitsspeicher, solange die Leiste offen ist; beim Schließen sind sie weg.

## Daten löschen

- **Einstellungen → Alles löschen** entfernt deine Daten (nur das gelernte Anfragetempo für Bandcamp bleibt, damit das Limit weiter eingehalten wird), oder
- die Erweiterung unter `chrome://extensions` (Opera: `opera://extensions`) entfernen; der Browser löscht dann alle ihre Daten.

## Berechtigungen

| Berechtigung | Wofür |
| --- | --- |
| `storage` | Einstellungen, Vorschläge und Fan-Profile lokal speichern. |
| `unlimitedStorage` | Fan-Profile können das normale Speicherlimit überschreiten; trotzdem nur lokal. |
| `sidePanel` | TrackPilot in Chromes Seitenleiste anzeigen. |
| Zugriff auf `bandcamp.com`, `*.bandcamp.com` | Deine Sammlung, öffentliche Fan-Sammlungen und Release-Seiten lesen; Player-Leiste auf Bandcamp-Seiten zeigen. |
| Zugriff auf `*.bcbits.com` | Cover und Hörproben für Wellenform und BPM laden. |

## Kontakt

Fragen bitte als Issue auf GitHub.
