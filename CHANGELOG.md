# Changelog

Newest first. TrackPilot is an unofficial side panel for Bandcamp.

## 0.9.78 – 2026-10-31
- The log section and "Copy log" button are removed from the settings.

## 0.9.77 – 2026-10-30
- Extension name, description and toolbar texts are localized (English, German, French, Spanish, Italian).
- New description: "Unofficial Bandcamp side panel …".
- README, privacy notice, license and changelog added for the GitHub release.
- Code cleanup: removed unused translation rows, unused styles and personal notes in comments. No change in behaviour.

## 0.9.60 – 0.9.76
- **0.9.76** – BPM shows only the detected value; the ×2/÷2 menu is gone.
- **0.9.75** – Side panel only, no separate window any more (Opera: hint on how to pin TrackPilot to the sidebar). BPM cache keyed by track ID, so the feed and collection pages no longer show the same value everywhere.
- **0.9.74** – Settings cleanup.
- **0.9.73** – Opera: try the sidebar first, separate window only as a fallback.
- **0.9.72** – Tempo control removed from the player bar; search progress shown above the list; window docking (removed again in 0.9.75).
- **0.9.71** – Opera: always open as a separate window (Opera reports a side panel API but shows nothing).
- **0.9.70** – Fixed player bar on Bandcamp pages with waveform and BPM.
- **0.9.69** – Runs in Opera (sidebar or separate window).
- **0.9.68** – Fresh-start experience for new users: welcome screen, "Copy log" for bug reports.
- **0.9.67** – Settings cleanup.
- **0.9.66** – Global genre filter in the settings; fine-grained sliders directly above each list; purchase lists of the best 300 soulmates are kept. Pre-orders no longer appear twice in a promo row.
- **0.9.65** – "Who bought this?" for promos and followed tracks; unfollowing takes effect immediately.
- **0.9.64** – Followed fans are read from Bandcamp's own follow list.
- **0.9.63** – Follow button detected by its visible text; profile diagnostics in the log.
- **0.9.62** – Follows seen on profile pages are remembered.
- **0.9.61** – Followed fans are always marked (case-insensitive, list re-fetched).
- **0.9.60** – The best 300 soulmates vote on track picks; "minimum fans per track" slider, also for Following; all followed fans are read; known artists are recognised; the playing track stays in the list; more room for taste signals.

## Before 0.9.60
- **0.9.55 – 0.9.59** – Rarity and variety in track picks with a "why" line; Following sorted by closeness; TrackPilot learns your taste from ♥ and hide; slider for shared releases; early stop and rare candidates first to save requests; new **Promos** tab (pre-orders and new releases from your people); lists stay in place while you listen, played tracks are marked.
- **0.9.48 – 0.9.54** – Tabs *Current track*, *For you* and *Following*; switch between fans and their tracks; continuous search for soulmates; self-learning request budget so Bandcamp's rate limit is respected; extended log.
- **0.9.40 – 0.9.47** – Built-in player with waveform, play history, hidden-tracks window, "new" markers for freshly found fans, first soulmate search across your whole collection, automatic resume after Bandcamp throttling.
- **Up to 0.9.39** – First versions: fan suggestions for the open release ranked by shared releases and how early fans bought them, track suggestions from those fans, tag filters, dark mode.
