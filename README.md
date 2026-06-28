# Page search

A Safari userscript for the Scripting app that adds an in-page keyword search panel to every website.

## Features

- Floating search button on the current page
- Keyword highlighting across visible page text
- Previous / next match navigation
- Match count and result list for quick jumps
- Optional selected-text auto search
- Case-sensitive search toggle
- Regular expression search toggle
- Configurable panel position: top or bottom
- Settings saved per browser with `localStorage`

## Project files

- `browser.tsx` — Safari browser userscript implementation
- `script.json` — Scripting app project metadata
- `index.tsx` — app entry placeholder

## Usage

Import this project into the Scripting app and enable the browser script for Safari. After a page loads, tap the floating search button, enter a keyword, and use the navigation buttons or result list to jump between matches.

## Notes

The script is designed for Safari browser extension usage in Scripting and runs at `document-end` on all pages matched by `*://*/*`.
